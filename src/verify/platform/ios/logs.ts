import { ChildProcess, spawn } from 'child_process';
import { createWriteStream, WriteStream } from 'fs';
import { promises as fs } from 'fs';
import * as path from 'path';
import { isCommandAvailable, run } from '../../core/exec';
import { LogCapture, LogLine, trackCapture } from '../logs';
import { Target } from './device';

/**
 * What to read from a simulator or a phone. The area knows which processes and which
 * subsystem carry its evidence; the capture only knows how to read them.
 */
export interface CaptureFilter {
  /** Processes to keep on a phone, where the unfiltered log is tens of megabytes a minute. */
  processes?: string[];
  /** The simulator's `log stream --predicate`; the SDK's subsystem when not given. */
  predicate?: string;
}

const SDK_SUBSYSTEM_PREDICATE = 'subsystem == "io.customer.sdk"';

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
  filter: CaptureFilter = {}
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
        filter.predicate ?? SDK_SUBSYSTEM_PREDICATE,
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

  const processes = (filter.processes ?? []).filter(Boolean).join('|');
  const args = processes
    ? ['-u', target.udid, '-p', processes]
    : ['-u', target.udid, '-K'];

  return {
    ...(await streamProcess(
      'idevicesyslog',
      args,
      parseSyslog,
      processes
        ? `idevicesyslog -p "${processes}"`
        : 'idevicesyslog (unfiltered)',
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
  trackCapture(child);
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
