import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { run } from '../exec';

export type TargetKind = 'simulator' | 'device';

export interface Target {
  kind: TargetKind;
  name: string;
  udid: string;
  osVersion?: string;
  /** `booted` for a running simulator, `connected` for a reachable phone. */
  state: 'booted' | 'connected' | 'shutdown' | 'unavailable';
}

export function isUsable(target: Target): boolean {
  return target.state === 'booted' || target.state === 'connected';
}

export function describeTarget(target: Target): string {
  const version = target.osVersion ? ` iOS ${target.osVersion}` : '';
  return `${target.name} (${target.kind}${version}, ${target.state})`;
}

/**
 * Simulators and phones come from two different tools, and `devicectl` lists both — so the
 * simulator list is what separates them. Classifying by transport or by the absence of a
 * serial number guesses; a udid that `simctl` knows about is a simulator, definitively.
 */
export async function listTargets(): Promise<Target[]> {
  const simulators = await listSimulators();
  const simulatorIds = new Set(simulators.map((s) => s.udid));
  const devices = (await listPhysicalDevices()).filter(
    (d) => !simulatorIds.has(d.udid)
  );
  return [...simulators, ...devices];
}

async function listSimulators(): Promise<Target[]> {
  const { stdout, code } = await run(
    'xcrun',
    ['simctl', 'list', 'devices', '--json'],
    60_000
  );
  if (code !== 0) return [];
  try {
    const parsed = JSON.parse(stdout) as {
      devices: Record<string, Record<string, unknown>[]>;
    };
    const out: Target[] = [];
    for (const runtime of Object.keys(parsed.devices)) {
      // Runtime identifiers read `com.apple.CoreSimulator.SimRuntime.iOS-18-0`.
      const version = runtime
        .split('.')
        .pop()
        ?.replace(/^iOS-/, '')
        .replace(/-/g, '.');
      for (const device of parsed.devices[runtime]) {
        if (device.isAvailable === false) continue;
        out.push({
          kind: 'simulator',
          name: String(device.name ?? ''),
          udid: String(device.udid ?? ''),
          osVersion: version,
          state: device.state === 'Booted' ? 'booted' : 'shutdown',
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function listPhysicalDevices(): Promise<Target[]> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'cio-verify-'));
  const output = path.join(scratch, 'devices.json');
  const { code } = await run(
    'xcrun',
    ['devicectl', 'list', 'devices', '--json-output', output],
    90_000
  );
  if (code !== 0) return [];

  const text = await fs.readFile(output, 'utf8').catch(() => undefined);
  await fs.rm(scratch, { recursive: true, force: true });
  if (!text) return [];

  try {
    const parsed = JSON.parse(text) as {
      result?: { devices?: Record<string, never>[] };
    };
    return (parsed.result?.devices ?? []).map((entry) => {
      const properties = (entry as Record<string, never>)
        .deviceProperties as unknown as Record<string, string>;
      const hardware = (entry as Record<string, never>)
        .hardwareProperties as unknown as Record<string, string>;
      const connection = (entry as Record<string, never>)
        .connectionProperties as unknown as Record<string, string>;
      return {
        kind: 'device' as TargetKind,
        name: properties?.name ?? '',
        udid: hardware?.udid ?? '',
        osVersion: properties?.osVersionNumber,
        state:
          connection?.tunnelState === 'connected' ? 'connected' : 'unavailable',
      };
    });
  } catch {
    return [];
  }
}

/**
 * Pick the target to verify against.
 *
 * With nothing named, a single usable target is chosen silently and several are refused —
 * verifying against the wrong phone is worse than asking.
 */
export function selectTarget(
  targets: Target[],
  selector?: string
): { target?: Target; usable: Target[]; ambiguous: Target[] } {
  const usable = targets.filter(isUsable);

  if (selector) {
    const wanted = targets.filter(
      (t) =>
        t.udid === selector ||
        t.name === selector ||
        t.name.toLowerCase() === selector.toLowerCase()
    );
    return { target: wanted[0], usable, ambiguous: wanted.slice(1) };
  }

  if (usable.length === 1) return { target: usable[0], usable, ambiguous: [] };
  return { usable, ambiguous: usable };
}

export interface AppLocation {
  installed: boolean;
  /** Local directory holding the app's `Library/Preferences`, copied if need be. */
  preferences?: string;
  /** Removes anything this call copied off a device. */
  cleanup?: () => Promise<void>;
  error?: string;
}

export async function locateApp(
  target: Target,
  bundleId: string
): Promise<AppLocation> {
  return target.kind === 'simulator'
    ? locateSimulatorApp(target, bundleId)
    : locateDeviceApp(target, bundleId);
}

async function locateSimulatorApp(
  target: Target,
  bundleId: string
): Promise<AppLocation> {
  const { stdout, code, stderr } = await run(
    'xcrun',
    ['simctl', 'get_app_container', target.udid, bundleId, 'data'],
    60_000
  );
  if (code !== 0) {
    return { installed: false, error: stderr.trim().split('\n')[0] };
  }
  return {
    installed: true,
    preferences: path.join(stdout.trim(), 'Library', 'Preferences'),
  };
}

async function locateDeviceApp(
  target: Target,
  bundleId: string
): Promise<AppLocation> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'cio-verify-'));
  const cleanup = () => fs.rm(scratch, { recursive: true, force: true });

  const listing = path.join(scratch, 'apps.json');
  const apps = await run(
    'xcrun',
    [
      'devicectl',
      'device',
      'info',
      'apps',
      '--device',
      target.udid,
      '--json-output',
      listing,
    ],
    180_000
  );
  if (apps.code !== 0) {
    await cleanup();
    return {
      installed: false,
      error:
        apps.stderr.trim().split('\n')[0] || 'devicectl could not list apps',
    };
  }

  const text = await fs.readFile(listing, 'utf8').catch(() => '');
  if (!text.includes(bundleId)) {
    await cleanup();
    return { installed: false };
  }

  // The SDK's stores live in the app's own data container, which is readable for a
  // development build. Copying the whole Preferences directory is one round trip.
  const destination = path.join(scratch, 'pulled');
  await fs.mkdir(destination, { recursive: true });
  const copy = await run(
    'xcrun',
    [
      'devicectl',
      'device',
      'copy',
      'from',
      '--device',
      target.udid,
      '--domain-type',
      'appDataContainer',
      '--domain-identifier',
      bundleId,
      '--source',
      'Library/Preferences',
      '--destination',
      destination,
    ],
    240_000
  );
  if (copy.code !== 0) {
    return {
      installed: true,
      cleanup,
      error:
        copy.stderr.trim().split('\n')[0] ||
        'the app data container could not be read (is this a development build?)',
    };
  }

  // devicectl copies the *contents* of the source directory into the destination, with no
  // `Preferences` level of its own. Reading the level that isn't there produces a confident
  // "the SDK has no token" about a device holding one, so both shapes are accepted.
  const nested = path.join(destination, 'Preferences');
  const preferences = (
    await fs.stat(nested).catch(() => undefined)
  )?.isDirectory()
    ? nested
    : destination;

  return { installed: true, preferences, cleanup };
}

export interface DeviceSdkState {
  pushDeviceToken?: string;
  userId?: string;
  anonymousId?: string;
  /** From the SDK's server-issued settings: the one link from this build to a workspace. */
  siteId?: string;
  cdpApiKey?: string;
  /** Files the values came from, for the report's evidence. */
  sources: string[];
}

/**
 * Read what the SDK itself recorded on the device.
 *
 * The push token lives in `io.customer.sdk.<bundle id>.shared`, the identity in the CDP
 * layer's own `com.segment.storage.<write key>` store, and the workspace's siteId inside a
 * nested binary plist in that same store. Three different files, none of them documented,
 * all of them the only local truth about what the SDK believes.
 */
export async function readSdkState(
  preferencesDirectory: string,
  bundleId: string
): Promise<DeviceSdkState> {
  const state: DeviceSdkState = { sources: [] };

  const sharedStore = path.join(
    preferencesDirectory,
    `io.customer.sdk.${bundleId}.shared.plist`
  );
  const token = await plistString(sharedStore, 'pushDeviceToken');
  if (token) {
    state.pushDeviceToken = token;
    state.sources.push(path.basename(sharedStore));
  }

  const entries = await fs.readdir(preferencesDirectory).catch(() => []);
  const cdpStore = entries.find(
    (entry) =>
      entry.startsWith('com.segment.storage.') && entry.endsWith('.plist')
  );
  if (!cdpStore) return state;

  const cdpPath = path.join(preferencesDirectory, cdpStore);
  state.sources.push(cdpStore);
  state.userId = await plistString(cdpPath, 'segment\\.userId');
  state.anonymousId = await plistString(cdpPath, 'segment\\.anonymousId');

  const settings = await nestedPlist(cdpPath, 'segment\\.settings');
  if (settings) {
    state.siteId = settings.match(/"siteId"\s*=>\s*"([^"]+)"/)?.[1];
    state.cdpApiKey = settings.match(/"apiKey"\s*=>\s*"([^"]+)"/)?.[1];
  }

  return state;
}

/**
 * `plutil -convert json` refuses any plist holding a date or a decimal, and both of these
 * stores hold one — so values are extracted one key at a time instead. A key containing a
 * dot has to be escaped, or plutil reads it as a path into a nested dictionary.
 */
async function plistString(
  file: string,
  keyPath: string
): Promise<string | undefined> {
  const { stdout, code } = await run(
    'plutil',
    ['-extract', keyPath, 'raw', '-o', '-', file],
    30_000
  );
  if (code !== 0) return undefined;
  const value = stdout.trim();
  return value.length > 0 ? value : undefined;
}

/**
 * The SDK's settings are a binary plist stored as a data value inside another plist, and
 * `plutil` will not reach through that. Extracted as base64, decoded, and dumped — the dump
 * is then read as text, because the nested plist also carries an NSDecimalNumber that no
 * JSON conversion accepts.
 */
async function nestedPlist(
  file: string,
  keyPath: string
): Promise<string | undefined> {
  const base64 = await plistString(file, keyPath);
  if (!base64) return undefined;

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'cio-verify-'));
  const nested = path.join(scratch, 'nested.plist');
  try {
    await fs.writeFile(nested, Buffer.from(base64, 'base64'));
    const { stdout, code } = await run('plutil', ['-p', nested], 30_000);
    return code === 0 ? stdout : undefined;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
