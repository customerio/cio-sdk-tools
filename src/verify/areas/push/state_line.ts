import { LogCapture, LogLine } from '../../platform/logs';
import { findProfile } from '../../platform/cio/profile';
import { SdkStateLine, latestSdkState } from '../../platform/sdk_events';
import { Target } from '../../platform/ios/device';
import { SDK_SUBSYSTEM_PREDICATE, startCapture } from '../../platform/ios/logs';
import { setAppState } from '../../platform/ios/app_state';
import { adb } from '../../platform/android/adb';
import { startAndroidCapture } from '../../platform/android/logcat';
import {
  launchAndroidApp,
  setAndroidState,
} from '../../platform/android/app_state';

/** Long enough for a React Native or Flutter app to start its runtime and initialize. */
const STATE_LINE_TIMEOUT_MS = 20_000;

/**
 * The SDK's own account of itself, for when its stores can't be read: it writes an
 * `sdk.state` line each time it starts, so the app is started again and the line read from
 * the log. Only an SDK with the verify contract writes one; an older one leaves nothing, and
 * the wait is the whole cost.
 */
export async function readIosStateLine(
  target: Target,
  bundleId: string,
  executableName?: string
): Promise<SdkStateLine | undefined> {
  // Without the app's executable name the log can't be narrowed to this app, and another
  // app's SDK writes the same line. Its user and token would be taken for this app's.
  if (!executableName) return undefined;
  const capture = await startCapture(target, undefined, {
    processes: executableName ? [executableName] : [],
    predicate: SDK_SUBSYSTEM_PREDICATE,
  });
  return readAfter(capture, async () => {
    await setAppState(target, bundleId, 'killed', executableName);
    await setAppState(target, bundleId, 'foreground', executableName);
  });
}

export async function readAndroidStateLine(
  serial: string,
  packageName: string
): Promise<SdkStateLine | undefined> {
  const capture = await startAndroidCapture(serial);
  // Every app's SDK writes this line into one shared log. A line counts only when the
  // process that wrote it is this package's, and a process is this package's when `pidof`
  // says so while the line is being waited for.
  const pids = new Set<string>();
  return readAfter(
    capture,
    async () => {
      await setAndroidState(serial, packageName, 'killed');
      await launchAndroidApp(serial, packageName);
    },
    async () => {
      for (const pid of await appPids(serial, packageName)) pids.add(pid);
      return (line) => line.pid !== undefined && pids.has(line.pid);
    }
  );
}

async function appPids(serial: string, packageName: string): Promise<string[]> {
  const { stdout, code } = await adb(serial, ['shell', 'pidof', packageName]);
  return code === 0 ? stdout.trim().split(/\s+/).filter(Boolean) : [];
}

export async function readAfter(
  capture: LogCapture,
  restart: () => Promise<void>,
  /** Says which lines are the app's own, where the log mixes apps. */
  belongs?: () => Promise<(line: LogLine) => boolean>,
  timeoutMs = STATE_LINE_TIMEOUT_MS
): Promise<SdkStateLine | undefined> {
  try {
    if (!capture.available) return undefined;
    // A stream that has not attached yet misses the launch it is meant to read.
    await sleep(2_000);
    const mark = capture.mark();
    await restart();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const own = belongs ? await belongs() : undefined;
      const lines = capture.since(mark);
      const line = latestSdkState(own ? lines.filter(own) : lines);
      if (line) return line;
      await sleep(500);
    }
    return undefined;
  } finally {
    await capture.stop();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The token Customer.io holds for this app on the user's profile, for when the device's own
 * store can't be read. Only when there is exactly one device for this platform and app: with
 * two, one is stale, and the run's pushes could go to a phone that isn't there.
 */
export async function profileToken(
  environmentId: string,
  userId: string,
  platform: 'ios' | 'android',
  appIdentifier?: string
): Promise<string | undefined> {
  const profile = await findProfile(environmentId, userId).catch(() => null);
  const devices = (profile?.devices ?? []).filter(
    (device) =>
      device.platform === platform &&
      (!appIdentifier ||
        !device.appIdentifier ||
        device.appIdentifier === appIdentifier)
  );
  return devices.length === 1 ? devices[0].id : undefined;
}
