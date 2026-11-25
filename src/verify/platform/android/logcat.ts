import { ChildProcess, spawn } from 'child_process';
import { createWriteStream, WriteStream } from 'fs';
import { promises as fs } from 'fs';
import * as path from 'path';
import { adb, adbPath } from './adb';
import { LogCapture, LogLine, trackCapture } from '../logs';

/**
 * Android's log needs no extra tooling and no root — `adb logcat` gives the SDK's debug
 * output directly, which is the single biggest difference from verifying on a phone.
 *
 * The capture starts from the device's clock rather than clearing the buffer, which
 * belongs to whoever else is reading it. Lines are written to disk as they arrive because
 * buffered evidence dies with the process.
 */
export async function startAndroidCapture(
  serial: string,
  evidenceDirectory?: string
): Promise<LogCapture> {
  const binary = await adbPath();
  if (!binary) {
    return {
      available: false,
      lines: [],
      mark: () => 0,
      since: () => [],
      unavailableReason:
        'adb was not found — install Android platform-tools, or set ANDROID_HOME',
      stop: async () => undefined,
    };
  }

  const from = await deviceClock(serial);

  const evidencePath = evidenceDirectory
    ? path.join(evidenceDirectory, `android-${serial}.log`)
    : undefined;
  if (evidenceDirectory) await fs.mkdir(evidenceDirectory, { recursive: true });

  const child: ChildProcess = spawn(binary, [
    '-s',
    serial,
    'logcat',
    '-v',
    'time',
    // `-T` replays history from a point and goes on streaming. Without a readable clock the
    // last line stands in, which keeps the replay to a line or two.
    '-T',
    from ?? '1',
  ]);
  trackCapture(child);

  const lines: LogLine[] = [];
  /** See LogCapture.mark: the window drops lines, so a raw index cannot be trusted. */
  let dropped = 0;
  let buffer = '';
  let stderr = '';
  let exited: number | null | undefined;
  let started = false;
  let stopping = false;
  let stoppedReason: string | undefined;
  let sink: WriteStream | undefined;
  if (evidencePath) sink = createWriteStream(evidencePath, { flags: 'a' });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on('exit', (code) => {
    exited = code;
    // An exit after the startup check is a stream that died partway through the run.
    if (started && !stopping) {
      stoppedReason = `adb logcat exited${
        code === null ? '' : ` (${code})`
      } partway through the run`;
    }
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = parseLogcat(part);
      if (!line) continue;
      // Only the SDK's own lines are kept, in memory and in the evidence file. A Samsung
      // S24 produced 60,840 lines in one run, of which 2,553 were ours — the rest is vendor
      // chatter that pushed the retained window over and, before `mark()` existed,
      // invalidated the cells' own indices. The evidence file is something a developer
      // attaches to a report, so other apps' lines stay out of it. Every marker this tool
      // judges on is tagged `[CIO]`, verified against a real capture.
      const own = sdkLine(line);
      if (!own) continue;
      sink?.write(`${line.at} ${line.process}: ${line.message}\n`);
      lines.push(own);
      if (lines.length > 40_000) {
        lines.splice(0, 10_000);
        dropped += 10_000;
      }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 1_200));
  started = true;
  if (exited !== undefined) {
    sink?.end();
    return {
      available: false,
      lines: [],
      mark: () => 0,
      since: () => [],
      unavailableReason: `adb logcat exited immediately (${exited}): ${
        stderr.trim().split('\n')[0] || 'no output'
      }`,
      stop: async () => undefined,
    };
  }

  return {
    available: true,
    how: 'adb logcat',
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

/**
 * The device's clock in the form `logcat -T` takes, or nothing when it cannot be read. The
 * date command's output is split by adb's shell at a space, so the two halves are joined
 * with an underscore on the device and a space here.
 */
async function deviceClock(serial: string): Promise<string | undefined> {
  const { stdout, code } = await adb(
    serial,
    ['shell', 'date', '+%m-%d_%H:%M:%S.000'],
    15_000
  );
  const text = stdout.trim().replace('_', ' ');
  return code === 0 && /^\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/.test(text)
    ? text
    : undefined;
}

/** `-v time` prints `MM-DD HH:MM:SS.mmm LEVEL/TAG( pid): message`. */
export function parseLogcat(raw: string): LogLine | undefined {
  const line = raw.trimEnd();
  if (!line || line.startsWith('---------')) return undefined;
  const match = line.match(
    /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\s+[VDIWEF]\/([^(]+)\(\s*\d+\):\s?(.*)$/
  );
  if (!match) return { at: '', process: '', message: line };
  return { at: match[1], process: match[2].trim(), message: match[3] };
}

const FORWARDED = '[CIO] ';

/**
 * The SDK's own line, or nothing. React Native forwards the native SDK's lines to its
 * JavaScript console, so they reach logcat under `ReactNativeJS` with `[CIO] ` in front of
 * the message. The prefix is dropped, so they read exactly as the native SDK writes them.
 *
 * WorkManager's lines about the SDK's workers are kept too. WorkManager writes them at its
 * own level, so they still speak when the SDK logs nothing: a React Native app started for a
 * push runs no JavaScript, and its SDK's log level is set from there.
 */
export function sdkLine(line: LogLine): LogLine | undefined {
  if (line.process.includes('CIO')) return line;
  if (line.process.startsWith('WM-') && line.message.includes('io.customer.')) {
    return line;
  }
  return line.message.startsWith(FORWARDED)
    ? { ...line, message: line.message.slice(FORWARDED.length) }
    : undefined;
}
