import { ChildProcess, spawn } from 'child_process';
import { createWriteStream, WriteStream } from 'fs';
import { promises as fs } from 'fs';
import * as path from 'path';
import { isCommandAvailable, run } from '../exec';
import { Target } from '../ios/device';

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
  /** File the lines are appended to as they arrive. */
  evidencePath?: string;
  stop(): Promise<void>;
}

const SDK_PREDICATE =
  'subsystem == "io.customer.sdk" OR processImagePath CONTAINS "NotificationService"';

const NOT_CAPTURING: LogCapture = {
  available: false,
  lines: [],
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
export async function startCapture(
  target: Target,
  evidenceDirectory?: string,
  processNames: string[] = []
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
        SDK_PREDICATE,
      ],
      parseNdjson,
      'simctl log stream --level debug',
      evidencePath
    );
  }

  // On a phone there is no supported route through `log`: streaming has no device support
  // and `log collect --device-udid` needs root. libimobiledevice is the way in, and it is
  // an optional prerequisite — without it the runtime cells report skipped.
  if (!(await isCommandAvailable('idevicesyslog'))) {
    return {
      ...NOT_CAPTURING,
      unavailableReason:
        'idevicesyslog is not installed — `brew install libimobiledevice` to read device logs, ' +
        'or verify on a simulator instead',
    };
  }

  // Unfiltered, a phone's syslog is tens of megabytes a minute and buries the twelve lines
  // that matter — the first attempt at this collected 17MB and never finished a cell. The
  // app and extension process names come from the project, and the kernel is dropped
  // outright: its `unhandled kAMPDUStat_` spam has already produced a false match once.
  // `-p` and `-K` are mutually exclusive, and passing both makes idevicesyslog print
  // usage and exit — which read as "the app logged nothing" and accused a working
  // extension three times over. A process filter excludes the kernel anyway.
  const filter = processNames.filter(Boolean).join('|');
  const args = filter
    ? ['-u', target.udid, '-p', filter]
    : ['-u', target.udid, '-K'];

  return await streamProcess(
    'idevicesyslog',
    args,
    parseSyslog,
    filter ? `idevicesyslog -p "${filter}"` : 'idevicesyslog (unfiltered)',
    evidencePath
  );
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
  const lines: LogLine[] = [];
  let buffer = '';
  let stderr = '';
  let exited: number | null | undefined;
  let sink: WriteStream | undefined;
  if (evidencePath) sink = createWriteStream(evidencePath, { flags: 'a' });

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
        if (lines.length > MAX_RETAINED_LINES) lines.splice(0, 10_000);
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
      stop: async () => undefined,
    };
  }

  return {
    available: true,
    how,
    lines,
    evidencePath,
    stop: async () => {
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

export function ranInExtension(lines: LogLine[]): boolean {
  return lines.some((line) => /NotificationService/.test(line.process));
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
