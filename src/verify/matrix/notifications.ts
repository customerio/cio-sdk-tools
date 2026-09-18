import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { run } from '../exec';
import { Target } from '../ios/device';

/**
 * Did *our* notification arrive?
 *
 * The first version of this compared a fingerprint of every notification store on the
 * simulator — one entry per installed app, well over a hundred of them — and called any
 * change an arrival. Any unrelated system notification therefore read as our push
 * landing, which is how a run came to ask someone to tap a banner that had never been
 * sent to them. Worse, it is a false *positive* in the one place the tool must never have
 * one: the check that decides whether a push arrived.
 *
 * So the question is asked precisely: is the title we sent in the delivered set? Each cell
 * sends a title nobody else uses, which makes the answer unambiguous.
 *
 * The store is an NSKeyedArchiver plist, so the strings are not greppable in the raw file
 * — `plutil -p` prints the object table, and the titles come out of that.
 */
export function titlesFrom(printed: string): string[] {
  const titles: string[] = [];
  const pattern = /"([^"\n]{2,120})"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(printed)) !== null) titles.push(match[1]);
  return titles;
}

function storeRoot(target: Target): string {
  return path.join(
    os.homedir(),
    'Library/Developer/CoreSimulator/Devices',
    target.udid,
    'data/Library/UserNotifications'
  );
}

/**
 * Strings in every delivered-notification store touched since `sinceMs`.
 *
 * Only recently written stores are read, which keeps this to a couple of `plutil` calls
 * per poll instead of a hundred and thirty.
 */
export async function deliveredStrings(
  target: Target,
  sinceMs: number
): Promise<string[] | undefined> {
  // A physical device gives no access to this, so arrival there is whatever the log says.
  if (target.kind !== 'simulator') return undefined;

  const root = storeRoot(target);
  const directories = await fs.readdir(root).catch(() => undefined);
  if (!directories) return [];

  const strings: string[] = [];
  for (const directory of directories) {
    const file = path.join(root, directory, 'DeliveredNotifications.plist');
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat || stat.mtimeMs < sinceMs) continue;
    const { stdout, code } = await run('plutil', ['-p', file], 15_000);
    if (code === 0) strings.push(...titlesFrom(stdout));
  }
  return strings;
}

/**
 * Wait for one exact title to appear. `undefined` means the question cannot be asked
 * here, which is not the same answer as `false`.
 */
export async function waitForTitle(options: {
  target: Target;
  title: string;
  timeoutMs: number;
  /** Ignore stores untouched since this moment — normally just before the send. */
  sinceMs: number;
  intervalMs?: number;
}): Promise<boolean | undefined> {
  if (options.target.kind !== 'simulator') return undefined;
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const strings = await deliveredStrings(options.target, options.sinceMs);
    if (strings?.includes(options.title)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) =>
      setTimeout(resolve, options.intervalMs ?? 900)
    );
  }
}
