import { ChildProcess, spawn } from 'child_process';
import { createWriteStream, WriteStream } from 'fs';
import { promises as fs } from 'fs';
import * as path from 'path';
import { adb, adbPath } from '../android/adb';
import { LogCapture, LogLine, trackCapture } from './logs';

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
      mark: () => 0,
      since: () => [],
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
  trackCapture(child);

  const lines: LogLine[] = [];
  /** See LogCapture.mark: the window drops lines, so a raw index cannot be trusted. */
  let dropped = 0;
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
      // Everything goes to the evidence file; only the SDK's own lines are retained in
      // memory. A Samsung S24 produced 60,840 lines in one run, of which 2,553 were ours
      // — the rest is vendor chatter that pushed the retained window over and, before
      // `mark()` existed, invalidated the cells' own indices. Every marker this tool
      // judges on is tagged `[CIO]`, verified against a real capture.
      if (!line.process.includes('CIO')) {
        sink?.write(`${line.at} ${line.process}: ${line.message}\n`);
        continue;
      }
      lines.push(line);
      if (lines.length > 40_000) {
        lines.splice(0, 10_000);
        dropped += 10_000;
      }
      sink?.write(`${line.at} ${line.process}: ${line.message}\n`);
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 1_200));
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
 * The SDK's own phrasings on Android.
 *
 * The delivered metric goes through a handoff queue backed by WorkManager, and the worker
 * says either `worker success, removed key=<id>` or `worker skipped, already delivered
 * key=<id>`. Both mean the SDK sent its report; the second means it had already gone out
 * directly. They are kept as evidence and never judged: what was recorded is Customer.io's
 * to say. The verdict rests on the push being on the device and the SDK receiving it.
 *
 * The timing matters as much as the wording. A full sequence observed on API 35:
 *
 *   00.000  Received new message with deliveryId
 *   00.030  Tracking push message delivered with deliveryId
 *   00.050  handoff: appended pending entry
 *   00.160  handoff: enqueued WM
 *   05.650  handleNotificationTrigger (FCM re-delivers the message)
 *   05.900  Received duplicate message with deliveryId  ← normal, the SDK dedupes
 *   06.010  Showing notification for message
 *   38.300  handoff: worker success / skipped
 *
 * Stopping at `tracked` therefore misses the notification and the acceptance entirely — the
 * same mistake as waiting for `delivered` instead of `normal completion` on iOS.
 */
export const ANDROID_MARKERS = {
  received: /Received new message with deliveryId: /,
  tracked: /Tracking push message delivered with deliveryId: /,
  shown: /Showing notification for message: /,
  /** FCM re-delivering the same message. Evidence, never a fault. */
  duplicate: /Received duplicate message with deliveryId: /,
  handoffQueued: /\[CIO-Push-Handoff\] enqueued WM key=/,
  handoffDelivered: /\[CIO-Push-Handoff\] worker success, removed key=/,
  handoffAlreadyDelivered:
    /\[CIO-Push-Handoff\] worker skipped, already delivered key=/,
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
