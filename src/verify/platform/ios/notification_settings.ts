import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scratchDirectory } from '../../core/cleanup';
import { run } from '../../core/exec';
import { PlistValue, parsePlistXml } from './plist';

/** iOS's names for UNAuthorizationStatus, in its own order. */
const STATUS_NAMES = [
  'notDetermined',
  'denied',
  'authorized',
  'provisional',
  'ephemeral',
];

/**
 * What iOS says about an app's notifications on a simulator, read from the simulator's own
 * settings rather than from the app: the answer is there before the app runs, and whether
 * or not its SDK logs at debug.
 *
 * SpringBoard keeps each app's notification settings in
 * `Library/BulletinBoard/VersionedSectionInfo.plist`, one NSKeyedArchiver archive per bundle
 * id, whose `authorizationStatus` is UNAuthorizationStatus's number. An app with no entry
 * has not been seen by the notification system, and nothing is claimed for it.
 */
export async function simulatorNotificationStatus(
  udid: string,
  bundleId: string
): Promise<string | undefined> {
  const file = path.join(
    os.homedir(),
    'Library/Developer/CoreSimulator/Devices',
    udid,
    'data/Library/BulletinBoard/VersionedSectionInfo.plist'
  );
  const settings = await plistXml(file);
  const sections = (settings as { sectionInfo?: Record<string, PlistValue> })
    ?.sectionInfo;
  const archived = sections?.[bundleId];
  if (typeof archived !== 'string') return undefined;

  // The entry is itself a binary plist, which plutil only reads from a file.
  const scratch = await scratchDirectory();
  try {
    const entry = path.join(scratch.path, 'section.plist');
    await fs.writeFile(entry, Buffer.from(archived, 'base64'));
    return authorizationIn(await plistXml(entry));
  } finally {
    await scratch.remove();
  }
}

/** The status in one app's archived settings: the object that carries it, wherever it sits. */
export function authorizationIn(
  archive: PlistValue | undefined
): string | undefined {
  const objects = (archive as { $objects?: PlistValue[] } | undefined)
    ?.$objects;
  if (!Array.isArray(objects)) return undefined;
  for (const object of objects) {
    if (!object || typeof object !== 'object' || Array.isArray(object))
      continue;
    const status = object.authorizationStatus;
    if (typeof status === 'number') {
      return STATUS_NAMES[status] ?? `other(${status})`;
    }
  }
  return undefined;
}

async function plistXml(file: string): Promise<PlistValue | undefined> {
  const { stdout, code } = await run(
    'plutil',
    ['-convert', 'xml1', '-o', '-', file],
    15_000
  );
  if (code !== 0) return undefined;
  try {
    return parsePlistXml(stdout);
  } catch {
    return undefined;
  }
}
