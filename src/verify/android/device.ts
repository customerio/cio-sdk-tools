import { adb, prefString, readAppFile } from './adb';

export interface AndroidTarget {
  serial: string;
  model?: string;
  isEmulator: boolean;
  apiLevel?: number;
  state: 'device' | 'offline' | 'unauthorized';
}

export function describeAndroidTarget(target: AndroidTarget): string {
  const api = target.apiLevel ? ` API ${target.apiLevel}` : '';
  return `${target.model ?? target.serial} (${
    target.isEmulator ? 'emulator' : 'device'
  }${api}, ${target.state})`;
}

export async function listAndroidTargets(): Promise<AndroidTarget[]> {
  const { stdout, code } = await adb(undefined, ['devices', '-l'], 60_000);
  if (code !== 0) return [];

  const targets: AndroidTarget[] = [];
  for (const line of stdout.split('\n').slice(1)) {
    const match = line.match(/^(\S+)\s+(device|offline|unauthorized)\b(.*)$/);
    if (!match) continue;
    const serial = match[1];
    const model = match[3].match(/model:(\S+)/)?.[1];
    targets.push({
      serial,
      model,
      // Serial naming is the reliable tell; `ro.kernel.qemu` has moved around between
      // images and is missing on recent ones.
      isEmulator: serial.startsWith('emulator-'),
      state: match[2] as AndroidTarget['state'],
    });
  }

  for (const target of targets) {
    if (target.state !== 'device') continue;
    const api = await adb(target.serial, [
      'shell',
      'getprop',
      'ro.build.version.sdk',
    ]);
    const parsed = Number(api.stdout.trim());
    if (!Number.isNaN(parsed)) target.apiLevel = parsed;
  }

  return targets;
}

export function selectAndroidTarget(
  targets: AndroidTarget[],
  selector?: string
): { target?: AndroidTarget; usable: AndroidTarget[] } {
  // Emulator only for this iteration, and being explicit about that beats silently
  // verifying against whichever phone happens to be plugged in.
  const usable = targets.filter((t) => t.state === 'device' && t.isEmulator);
  if (selector) {
    return {
      target: usable.find((t) => t.serial === selector || t.model === selector),
      usable,
    };
  }
  return { target: usable.length === 1 ? usable[0] : undefined, usable };
}

export async function packageInstalled(
  serial: string,
  packageName: string
): Promise<boolean> {
  const { stdout, code } = await adb(serial, [
    'shell',
    'pm',
    'list',
    'packages',
    packageName,
  ]);
  if (code !== 0) return false;
  return stdout
    .split('\n')
    .some((line) => line.trim() === `package:${packageName}`);
}

/**
 * Android's stopped state, which is the single most misleading thing about testing push
 * here: a force-stopped app is not delivered to at all, by design. A developer who stops
 * the app from Settings and then sends a push sees nothing and concludes push is broken.
 */
export async function packageStopped(
  serial: string,
  packageName: string
): Promise<boolean | undefined> {
  const { stdout, code } = await adb(serial, [
    'shell',
    'dumpsys',
    'package',
    packageName,
  ]);
  if (code !== 0) return undefined;
  const match = stdout.match(/User \d+:[^\n]*stopped=(true|false)/);
  return match ? match[1] === 'true' : undefined;
}

export async function notificationPermission(
  serial: string,
  packageName: string
): Promise<boolean | undefined> {
  const { stdout, code } = await adb(serial, [
    'shell',
    'dumpsys',
    'package',
    packageName,
  ]);
  if (code !== 0) return undefined;
  const match = stdout.match(
    /android\.permission\.POST_NOTIFICATIONS: granted=(true|false)/
  );
  return match ? match[1] === 'true' : undefined;
}

export interface AndroidSdkState {
  deviceToken?: string;
  userId?: string;
  anonymousId?: string;
  siteId?: string;
  writeKey?: string;
  sources: string[];
  error?: string;
}

/**
 * What the SDK recorded on the device.
 *
 * Easier than iOS in every respect: plain XML in two files, both readable with `run-as` on
 * a debuggable build. The token especially has to come from here and never from logcat,
 * which truncates long lines — a clipped FCM token comes back from a send as
 * `FCM_UNREGISTERED`, which reads exactly like a broken integration.
 */
export async function readAndroidSdkState(
  serial: string,
  packageName: string
): Promise<AndroidSdkState> {
  const state: AndroidSdkState = { sources: [] };

  const global = await readAppFile(
    serial,
    packageName,
    `shared_prefs/io.customer.sdk.${packageName}.xml`
  );
  if (global.text) {
    state.sources.push(`io.customer.sdk.${packageName}.xml`);
    state.deviceToken = prefString(global.text, 'device_token');
    const settings = prefString(global.text, 'config_settings');
    if (settings) {
      state.writeKey = safeJson(settings)?.writeKey as string | undefined;
    }
  } else {
    state.error = global.error;
  }

  // The CDP layer keeps identity in its own file, named after the write key.
  const listing = await adb(serial, [
    'shell',
    'run-as',
    packageName,
    'ls',
    `/data/data/${packageName}/shared_prefs`,
  ]);
  const analytics = listing.stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('analytics-android-'));
  if (!analytics) return state;

  const cdp = await readAppFile(
    serial,
    packageName,
    `shared_prefs/${analytics}`
  );
  if (!cdp.text) return state;

  state.sources.push(analytics);
  state.userId = prefString(cdp.text, 'segment.userId');
  state.anonymousId = prefString(cdp.text, 'segment.anonymousId');

  const settings = prefString(cdp.text, 'segment.settings');
  if (settings) {
    const parsed = safeJson(settings);
    const integrations = parsed?.integrations as
      | Record<string, Record<string, string>>
      | undefined;
    for (const value of Object.values(integrations ?? {})) {
      if (value?.siteId) state.siteId = value.siteId;
      if (value?.apiKey && !state.writeKey) state.writeKey = value.apiKey;
    }
  }

  return state;
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
