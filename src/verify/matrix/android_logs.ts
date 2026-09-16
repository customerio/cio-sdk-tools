import { ChildProcess, spawn } from 'child_process';
import { createWriteStream, WriteStream } from 'fs';
import { promises as fs } from 'fs';
import * as path from 'path';
import { adb, adbPath } from '../android/adb';
import { LogCapture, LogLine } from './logs';

/**
 * Android's log needs no extra tooling and no root — `adb logcat` gives the SDK's debug
 * output directly, which is the single biggest difference from verifying on a phone.
 *
 * The buffer is cleared first so a cell's window starts empty, and lines are written to
 * disk as they arrive because buffered evidence dies with the process.
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
      unavailableReason:
        'adb was not found — install Android platform-tools, or set ANDROID_HOME',
      stop: async () => undefined,
    };
  }

  await adb(serial, ['logcat', '-c'], 30_000);

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
  ]);

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
      const line = parseLogcat(part);
      if (!line) continue;
      lines.push(line);
      if (lines.length > 40_000) lines.splice(0, 10_000);
      sink?.write(`${line.at} ${line.process}: ${line.message}\n`);
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 1_200));
  if (exited !== undefined) {
    sink?.end();
    return {
      available: false,
      lines: [],
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
    evidencePath,
    stop: async () => {
      child.kill();
      await new Promise<void>((resolve) => sink?.end(resolve) ?? resolve());
    },
  };
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

/**
 * The SDK's own phrasings on Android, which differ from iOS by more than wording.
 *
 * There is no per-metric confirmation line here: the SDK hands the delivered event to the
 * CDP pipeline, which flushes in batches, so `tracked` is the strongest local evidence
 * available. Claiming acceptance from these lines would be claiming more than they say.
 */
export const ANDROID_MARKERS = {
  received: /Received new message with deliveryId: /,
  tracked: /Tracking push message delivered with deliveryId: /,
  shown: /Showing notification for message: /,
  duplicate: /Received duplicate message with deliveryId: /,
} as const;

export function androidDeliveryIds(lines: LogLine[]): string[] {
  const ids = new Set<string>();
  for (const line of lines) {
    for (const match of line.message.matchAll(
      /deliveryId[:=]\s*([A-Za-z0-9_-]{8,}={0,2})/g
    )) {
      ids.add(match[1]);
    }
  }
  return [...ids];
}
