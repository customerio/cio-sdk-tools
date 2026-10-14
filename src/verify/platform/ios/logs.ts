import { ChildProcess, spawn } from 'child_process';
import { createWriteStream, WriteStream } from 'fs';
import { promises as fs } from 'fs';
import * as path from 'path';
import { isCommandAvailable, run } from '../../core/exec';
import {
  FollowedProcess,
  FollowedStream,
  LogCapture,
  LogLine,
  StreamAgreement,
  trackCapture,
} from '../logs';
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
  //
  // A name filter is applied on the Mac, so the phone still sends its whole log, and drops
  // lines from all of it when busy. Another stream on the same phone does not take lines
  // from this one: sixteen at once all delivered, which is what `followProcess` relies on.
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
      evidencePath,
      target.udid
    )),
    lossy: true,
  };
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
/** Lines remembered for comparing two streams, once a second one reads the same process. */
const MAX_REMEMBERED_LINES = 20_000;
/**
 * How far apart two streams stamp the same line. They do not agree to the microsecond: over
 * 3,800 lines from an iPhone 15 the two copies were 30 to 512µs apart, so a copy within this
 * window of the other stream's is the same line, and a repeat within one stream is two.
 */
const SAME_LINE_SECONDS = 0.002;

/**
 * Where every stream of one capture puts its lines: a bounded window in memory, everything on
 * disk, and, once a second stream reads the same process, each line once.
 */
export interface LineSink {
  lines: LogLine[];
  /** Take a line from the whole-log stream (`main`) or a stream for one pid (`followed`). */
  add(line: LogLine, from?: 'main' | 'followed'): void;
  /** From now on, a line the other stream already delivered is not taken again. */
  dedupe(): void;
  /**
   * Which stream delivered one process's lines since `dedupe()`. The last second is left out:
   * one stream can be a moment behind the other, and a line still on its way is not missing.
   */
  compare(process: string): StreamAgreement;
  mark(): number;
  since(mark: number): LogLine[];
  end(): Promise<void>;
}

interface Remembered {
  line: LogLine;
  time: number;
  /** The streams that delivered it: 1 the whole log, 2 a pid. */
  from: number;
}

export function createLineSink(evidencePath?: string): LineSink {
  const lines: LogLine[] = [];
  /** How many lines the retention window has discarded, so a mark stays meaningful. */
  let dropped = 0;
  let deduping = false;
  /** Every line since `dedupe()`, in arrival order, for `compare`. */
  let remembered: Remembered[] = [];
  /** The last two seconds of lines by text, where another stream's copy can still match. */
  const recent = new Map<string, Remembered[]>();
  const evidence: WriteStream | undefined = evidencePath
    ? createWriteStream(evidencePath, { flags: 'a' })
    : undefined;

  /** The other stream's copy of this line, if it has already delivered one. */
  const matchCopy = (text: string, time: number, bit: number) => {
    const copies = (recent.get(text) ?? []).filter(
      (copy) => copy.time >= time - 2
    );
    recent.set(text, copies);
    let nearest: Remembered | undefined;
    for (const copy of copies) {
      const apart = Math.abs(copy.time - time);
      if (copy.from & bit || apart > SAME_LINE_SECONDS) continue;
      if (!nearest || apart < Math.abs(nearest.time - time)) nearest = copy;
    }
    return { copies, nearest };
  };

  return {
    lines,
    add(line, from = 'main') {
      const bit = from === 'main' ? 1 : 2;
      // A line the reader could not parse has no time, so it cannot be told from another.
      if (deduping && line.at) {
        const time = secondOfDay(line.at);
        const text = `${line.process}\u0000${line.message}`;
        const { copies, nearest } = matchCopy(text, time, bit);
        if (nearest) {
          nearest.from |= bit;
          return;
        }
        const entry = { line, time, from: bit };
        copies.push(entry);
        remembered.push(entry);
        if (remembered.length > MAX_REMEMBERED_LINES) {
          remembered = remembered.slice(MAX_REMEMBERED_LINES / 4);
        }
      }
      lines.push(line);
      // Disk holds everything; memory holds the recent window a cell reads back.
      if (lines.length > MAX_RETAINED_LINES) {
        lines.splice(0, 10_000);
        dropped += 10_000;
      }
      // Written as it arrives: buffered evidence is lost on interrupt, and losing a
      // confirmed result to a Ctrl-C has already happened once.
      evidence?.write(`${line.at} ${line.process}: ${line.message}\n`);
    },
    dedupe() {
      deduping = true;
    },
    compare(process) {
      const entries = remembered.filter(
        (entry) => entry.line.process === process
      );
      const latest = Math.max(...entries.map((entry) => entry.time));
      const agreement = { both: 0, onlyFollowed: 0, onlyMain: 0 };
      for (const entry of entries) {
        if (entry.time > latest - 1) continue;
        if (entry.from === 3) agreement.both += 1;
        else if (entry.from === 2) agreement.onlyFollowed += 1;
        else agreement.onlyMain += 1;
      }
      return agreement;
    },
    mark: () => dropped + lines.length,
    since: (mark: number) => lines.slice(Math.max(0, mark - dropped)),
    end: () =>
      new Promise<void>((resolve) =>
        evidence ? evidence.end(resolve) : resolve()
      ),
  };
}

/** `Oct 14 17:30:07.358078` as seconds since midnight; a run never spans one. */
function secondOfDay(at: string): number {
  const clock = /(\d+):(\d+):([\d.]+)$/.exec(at);
  return clock
    ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])
    : 0;
}

async function streamProcess(
  command: string,
  args: string[],
  parse: (chunk: string) => LogLine[],
  how: string,
  evidencePath?: string,
  /** A phone's udid: its capture can follow single processes too. */
  phone?: string
): Promise<LogCapture> {
  const child: ChildProcess = spawn(command, args);
  trackCapture(child);
  const sink = createLineSink(evidencePath);
  const followers: ChildProcess[] = [];
  let buffer = '';
  let stderr = '';
  let exited: number | null | undefined;
  /** Set once the reader has survived startup; an exit after that is a mid-run stop. */
  let started = false;
  let stopping = false;
  let stoppedReason: string | undefined;

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
      for (const line of parse(part)) sink.add(line);
    }
  });

  // A log tool that fails has to be told apart from an SDK that did nothing, so the stream
  // is given a moment to fall over before anything is claimed about it.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  if (exited !== undefined) {
    await sink.end();
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
    lines: sink.lines,
    mark: sink.mark,
    since: sink.since,
    evidencePath,
    stoppedReason: () => stoppedReason,
    compareStreams: phone ? sink.compare : undefined,
    followProcess: phone
      ? (pid: number, only?: string[]) =>
          followOnPhone(phone, pid, only, sink, followers, (reason) => {
            if (!stopping) stoppedReason ??= reason;
          })
      : undefined,
    stop: async () => {
      stopping = true;
      child.kill();
      for (const follower of followers) follower.kill();
      await sink.end();
    },
  };
}

/** How long a stream for one pid gets to reach the phone. */
const FOLLOW_CONNECT_TIMEOUT_MS = 5_000;

/**
 * A numeric `-p` is sent to the phone as the relay's own pid filter, so the phone sends only
 * that process's lines and has nothing to drop: 0 of 75 SDK lines lost over seven launches,
 * against up to 45 lost by the name-filtered stream in the same minutes. A name is matched on
 * the Mac and changes nothing. idevicesyslog prints `[connected:…]` only after the phone has
 * answered the request that sets the filter, so nothing written after it is missed, and a
 * stream opened for a pid nobody has yet reads that process from its first line.
 *
 * With `only`, lines from any other process are dropped unread: a pid opened ahead of time
 * can go to someone else's process, and its lines are not this tool's to keep.
 */
function followOnPhone(
  udid: string,
  pid: number,
  only: string[] | undefined,
  sink: LineSink,
  followers: ChildProcess[],
  /** A stream that delivered lines stopped: what it read after that point is missing. */
  onLost: (reason: string) => void
): FollowedStream {
  const how = `idevicesyslog -p ${pid}`;
  const child = spawn('idevicesyslog', ['-u', udid, '-p', String(pid)]);
  trackCapture(child);
  followers.push(child);
  sink.dedupe();
  let buffer = '';
  let stderr = '';
  let connectedAt: number | undefined;
  let foreign = false;
  let ours = false;
  let stopped = false;
  const connected = new Promise<FollowedProcess>((resolve) => {
    const timer = setTimeout(
      () =>
        resolve({
          connected: false,
          how,
          reason: `no connection after ${FOLLOW_CONNECT_TIMEOUT_MS / 1000}s`,
        }),
      FOLLOW_CONNECT_TIMEOUT_MS
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        if (part.startsWith('[connected:')) {
          connectedAt ??= Date.now();
          clearTimeout(timer);
          resolve({ connected: true, how });
          continue;
        }
        for (const line of parseSyslog(part)) {
          if (only && !only.includes(line.process)) {
            // A continuation line has no process; it belongs to whichever line came before.
            if (line.process) foreign = true;
            continue;
          }
          ours = true;
          sink.add(line, 'followed');
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (connectedAt !== undefined && ours && !stopped) {
        onLost(
          `${how} exited${code === null ? '' : ` (${code})`} at ${new Date()
            .toISOString()
            .slice(11, 19)}, partway through the run`
        );
      }
      resolve({
        connected: false,
        how,
        reason: `idevicesyslog exited (${code}): ${
          stderr.trim().split('\n')[0] || 'no output'
        }`,
      });
    });
  });
  return {
    pid,
    how,
    connected,
    connectedAt: () => connectedAt,
    foreign: () => foreign,
    ours: () => ours,
    stop: () => {
      stopped = true;
      child.kill();
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
  // idevicesyslog's own word that it reached the phone or lost it. Kept as a line, it was
  // the only line of a run whose stream delivered nothing, and it read as the app talking:
  // the run then blamed the SDK's log level for a log that never arrived.
  if (/^\[(?:connected|disconnected):/.test(line)) return [];
  const match = line.match(
    /^(\w{3}\s+\d+\s[\d:.]+)\s+([^[(]+?)(?:\([^)]*\))?\[(\d+)\]\s*(?:<[^>]*>)?:\s?(.*)$/
  );
  if (!match) return [{ at: '', process: '', message: line }];
  return [{ at: match[1], process: match[2].trim(), message: match[4] }];
}
