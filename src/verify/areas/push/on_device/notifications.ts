import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { run } from '../../../core/exec';
import { Target } from '../../../platform/ios/device';
import { parsePlistXml, unarchive } from '../../../platform/ios/plist';

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
 * So the question is asked precisely: is the title we sent in the delivered set? Each push
 * carries a tag nobody else uses, which makes the answer unambiguous. This is the OS's own
 * record, not a log, so nothing in it can go missing the way a log line can.
 *
 * The store is an NSKeyedArchiver plist. Each stored notification keeps its title
 * (`AppNotificationTitle`) next to the push's payload (`UNNotificationUserInfo`), and the
 * payload carries `CIO-Delivery-ID` — so the store also says which delivery this push is,
 * without asking the SDK.
 */
export interface StoredNotification {
  title: string;
  deliveryId?: string;
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
 * Every notification in the delivered stores touched since `sinceMs`.
 *
 * Only recently written stores are read, which keeps this to a couple of `plutil` calls
 * per poll instead of a hundred and thirty.
 */
export async function deliveredNotifications(
  target: Target,
  sinceMs: number
): Promise<StoredNotification[] | undefined> {
  // A physical device gives no access to this, so arrival there is whatever the log says.
  if (target.kind !== 'simulator') return undefined;

  const root = storeRoot(target);
  const directories = await fs.readdir(root).catch(() => undefined);
  if (!directories) return [];

  const notifications: StoredNotification[] = [];
  for (const directory of directories) {
    const file = path.join(root, directory, 'DeliveredNotifications.plist');
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat || stat.mtimeMs < sinceMs) continue;
    // XML, not JSON: an archive is full of object references, which JSON cannot express.
    const { stdout, code } = await run(
      'plutil',
      ['-convert', 'xml1', '-o', '-', file],
      15_000
    );
    if (code === 0) notifications.push(...storedNotificationsFrom(stdout));
  }
  return notifications;
}

/**
 * Wait for the notification with one exact title, or any of several. `undefined` means the
 * question cannot be asked here, which is not the same answer as `false`.
 */
export async function waitForNotification(options: {
  target: Target;
  title: string | string[];
  timeoutMs: number;
  /** Ignore stores untouched since this moment — normally just before the send. */
  sinceMs: number;
  intervalMs?: number;
}): Promise<StoredNotification | false | undefined> {
  if (options.target.kind !== 'simulator') return undefined;
  const titles = ([] as string[]).concat(options.title);
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const stored = await deliveredNotifications(
      options.target,
      options.sinceMs
    );
    const found = stored?.find((notification) =>
      titles.includes(notification.title)
    );
    if (found) return found;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) =>
      setTimeout(resolve, options.intervalMs ?? 900)
    );
  }
}

/** The same question, when only whether it arrived matters. */
export async function waitForTitle(options: {
  target: Target;
  title: string;
  timeoutMs: number;
  sinceMs: number;
  intervalMs?: number;
}): Promise<boolean | undefined> {
  const found = await waitForNotification(options);
  return found === undefined ? undefined : found !== false;
}

/** Every stored notification in one store, from `plutil -convert xml1` output. */
export function storedNotificationsFrom(xml: string): StoredNotification[] {
  let archive: unknown;
  try {
    archive = unarchive(parsePlistXml(xml));
  } catch {
    return [];
  }
  const found: StoredNotification[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.AppNotificationTitle === 'string') {
      const payload = record.UNNotificationUserInfo as
        | Record<string, unknown>
        | undefined;
      const id = payload?.['CIO-Delivery-ID'];
      found.push({
        title: record.AppNotificationTitle,
        deliveryId: typeof id === 'string' ? id : undefined,
      });
      return;
    }
    for (const item of Object.values(record)) visit(item, depth + 1);
  };
  visit(archive, 0);
  return found;
}
