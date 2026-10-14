import { ChildProcess, spawn } from 'child_process';
import { run } from '../../core/exec';
import { trackCapture } from '../logs';
import { Target } from './device';

/**
 * A phone's live log drops lines when it is busy, and nothing is busier than a launch. A tap
 * on a push sent to a killed app starts a new process, and the app handles the tap about 60ms
 * in, inside the burst the stream drops. A stream that the phone filters to one pid does not
 * drop, but a process has no pid until it exists.
 *
 * So the launch is held, the way Xcode's "Wait for the executable to be launched" catches an
 * app opened from a push: Xcode's debugger waits for the process to appear and stops it at
 * once. On an iPhone 15 it stopped inside dyld, before any app code, every time — four
 * launches, one of them a real tap on the home screen — which leaves time to open a stream
 * for that pid and then let the app go.
 *
 * Waiting on the app's full path, which is how Xcode asks the system to halt the next launch,
 * is refused by the phone's debug server (`E96 attach failed`) before anything launches.
 * Waiting on the process name works: the debug server watches the process list instead.
 *
 * The debugger is driven from Python because its attach does not block, even in batch mode,
 * and a debugger command that polls never sees the attach finish. Both the Python and the
 * debugger's module come with Xcode, so there is nothing to install.
 */
export interface HeldLaunch {
  pid: number;
  /** Where the debugger stopped it, e.g. `__mmap in dyld`. */
  stoppedIn?: string;
}

export interface LaunchHold {
  /** Settles once the process is stopped, or with undefined when it never is. */
  held: Promise<HeldLaunch | undefined>;
  /** Whether a launch is being waited for, is stopped, or is over. */
  state(): 'waiting' | 'held' | 'done';
  /**
   * Let a held process run, or stop waiting for one. Safe to call more than once. Says
   * whether the app was let go only because the hold ran out of time.
   */
  release(): Promise<{ timedOut?: boolean; error?: string } | undefined>;
}

export type ArmedHold =
  | { hold: LaunchHold; unavailableReason?: undefined }
  | { hold?: undefined; unavailableReason: string };

export type HoldEvent =
  | { event: 'armed' }
  | { event: 'held'; pid: number; frame?: string; module?: string }
  | {
      event: 'released';
      held: boolean;
      timedOut?: boolean;
      error?: string | null;
    }
  | { event: 'error'; message: string };

/** How long the debugger gets to reach the phone and start waiting. */
const ARM_TIMEOUT_MS = 30_000;
/**
 * The longest the app is ever kept stopped, whatever happens to the tool. The stream for its
 * pid takes about a second to open; past this, the app is let go and its lines may be lost.
 */
export const MAX_HOLD_MS = 10_000;
const EXIT_TIMEOUT_MS = 5_000;

/**
 * The debugger side. It answers on stdout, one JSON object a line, and takes `release` on
 * stdin; a closed stdin also releases, so a tool that dies cannot leave the app stopped. A
 * debugger that loses its connection detaches too (`QSetDetachOnError:1`).
 */
const HELPER = String.raw`
import json, os, sys, threading
import lldb

udid, name, max_hold = sys.argv[1], sys.argv[2], float(sys.argv[3])

def say(**fields):
    sys.stdout.write(json.dumps(fields) + "\n")
    sys.stdout.flush()

debugger = lldb.SBDebugger.Create()
debugger.SetAsync(True)
interpreter = debugger.GetCommandInterpreter()

# "device select" answers eReturnStatusStarted, which Succeeded() counts as a failure; a
# real one is eReturnStatusFailed, with a message ("The specified device was not found").
def command(text):
    result = lldb.SBCommandReturnObject()
    interpreter.HandleCommand(text, result)
    return result.GetStatus() != lldb.eReturnStatusFailed, (result.GetError() or "").strip()

def finish(code):
    lldb.SBDebugger.Destroy(debugger)
    os._exit(code)

ok, error = command("device select " + udid)
if not ok:
    say(event="error", message=error or "the debugger could not select the device")
    finish(1)
quoted = name.replace("\\", "\\\\").replace('"', '\\"')
ok, error = command('device process attach -n "' + quoted + '" -w')
if not ok:
    say(event="error", message=error or "the debugger could not wait for the app")
    finish(1)

released = threading.Event()
def read_stdin():
    for line in sys.stdin:
        if line.strip() == "release":
            break
    released.set()
threading.Thread(target=read_stdin, daemon=True).start()
say(event="armed")

listener = debugger.GetListener()
event = lldb.SBEvent()
process = None
while not released.is_set():
    if not listener.WaitForEvent(1, event):
        continue
    if not lldb.SBProcess.EventIsProcessEvent(event):
        continue
    state = lldb.SBProcess.GetStateFromEvent(event)
    if state == lldb.eStateStopped:
        process = lldb.SBProcess.GetProcessFromEvent(event)
        break
    if state in (lldb.eStateExited, lldb.eStateDetached, lldb.eStateCrashed):
        description = lldb.SBProcess.GetProcessFromEvent(event).GetExitDescription()
        say(event="error", message=description or "the debugger stopped waiting")
        finish(1)

if process is None:
    say(event="released", held=False)
    finish(0)

frame = process.GetThreadAtIndex(0).GetFrameAtIndex(0)
say(event="held", pid=process.GetProcessID(), frame=frame.GetFunctionName() or "",
    module=frame.GetModule().GetFileSpec().GetFilename() or "")
released.wait(max_hold)
detached = process.Detach()
say(event="released", held=True, timedOut=not released.is_set(),
    error=None if detached.Success() else detached.GetCString())
finish(0)
`;

export function parseHoldEvent(line: string): HoldEvent | undefined {
  try {
    const parsed = JSON.parse(line) as HoldEvent;
    return parsed && typeof parsed.event === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export interface HoldDependencies {
  /** The path `xcrun lldb -P` prints: where the debugger's Python module lives. */
  pythonPath?: () => Promise<string | undefined>;
  spawnHelper?: (args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
}

/**
 * Start waiting for the next launch of `processName` on a phone. Resolves once the debugger
 * is waiting, so the person is only asked to tap when a tap will be caught.
 */
export async function armLaunchHold(
  target: Target,
  processName: string,
  dependencies: HoldDependencies = {}
): Promise<ArmedHold> {
  if (target.kind !== 'device') {
    return { unavailableReason: "a simulator's log does not drop a launch" };
  }
  const pythonPath = await (dependencies.pythonPath ?? lldbPythonPath)();
  if (!pythonPath) {
    return {
      unavailableReason:
        "Xcode's debugger has no Python module here (`xcrun lldb -P` failed)",
    };
  }
  const args = [target.udid, processName, String(MAX_HOLD_MS / 1000)];
  const env = { ...process.env, PYTHONPATH: pythonPath };
  const child = (dependencies.spawnHelper ?? spawnHelper)(args, env);
  trackCapture(child);
  child.stdin?.on('error', () => undefined);

  let state: 'waiting' | 'held' | 'done' = 'waiting';
  let lastError: string | undefined;
  let stderr = '';
  let settleArmed: (reason: string | undefined) => void = () => undefined;
  let settleHeld: (launch: HeldLaunch | undefined) => void = () => undefined;
  let settleReleased: (
    result: { timedOut?: boolean; error?: string } | undefined
  ) => void = () => undefined;
  const armed = new Promise<string | undefined>((resolve) => {
    settleArmed = resolve;
  });
  const held = new Promise<HeldLaunch | undefined>((resolve) => {
    settleHeld = resolve;
  });
  const released = new Promise<
    { timedOut?: boolean; error?: string } | undefined
  >((resolve) => {
    settleReleased = resolve;
  });

  const handle = (event: HoldEvent) => {
    if (event.event === 'armed') settleArmed(undefined);
    if (event.event === 'held') {
      state = 'held';
      settleHeld({
        pid: event.pid,
        stoppedIn: [event.frame, event.module].filter(Boolean).join(' in '),
      });
    }
    if (event.event === 'released') {
      state = 'done';
      settleHeld(undefined);
      settleReleased({
        timedOut: event.timedOut || undefined,
        error: event.error ?? undefined,
      });
    }
    if (event.event === 'error') {
      lastError = event.message;
      settleArmed(event.message);
    }
  };

  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const event = parseHoldEvent(part);
      if (event) handle(event);
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const ended = (why?: string) => {
    state = 'done';
    settleArmed(
      lastError ??
        why ??
        (stderr.trim().split('\n').pop() || 'the debugger exited')
    );
    settleHeld(undefined);
    settleReleased(undefined);
  };
  child.on('exit', () => ended());
  child.on('error', (error) => ended(error.message));

  const timer = setTimeout(
    () =>
      settleArmed(`the debugger was not ready after ${ARM_TIMEOUT_MS / 1000}s`),
    ARM_TIMEOUT_MS
  );
  const unavailable = await armed;
  clearTimeout(timer);
  if (unavailable !== undefined) {
    child.kill();
    return {
      unavailableReason: `Xcode's debugger could not wait for the app: ${unavailable}`,
    };
  }

  let releasing:
    | Promise<{ timedOut?: boolean; error?: string } | undefined>
    | undefined;
  const release = () => {
    releasing ??= (async () => {
      if (child.exitCode === null && child.stdin && !child.stdin.destroyed) {
        child.stdin.write('release\n');
        child.stdin.end();
      }
      let timeout: NodeJS.Timeout | undefined;
      const result = await Promise.race([
        released,
        new Promise<'timeout'>((resolve) => {
          timeout = setTimeout(() => resolve('timeout'), EXIT_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timeout);
      if (result === 'timeout') {
        child.kill();
        return undefined;
      }
      return result;
    })();
    return releasing;
  };

  return { hold: { held, state: () => state, release } };
}

async function lldbPythonPath(): Promise<string | undefined> {
  const { stdout, code } = await run('xcrun', ['lldb', '-P'], 20_000);
  const found = stdout.trim().split('\n').pop()?.trim();
  return code === 0 && found ? found : undefined;
}

function spawnHelper(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn('xcrun', ['python3', '-u', '-c', HELPER, ...args], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
