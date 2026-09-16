import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RunResult, isCommandAvailable, run } from '../exec';

let cached: string | undefined;

/**
 * Find `adb`.
 *
 * It is on PATH for anyone who set their shell up for Android work and missing for everyone
 * else, so the SDK's own locations are checked too rather than telling a developer with a
 * working Android Studio that they have no tooling.
 */
export async function adbPath(): Promise<string | undefined> {
  if (cached) return cached;
  if (await isCommandAvailable('adb')) {
    cached = 'adb';
    return cached;
  }

  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), 'Library', 'Android', 'sdk'),
    path.join(os.homedir(), 'Android', 'Sdk'),
  ].filter((root): root is string => Boolean(root));

  for (const root of roots) {
    const candidate = path.join(root, 'platform-tools', 'adb');
    if (
      await fs.stat(candidate).then(
        () => true,
        () => false
      )
    ) {
      cached = candidate;
      return cached;
    }
  }
  return undefined;
}

export async function adb(
  serial: string | undefined,
  args: string[],
  timeoutMs = 120_000
): Promise<RunResult> {
  const binary = await adbPath();
  if (!binary) {
    return { stdout: '', stderr: 'adb was not found', code: 127 };
  }
  const prefix = serial ? ['-s', serial] : [];
  return run(binary, [...prefix, ...args], timeoutMs);
}

/**
 * Read a file out of an app's private data directory.
 *
 * `run-as` works only for a debuggable build, which is exactly the build being verified
 * during development. The emulator's root shell is the fallback, and its absence is worth
 * reporting rather than papering over: without it there is no token to read.
 */
export async function readAppFile(
  serial: string,
  packageName: string,
  relativePath: string
): Promise<{ text?: string; error?: string }> {
  const absolute = `/data/data/${packageName}/${relativePath}`;
  const viaRunAs = await adb(serial, [
    'shell',
    'run-as',
    packageName,
    'cat',
    absolute,
  ]);
  if (viaRunAs.code === 0 && viaRunAs.stdout.trim()) {
    return { text: viaRunAs.stdout };
  }

  const viaRoot = await adb(serial, ['shell', 'su', '0', 'cat', absolute]);
  if (viaRoot.code === 0 && viaRoot.stdout.trim()) {
    return { text: viaRoot.stdout };
  }

  return {
    error:
      viaRunAs.stderr.trim().split('\n')[0] ||
      viaRoot.stderr.trim().split('\n')[0] ||
      `could not read ${relativePath}`,
  };
}

/** Android's shared preferences are XML with entity-escaped values. */
export function prefString(xml: string, key: string): string | undefined {
  const match = xml.match(
    new RegExp(`<string name="${escapeForRegExp(key)}">([\\s\\S]*?)</string>`)
  );
  return match ? decodeXmlEntities(match[1]) : undefined;
}

export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
