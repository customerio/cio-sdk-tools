import { ChildProcess, spawn } from 'child_process';
import { createWriteStream, WriteStream } from 'fs';
import { promises as fs } from 'fs';
import * as path from 'path';
import { isCommandAvailable, run } from '../exec';
import { Target } from '../ios/device';
import { MatrixCell } from '../types';

export interface LogLine {
  /** Wall clock as the log reports it, trimmed to a readable time. */
  at: string;
  process: string;
  message: string;
}

export interface LogCapture {
  available: boolean;
  /** Why no log is being captured, ready to print as a skip reason. */
  unavailableReason?: string;
  /** How the lines are being read, for the report's evidence. */
  how?: string;
  lines: LogLine[];
  /**
   * A point in the stream, as an absolute count of lines ever seen.
   *
   * Never use `lines.length` for this. The retained window drops the oldest lines when it
   * overflows, which silently shifts every saved index — a cell on a physical Android
   * device read the wrong slice of its own capture and reported a tap it had recorded as
   * never seen. `mark()` and `since()` account for what was dropped.
   */
  mark(): number;
  since(mark: number): LogLine[];
  /** File the lines are appended to as they arrive. */
  evidencePath?: string;
  stop(): Promise<void>;
  /**
   * Why the capture stopped delivering partway through the run, if it did: its reader
   * exited after it had started. A cell judged after that has nothing to read, which is
   * not the same as the app having said nothing.
   */
  stoppedReason?(): string | undefined;
  /**
   * The stream can drop lines, so a line that is missing proves nothing. A phone's log
   * through `idevicesyslog` is: during a cold launch it lost the SDK's lines for seven taps
   * the app's own record shows were all handled. `simctl log stream` and `adb logcat` have
   * not been seen to drop anything.
   */
  lossy?: boolean;
}

/**
 * A cell that "saw nothing" after the capture stopped saw nothing because nothing was
 * being read. It is re-judged as the capture's problem, so the person is not blamed for a
 * tap they made or the app for a delivery it reported.
 */
export function blameStoppedCapture(
  cell: MatrixCell,
  stoppedReason: string | undefined,
  silentCauses: string[]
): MatrixCell {
  if (!stoppedReason || !cell.cause || !silentCauses.includes(cell.cause)) {
    return cell;
  }
  return {
    ...cell,
    verdict: 'skip',
    cause: 'runtime.capture_stopped',
    summary: undefined,
    evidence: [...cell.evidence, `${stoppedReason} (was: ${cell.cause})`],
  };
}

/**
 * The SDK's subsystem, plus the extension's process by name: a line from that process is the
 * OS's word that the extension ran, whether or not the SDK logs anything. Extensions are
 * usually called NotificationService-something, which the substring keeps covering when the
 * project does not say.
 */
export function simulatorPredicate(extensionName?: string): string {
  const named =
    extensionName && !extensionName.includes('NotificationService')
      ? ` OR process == "${extensionName.replace(/["\\]/g, '')}"`
      : '';
  return `subsystem == "io.customer.sdk" OR processImagePath CONTAINS "NotificationService"${named}`;
}

const NOT_CAPTURING: LogCapture = {
  available: false,
  lines: [],
  mark: () => 0,
  since: () => [],
  stop: async () => undefined,
};

/**
 * The device logs are the only proof that the extension counted a delivery — the server's
 * own `delivered` is provider acceptance, stamped at send time, and reads 1 even when the
 * extension never ran.
 *
 * Two hard-won rules are enforced here. The level must be `debug`, because the SDK's lines
 * are debug lines and the default filter drops every one of them; and a second concurrent
 * stream against one simulator silently yields nothing at all, which is indistinguishable
 * from an SDK that did nothing.
 */
/**
 * Why a phone's log cannot be read, if it cannot. On a phone there is no supported route
 * through `log`: streaming has no device support and `log collect --device-udid` needs root.
 * libimobiledevice is the way in, and it is an optional prerequisite. Without it nothing a
 * push does on the phone can be seen, so the run checks this before sending anything.
 */
export async function deviceLogUnavailable(
  target: Target
): Promise<string | undefined> {
  if (target.kind !== 'device') return undefined;
  if (await isCommandAvailable('idevicesyslog')) return undefined;
  return (
    'idevicesyslog is not installed — `brew install libimobiledevice` to read device logs, ' +
    'or verify on a simulator instead'
  );
}

export async function startCapture(
  target: Target,
  evidenceDirectory?: string,
  processNames: string[] = [],
  extensionName?: string
): Promise<LogCapture> {
  const evidencePath = evidenceDirectory
    ? path.join(evidenceDirectory, `${target.kind}-${target.udid}.log`)
    : undefined;
  if (evidenceDirectory) {
    await fs.mkdir(evidenceDirectory, { recursive: true });
  }

  if (target.kind === 'simulator') {
    const conflict = await existingSimulatorStream(target.udid);
    if (conflict) {
      return {
        ...NOT_CAPTURING,
        unavailableReason:
          'another log stream is already attached to this simulator (pid ' +
          `${conflict}); a second one returns nothing at all, so no evidence would be real`,
      };
    }
    return await streamProcess(
      'xcrun',
      [
        'simctl',
        'spawn',
        target.udid,
        // `log` is also a zsh builtin, but spawning bypasses the shell entirely.
        'log',
        'stream',
        '--style',
        'ndjson',
        '--level',
        'debug',
        '--predicate',
        simulatorPredicate(extensionName),
      ],
      parseNdjson,
      'simctl log stream --level debug',
      evidencePath
    );
  }

  const unreadable = await deviceLogUnavailable(target);
  if (unreadable) {
    return { ...NOT_CAPTURING, unavailableReason: unreadable };
  }

  // Unfiltered, a phone's syslog is tens of megabytes a minute and buries the twelve lines
  // that matter — the first attempt at this collected 17MB and never finished a cell. The
  // app and extension process names come from the project, and the kernel is dropped
  // outright: its `unhandled kAMPDUStat_` spam has already produced a false match once.
  // `-p` and `-K` are mutually exclusive, and passing both makes idevicesyslog print
  // usage and exit — which read as "the app logged nothing" and accused a working
  // extension three times over. A process filter excludes the kernel anyway.
  const attached = await existingDeviceStream(target.udid);
  if (attached) {
    return {
      ...NOT_CAPTURING,
      unavailableReason:
        `idevicesyslog (pid ${attached}) is already attached to this device, so a second ` +
        'stream would read nothing — stop it and run again',
    };
  }

  const filter = processNames.filter(Boolean).join('|');
  const args = filter
    ? ['-u', target.udid, '-p', filter]
    : ['-u', target.udid, '-K'];

  return {
    ...(await streamProcess(
      'idevicesyslog',
      args,
      parseSyslog,
      filter ? `idevicesyslog -p "${filter}"` : 'idevicesyslog (unfiltered)',
      evidencePath
    )),
    lossy: true,
  };
}

/**
 * `idevicesyslog` already attached to this device?
 *
 * The simulator path has had this check for a while; the device path did not, and the
 * consequence is worse there — an orphan survives across runs, and the second attach reads
 * as an extension that never ran.
 */
async function existingDeviceStream(udid: string): Promise<string | undefined> {
  const { stdout, code } = await run(
    'pgrep',
    ['-f', `idevicesyslog -u ${udid}`],
    10_000
  );
  if (code !== 0) return undefined;
  const pid = stdout.trim().split('\n')[0];
  return pid && pid !== String(process.pid) ? pid : undefined;
}

async function existingSimulatorStream(
  udid: string
): Promise<string | undefined> {
  const { stdout, code } = await run(
    'pgrep',
    ['-f', `simctl spawn ${udid} log stream`],
    10_000
  );
  if (code !== 0) return undefined;
  const pid = stdout.trim().split('\n')[0];
  return pid && pid !== String(process.pid) ? pid : undefined;
}

/**
 * Every live capture, so an interrupt cannot leave one attached.
 *
 * `stop()` runs on the happy path only, and a run that is interrupted — or that throws
 * before its `finally` — used to orphan the stream. That is not merely untidy: a leftover
 * stream against the same target makes the *next* run's capture silently return nothing,
 * which is the exact condition this module works hardest to tell apart from an SDK that
 * did nothing. One was found alive 25 hours after the run that started it.
 */
const live = new Set<ChildProcess>();
let cleanupInstalled = false;

export function trackCapture(child: ChildProcess): void {
  track(child);
}

function track(child: ChildProcess): void {
  live.add(child);
  child.once('exit', () => live.delete(child));
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const killAll = (): void => {
    for (const process of live) process.kill('SIGKILL');
    live.clear();
  };
  process.once('exit', killAll);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      killAll();
      process.exit(130);
    });
  }
}

/** Bounded so an unfiltered device log cannot exhaust memory mid-run. */
const MAX_RETAINED_LINES = 40_000;

async function streamProcess(
  command: string,
  args: string[],
  parse: (chunk: string) => LogLine[],
  how: string,
  evidencePath?: string
): Promise<LogCapture> {
  const child: ChildProcess = spawn(command, args);
  track(child);
  const lines: LogLine[] = [];
  /** How many lines the retention window has discarded, so a mark stays meaningful. */
  let dropped = 0;
  let buffer = '';
  let stderr = '';
  let exited: number | null | undefined;
  /** Set once the reader has survived startup; an exit after that is a mid-run stop. */
  let started = false;
  let stopping = false;
  let stoppedReason: string | undefined;
  let sink: WriteStream | undefined;
  if (evidencePath) sink = createWriteStream(evidencePath, { flags: 'a' });

  child.on('exit', (code) => {
    if (!started || stopping) return;
    stoppedReason = `${command} exited${
      code === null ? '' : ` (${code})`
    } at ${new Date().toISOString().slice(11, 19)}, partway through the run`;
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on('exit', (code) => {
    exited = code;
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      for (const line of parse(part)) {
        lines.push(line);
        // Disk holds everything; memory holds the recent window a cell reads back.
        if (lines.length > MAX_RETAINED_LINES) {
          lines.splice(0, 10_000);
          dropped += 10_000;
        }
        // Written as it arrives: buffered evidence is lost on interrupt, and losing a
        // confirmed result to a Ctrl-C has already happened once.
        sink?.write(`${line.at} ${line.process}: ${line.message}\n`);
      }
    }
  });

  // A log tool that fails has to be told apart from an SDK that did nothing, so the stream
  // is given a moment to fall over before anything is claimed about it.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  if (exited !== undefined) {
    sink?.end();
    return {
      available: false,
      lines: [],
      unavailableReason: `${command} exited immediately (${exited}): ${
        stderr.trim().split('\n')[0] || 'no output'
      }`,
      mark: () => 0,
      since: () => [],
      stop: async () => undefined,
    };
  }

  started = true;
  return {
    available: true,
    how,
    lines,
    mark: () => dropped + lines.length,
    since: (mark: number) => lines.slice(Math.max(0, mark - dropped)),
    evidencePath,
    stoppedReason: () => stoppedReason,
    stop: async () => {
      stopping = true;
      child.kill();
      await new Promise<void>((resolve) => sink?.end(resolve) ?? resolve());
    },
  };
}

export function parseNdjson(raw: string): LogLine[] {
  const line = raw.trim().replace(/,$/, '');
  if (!line.startsWith('{')) return [];
  try {
    const parsed = JSON.parse(line) as Record<string, string>;
    return [
      {
        at: (parsed.timestamp ?? '').slice(11, 23),
        process: (parsed.processImagePath ?? '').split('/').pop() ?? '',
        message: parsed.eventMessage ?? '',
      },
    ];
  } catch {
    // A partial line at a chunk boundary; the next chunk completes it.
    return [];
  }
}

/**
 * idevicesyslog prints `Sep 17 02:52:47.433512 Process(Image)[pid] <Level>: message`.
 *
 * Two details cost a whole device run. The seconds carry a fractional part, so a `[\d:]+`
 * clock never matches and every line falls through as an unattributed blob — which made a
 * working extension look absent. And the process name carries the logging image in
 * parentheses, so it has to be stripped or `NotificationServiceExtension(CFNetwork)` is a
 * different process from `NotificationServiceExtension(Foundation)`.
 */
export function parseSyslog(raw: string): LogLine[] {
  const line = raw.trimEnd();
  if (!line) return [];
  const match = line.match(
    /^(\w{3}\s+\d+\s[\d:.]+)\s+([^[(]+?)(?:\([^)]*\))?\[(\d+)\]\s*(?:<[^>]*>)?:\s?(.*)$/
  );
  if (!match) return [{ at: '', process: '', message: line }];
  return [{ at: match[1], process: match[2].trim(), message: match[4] }];
}

/**
 * The SDK's own phrasings, anchored deliberately.
 *
 * A loose filter has twice produced a false result here: a bare /handled/ matched kernel
 * `unhandled kAMPDUStat_` spam, and a bare /Successfully/ reported three errored sends as
 * passing. Each pattern below is the SDK's exact sentence.
 */
export const NSE_MARKERS = {
  tracking: /Tracking push message delivered/,
  accepted: /Successfully tracked push metric 'delivered'/,
  /** Fires at the end of the sequence; `delivered` fires mid-way and truncates a capture. */
  completion: /invoking contentHandler|normal completion/,
  richFinished: /rich push step finished/,
} as const;

/**
 * Did the extension run? Read from which process wrote a line — the OS's attribution — never
 * from what the line says, so it holds whatever the SDK logs or fails to.
 */
export function ranInExtension(
  lines: LogLine[],
  extensionName?: string
): boolean {
  return lines.some((line) =>
    extensionName && line.process === extensionName
      ? true
      : /NotificationService/.test(line.process)
  );
}

/** Delivery ids are base64url with a `dgS_` prefix — a charset without `_` and `-` misses. */
export function deliveryIdsIn(lines: LogLine[]): string[] {
  const ids = new Set<string>();
  for (const line of lines) {
    for (const match of line.message.matchAll(
      /(dgS_[A-Za-z0-9_-]{8,}={0,2})/g
    )) {
      ids.add(match[1].replace(/[,)]+$/, ''));
    }
  }
  return [...ids];
}
