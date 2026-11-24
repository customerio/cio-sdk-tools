import { adb } from './adb';
import { packageStopped } from './device';
import { AppState, StateResult } from '../app_state';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Putting an Android app into a state is easy; putting it into the *right* killed state is
 * the one thing that matters.
 *
 * `am force-stop` leaves the app in Android's stopped state, and a stopped app is not
 * delivered to at all — by design, not by defect. A developer who stops the app from
 * Settings, sends a push, sees nothing, and concludes push is broken is the exact
 * misdiagnosis this tool exists to prevent. `am kill` from the home screen is the faithful
 * "swiped away" case: the process dies and the push revives it.
 */
export async function setAndroidState(
  serial: string,
  packageName: string,
  state: AppState
): Promise<StateResult> {
  // Start from a clean launch so a cell never inherits the previous cell's state.
  await adb(serial, ['shell', 'am', 'force-stop', packageName], 60_000);
  await sleep(1_500);

  const launch = await launchAndroidApp(serial, packageName);
  if (!launch.ok) return launch;
  await sleep(6_000);

  if (state === 'foreground') {
    return { ok: true, how: 'launch (foreground)' };
  }

  if (state === 'background') {
    // A real home press, which is more faithful than anything the iOS simulator offers.
    const homeError = await pressHome(serial);
    if (homeError) {
      return { ok: false, how: 'KEYCODE_HOME', error: homeError };
    }
    await sleep(2_500);
    return { ok: true, how: 'KEYCODE_HOME (background)' };
  }

  // `am kill` ends only a process in the background. Killed straight from the foreground, the
  // app kept running, and the killed push reached a live app.
  const homeError = await pressHome(serial);
  if (homeError) {
    return { ok: false, how: 'KEYCODE_HOME', error: homeError };
  }
  await sleep(2_500);
  await adb(serial, ['shell', 'am', 'kill', packageName], 60_000);
  await sleep(2_500);
  const how =
    'Home, then am kill (killed, not force-stop — a force-stopped app is never delivered to)';
  if (await processRunning(serial, packageName)) {
    return {
      ok: false,
      how,
      error: "the app's process was still running after am kill",
    };
  }
  const stopped = await packageStopped(serial, packageName);
  return {
    ok: true,
    how,
    error:
      stopped === true
        ? 'the package is in the stopped state, which blocks delivery by design'
        : undefined,
  };
}

/**
 * The Home press, with what went wrong when it did not land. A press that failed leaves the
 * app in front, so a push sent next is a foreground push however the cell is labelled.
 */
async function pressHome(serial: string): Promise<string | undefined> {
  const home = await adb(
    serial,
    ['shell', 'input', 'keyevent', 'KEYCODE_HOME'],
    60_000
  );
  if (home.code === 0) return undefined;
  const reason = home.stderr.trim().split('\n')[0] || `exit ${home.code}`;
  return `the Home press failed, so the app may still be in front: ${reason}`;
}

async function processRunning(
  serial: string,
  packageName: string
): Promise<boolean> {
  const { stdout } = await adb(serial, ['shell', 'pidof', packageName]);
  return stdout.trim().length > 0;
}

/**
 * Brings the app to the foreground, starting it if it isn't running, without stopping it
 * first. An app sent to the background has no network on recent Android, so whatever it
 * queued there, a login included, waits until it is opened again.
 */
export async function launchAndroidApp(
  serial: string,
  packageName: string
): Promise<StateResult> {
  // `monkey` launches nothing on some API 35 Play Store images, so resolve the app's launcher
  // activity and start that component explicitly.
  const resolved = await adb(serial, [
    'shell',
    'cmd',
    'package',
    'resolve-activity',
    '--brief',
    '-a',
    'android.intent.action.MAIN',
    '-c',
    'android.intent.category.LAUNCHER',
    packageName,
  ]);
  const component = resolved.stdout.trim().split('\n').pop()?.trim() ?? '';
  if (resolved.code === 0 && component.includes('/')) {
    const started = await adb(serial, [
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.MAIN',
      '-c',
      'android.intent.category.LAUNCHER',
      '-n',
      component,
    ]);
    if (started.code === 0 && !/^Error/m.test(started.stdout)) {
      return { ok: true, how: 'am start launch' };
    }
  }
  const launch = await adb(
    serial,
    [
      'shell',
      'monkey',
      '-p',
      packageName,
      '-c',
      'android.intent.category.LAUNCHER',
      '1',
    ],
    120_000
  );
  return launch.code === 0
    ? { ok: true, how: 'monkey launch' }
    : {
        ok: false,
        how: 'monkey launch',
        error: launch.stderr.trim().split('\n')[0],
      };
}
