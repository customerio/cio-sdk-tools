import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readPlist, run } from '../../core/exec';

export type TargetKind = 'simulator' | 'device';

export interface Target {
  kind: TargetKind;
  name: string;
  udid: string;
  osVersion?: string;
  /**
   * `booted` for a running simulator. For a phone, `connected` while its developer tunnel is
   * up and `available` when it is paired and reachable but the tunnel is idle — it opens on
   * the first command, and it idles between uses even on a cable.
   */
  state: 'booted' | 'connected' | 'available' | 'shutdown' | 'unavailable';
  /** How a phone is reached. Logs need USB: libimobiledevice does not read them over Wi-Fi. */
  transport?: 'usb' | 'wifi';
}

export function isUsable(target: Target): boolean {
  return ['booted', 'connected', 'available'].includes(target.state);
}

/** A phone is labelled by how it is reached; its tunnel's momentary state means nothing. */
export function describeTarget(target: Target): string {
  const version = target.osVersion ? ` iOS ${target.osVersion}` : '';
  const how =
    target.kind === 'device' && target.transport
      ? target.transport === 'usb'
        ? 'USB'
        : 'Wi-Fi'
      : target.state;
  return `${target.name} (${target.kind}${version}, ${how})`;
}

/**
 * Whether a phone `devicectl` lists can be used, from its connection properties. The tunnel
 * state alone said "unavailable" for a phone plugged in by cable whose tunnel had idled, so
 * it was left out of the picker while `--target` with its udid worked. A paired phone with a
 * transport is reachable; one without is not there.
 */
export function deviceReachability(connection?: {
  tunnelState?: string;
  pairingState?: string;
  transportType?: string;
}): Pick<Target, 'state' | 'transport'> {
  const transport =
    connection?.transportType === 'wired'
      ? 'usb'
      : connection?.transportType === 'localNetwork'
      ? 'wifi'
      : undefined;
  if (connection?.tunnelState === 'connected') {
    return { state: 'connected', transport };
  }
  if (
    connection?.pairingState === 'paired' &&
    transport &&
    connection.tunnelState !== 'unavailable'
  ) {
    return { state: 'available', transport };
  }
  return { state: 'unavailable', transport };
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
        ...deviceReachability(connection),
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
  /** The installed bundle, when it is readable locally (simulators only). */
  appPath?: string;
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

/**
 * The useful line of a failed `simctl` command. Its first line is always the same header —
 * "An error was encountered processing the command (domain=…, code=…):" — and the reason
 * comes after it. A missing app container is POSIX error 2, which only ever means the app
 * is not installed, so it is said plainly.
 */
export function simctlError(stderr: string): string | undefined {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  if (/NSPOSIXErrorDomain, code=2\b/.test(lines[0])) {
    return 'simctl has no app with this bundle id on this simulator';
  }
  return lines[lines.length - 1];
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
    return { installed: false, error: simctlError(stderr) };
  }

  const bundle = await run(
    'xcrun',
    ['simctl', 'get_app_container', target.udid, bundleId, 'app'],
    60_000
  );

  return {
    installed: true,
    appPath: bundle.code === 0 ? bundle.stdout.trim() : undefined,
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

/**
 * The entitlements of the build that is actually installed.
 *
 * Rung 1 proves the *project* asks for push; this proves the binary on the target does. The
 * two come apart in a way that is silent and total: a build made with
 * `CODE_SIGNING_ALLOWED=NO` carries no entitlements at all, APNs refuses to issue a token,
 * and the SDK deletes the one it had — while its stored copy stays on disk looking healthy.
 *
 * On a simulator the entitlements live in the binary's own `__TEXT,__entitlements` section
 * rather than in a signature, which is why `codesign -d --entitlements` comes back empty
 * for a perfectly good simulator build.
 */
export async function installedEntitlements(
  appPath: string
): Promise<Record<string, string> | undefined> {
  // Absent `undefined` versus empty `{}` is the whole point of this signature: see below.
  const info = await readPlist<{ CFBundleExecutable?: string }>(
    path.join(appPath, 'Info.plist')
  );
  const executable = info?.CFBundleExecutable;
  if (!executable) return undefined;

  const { stdout, code } = await run(
    'otool',
    ['-X', '-s', '__TEXT', '__entitlements', path.join(appPath, executable)],
    60_000
  );
  // `undefined` means the question could not be asked; `{}` means it was asked and the
  // binary carries no entitlements at all. Collapsing the two turns a build that cannot
  // register into a check that quietly skips.
  if (code !== 0) return undefined;

  const text = stdout.trim() ? decodeOtoolSection(stdout) : '';
  if (!text.includes('<plist')) return {};

  // A handful of string values is all this is for; a full plist parse would mean writing
  // the section out to a temp file for plutil, and nothing here needs the rest of it.
  const entitlements: Record<string, string> = {};
  for (const match of text.matchAll(
    /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g
  )) {
    entitlements[match[1]] = match[2];
  }
  return entitlements;
}

/** `otool -X -s` prints little-endian hex words, four to a line, after an address column. */
function decodeOtoolSection(stdout: string): string {
  const bytes: number[] = [];
  for (const line of stdout.split('\n')) {
    const words = line.trim().split(/\s+/).slice(1);
    for (const word of words) {
      if (!/^[0-9a-f]{8}$/i.test(word)) continue;
      for (let i = 6; i >= 0; i -= 2) {
        bytes.push(parseInt(word.slice(i, i + 2), 16));
      }
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

export interface Freshness {
  installedAt?: Date;
  storeWrittenAt?: Date;
  /** True when the SDK's store predates the installed bundle. */
  tokenPredatesInstall: boolean;
}

/**
 * Whether the token on disk belongs to the build being verified.
 *
 * A reinstall gives the app a new bundle and leaves its container alone, so the stored
 * token can be older than the binary it is supposed to belong to — and a dead token reads
 * exactly like a live one.
 */
export async function tokenFreshness(
  appPath: string | undefined,
  preferencesDirectory: string,
  bundleId: string
): Promise<Freshness> {
  const installedAt = appPath
    ? (await fs.stat(appPath).catch(() => undefined))?.mtime
    : undefined;
  // The newest of the SDK's own store and the CDP layer's store, because the SDK rewrites
  // its file only when the token actually changes: re-registering with the same token
  // leaves it untouched, and comparing that alone warns about every reinstall forever.
  const entries = await fs.readdir(preferencesDirectory).catch(() => []);
  const written = entries.filter(
    (entry: string) =>
      entry === `io.customer.sdk.${bundleId}.shared.plist` ||
      entry.startsWith('com.segment.storage.')
  );
  const times = (
    await Promise.all(
      written.map((entry: string) =>
        fs
          .stat(path.join(preferencesDirectory, entry))
          .then((stat) => stat.mtime)
          .catch(() => undefined)
      )
    )
  ).filter((time): time is Date => Boolean(time));
  const storeWrittenAt = times.length
    ? new Date(Math.max(...times.map((time) => time.getTime())))
    : undefined;

  return {
    installedAt,
    storeWrittenAt,
    tokenPredatesInstall: Boolean(
      installedAt && storeWrittenAt && storeWrittenAt < installedAt
    ),
  };
}
