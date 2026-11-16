import { run } from '../../core/exec';
import { FollowedStream, LogCapture } from '../logs';
import { Target } from './device';

/**
 * A phone's live log drops lines when it is busy, and nothing is busier than a launch: a tap
 * on a push sent to a killed app starts a new process, and the app handles the tap about 60ms
 * in, inside the burst the stream drops. A stream the phone filters to one pid does not drop,
 * and it can be opened before the pid is in use: it then reads that process from its first
 * line. The relay filters by pid and nothing else, so there is no steadier handle to use.
 *
 * So the next pids are watched before the tap. XNU hands them out in order (`++pid`,
 * skipping any in use), and one app launch took the next one or two, so a window of the next
 * eight, moved along as other processes start, is where the app lands. Nothing waits or
 * polls on the phone: an earlier version held the launch with Xcode's debugger, whose wait
 * re-reads the process list every millisecond and left the phone too slow to tap.
 *
 * A stream whose pid goes to someone else's process has its lines dropped unread. If the
 * app lands outside the window anyway, the outcome says so and nothing is claimed.
 */
export const WINDOW_SIZE = 8;
/** How often the window is moved along. Each read of the process list takes about 110ms. */
const REFRESH_MS = 2_000;

export interface CaughtLaunch {
  pid: number;
  /** Which of the window's pids it was, 1 being the next one at the time. */
  slot: number;
  /** The stream reached the phone before the process existed, so it has its first line. */
  fromFirstLine: boolean;
  how: string;
}

export interface WindowOutcome {
  caught?: CaughtLaunch;
  /** The app launched as a pid the window did not cover. */
  missed?: { pid: number; from: number; to: number };
  /** Why the window stopped watching early, if it did. */
  reason?: string;
}

export interface PidWindow {
  /** Stop watching and say where the app landed. The app's own stream stays open. */
  stop(): Promise<WindowOutcome>;
}

export interface WindowDependencies {
  /** Pid to process name, for every process on the phone, or undefined when unreadable. */
  pidList?: (udid: string) => Promise<Map<number, string> | undefined>;
  refreshMs?: number;
  now?: () => number;
}

interface Read {
  startedAt: number;
  pids: Map<number, string>;
}

/**
 * Start watching the next pids for `app`. Resolves once the streams are connected, so the
 * person is only asked to tap when a launch will be caught.
 */
export async function openPidWindow(
  target: Target,
  capture: LogCapture,
  app: string,
  dependencies: WindowDependencies = {}
): Promise<{ window?: PidWindow; unavailableReason?: string }> {
  const follow = capture.followProcess;
  if (target.kind !== 'device' || !follow) {
    return { unavailableReason: "only a phone's log drops a launch" };
  }
  const pidList = dependencies.pidList ?? readPidList;
  const now = dependencies.now ?? Date.now;
  const refreshMs = dependencies.refreshMs ?? REFRESH_MS;

  const read = async (): Promise<Read | undefined> => {
    const startedAt = now();
    const pids = await pidList(target.udid);
    return pids && { startedAt, pids };
  };
  const first = await read();
  if (!first) {
    return {
      unavailableReason:
        "the phone's process list could not be read (`idevicesyslog pidlist`)",
    };
  }

  const before = new Set(
    [...first.pids].filter(([, name]) => isApp(name, app)).map(([pid]) => pid)
  );
  const slots = new Map<number, FollowedStream>();
  const highest = (pids: Map<number, string>) => Math.max(0, ...pids.keys());
  let last = first;
  let windowFrom = highest(first.pids) + 1;
  const outcome: WindowOutcome = {};

  const fill = async (from: number) => {
    windowFrom = from;
    const opened: FollowedStream[] = [];
    for (let pid = from; pid < from + WINDOW_SIZE; pid++) {
      if (slots.has(pid)) continue;
      const stream = follow(pid, [app]);
      slots.set(pid, stream);
      opened.push(stream);
    }
    await Promise.all(opened.map((stream) => stream.connected));
  };

  /** Read the process list once, and either find the app or move the window along. */
  const step = async (slide = true): Promise<boolean> => {
    const current = await read();
    if (!current) {
      outcome.reason = "the phone's process list stopped answering";
      return true;
    }
    const launched = [...current.pids]
      .filter(([pid, name]) => isApp(name, app) && !before.has(pid))
      .map(([pid]) => pid)
      .sort((a, b) => a - b)[0];
    if (launched !== undefined) {
      const stream = slots.get(launched);
      if (stream) {
        const connectedAt = stream.connectedAt();
        outcome.caught = {
          pid: launched,
          slot: launched - windowFrom + 1,
          // Connected before a read that did not list the pid: the process did not exist yet.
          fromFirstLine:
            connectedAt !== undefined && connectedAt <= last.startedAt,
          how: stream.how,
        };
      } else {
        outcome.missed = {
          pid: launched,
          from: windowFrom,
          to: windowFrom + WINDOW_SIZE - 1,
        };
      }
      return true;
    }
    // Pids now in use by someone else, or passed over, are no longer worth watching.
    const top = highest(current.pids);
    for (const [pid, stream] of slots) {
      if (pid <= top || stream.foreign()) {
        stream.stop();
        slots.delete(pid);
      }
    }
    last = current;
    if (slide) await fill(top + 1);
    return false;
  };

  await fill(windowFrom);
  // The streams are now reading. A read from here on that does not list the app is the
  // proof a later launch was read from its first line.
  if (await step()) {
    // The app started on its own before anyone was asked to tap; that launch is not a tap's.
    before.add(outcome.caught?.pid ?? outcome.missed?.pid ?? -1);
    delete outcome.caught;
    delete outcome.missed;
    if (outcome.reason) return { unavailableReason: outcome.reason };
  }

  let stopped = false;
  let wake: () => void = () => undefined;
  let timer: NodeJS.Timeout | undefined;
  const loop = (async () => {
    while (!stopped) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, refreshMs);
      });
      if (stopped) return;
      if (await step()) return;
    }
  })();

  return {
    window: {
      stop: async () => {
        stopped = true;
        clearTimeout(timer);
        wake();
        await loop;
        // The tap usually lands between two reads, so one more says where the app went.
        if (!outcome.caught && !outcome.missed && !outcome.reason) {
          await step(false);
        }
        for (const [pid, stream] of slots) {
          if (pid !== outcome.caught?.pid) stream.stop();
        }
        return outcome;
      },
    },
  };
}

/** The process list may cut a long name short. */
function isApp(name: string, app: string): boolean {
  return name === app || (name.length >= 15 && app.startsWith(name));
}

/** `idevicesyslog pidlist` prints `<pid> <name>` per process. */
export async function readPidList(
  udid: string
): Promise<Map<number, string> | undefined> {
  const { stdout, code } = await run(
    'idevicesyslog',
    ['-u', udid, 'pidlist'],
    15_000
  );
  return code === 0 ? parsePidList(stdout) : undefined;
}

export function parsePidList(output: string): Map<number, string> | undefined {
  const pids = new Map<number, string>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) pids.set(Number(match[1]), match[2]);
  }
  return pids.size > 0 ? pids : undefined;
}
