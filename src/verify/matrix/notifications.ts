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

type PlistValue =
  | string
  | number
  | boolean
  | PlistValue[]
  | { [key: string]: PlistValue };

/**
 * An XML property list, parsed. Only what `plutil -convert xml1` writes: dict, array, key,
 * string, integer, real, true, false, data and date. Data and dates stay strings.
 */
export function parsePlistXml(xml: string): PlistValue {
  const tokens = [
    ...xml.matchAll(
      /<(\/?)([a-zA-Z0-9]+)(?:\s[^>]*?)?(\/?)>|([^<]+)|<[?!][^>]*>/g
    ),
  ];
  let i = 0;

  const nextTag = (): { name: string; closing: boolean; empty: boolean } => {
    while (i < tokens.length) {
      const token = tokens[i++];
      if (token[2]) {
        return {
          name: token[2],
          closing: token[1] === '/',
          empty: token[3] === '/',
        };
      }
    }
    throw new Error('plist ended early');
  };
  const text = (name: string): string => {
    let value = '';
    while (i < tokens.length) {
      const token = tokens[i++];
      if (token[4] !== undefined) value += token[4];
      else if (token[2] === name && token[1] === '/')
        return decodeEntities(value);
    }
    throw new Error(`unclosed <${name}>`);
  };

  const value = (tag = nextTag()): PlistValue => {
    switch (tag.name) {
      case 'plist':
        return value();
      case 'dict': {
        const dict: { [key: string]: PlistValue } = {};
        if (tag.empty) return dict;
        for (;;) {
          const next = nextTag();
          if (next.closing && next.name === 'dict') return dict;
          if (next.name !== 'key')
            throw new Error(`<${next.name}> where a key belongs`);
          const key = next.empty ? '' : text('key');
          dict[key] = value();
        }
      }
      case 'array': {
        const array: PlistValue[] = [];
        if (tag.empty) return array;
        for (;;) {
          const next = nextTag();
          if (next.closing && next.name === 'array') return array;
          array.push(value(next));
        }
      }
      case 'string':
      case 'data':
      case 'date':
        return tag.empty ? '' : text(tag.name);
      case 'integer':
      case 'real':
        return tag.empty ? 0 : Number(text(tag.name));
      case 'true':
        return true;
      case 'false':
        return false;
      default:
        throw new Error(`unexpected <${tag.name}>`);
    }
  };

  return value();
}

function decodeEntities(value: string): string {
  return value.replace(
    /&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g,
    (_, hex, decimal, named) => {
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      if (decimal) return String.fromCodePoint(parseInt(decimal, 10));
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[
        named as 'amp' | 'lt' | 'gt' | 'quot' | 'apos'
      ];
    }
  );
}

/**
 * An NSKeyedArchiver archive turned back into plain values: references followed, NSArray and
 * NSDictionary rebuilt, class markers dropped. Depth-limited, because an archive may refer
 * back to itself.
 */
export function unarchive(plist: PlistValue): unknown {
  const archive = plist as { [key: string]: PlistValue };
  const objects = archive.$objects as PlistValue[] | undefined;
  const top = archive.$top as { [key: string]: PlistValue } | undefined;
  if (!Array.isArray(objects) || !top) return undefined;

  const resolve = (value: PlistValue | undefined, depth: number): unknown => {
    if (depth > 24 || value === undefined) return undefined;
    if (isReference(value)) {
      const uid = (value as { [key: string]: PlistValue })['CF$UID'];
      return resolve(objects[uid as number], depth + 1);
    }
    if (value === '$null') return undefined;
    if (Array.isArray(value)) {
      return value.map((item) => resolve(item, depth + 1));
    }
    if (typeof value !== 'object') return value;

    const keys = value['NS.keys'];
    const values = value['NS.objects'];
    if (Array.isArray(keys) && Array.isArray(values)) {
      const dict: Record<string, unknown> = {};
      keys.forEach((key, index) => {
        dict[String(resolve(key, depth + 1))] = resolve(
          values[index],
          depth + 1
        );
      });
      return dict;
    }
    if (Array.isArray(values)) {
      return values.map((item) => resolve(item, depth + 1));
    }
    if (typeof value['NS.string'] === 'string') return value['NS.string'];

    const plain: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key !== '$class') plain[key] = resolve(item as PlistValue, depth + 1);
    }
    return plain;
  };

  return resolve(top.root, 0);
}

/** `{ CF$UID: n }`: a pointer into the archive's object table. */
function isReference(value: PlistValue): boolean {
  return (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value['CF$UID'] === 'number' &&
    Object.keys(value).length === 1
  );
}
