import { adb } from '../android/adb';
import { packageStopped } from '../android/device';
import { AppState, StateResult } from './states';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Putting an Android app into a state is easy; putting it into the *right* killed state is
 * the one thing that matters.
 *
 * `am force-stop` leaves the app in Android's stopped state, and a stopped app is not
 * delivered to at all — by design, not by defect. A developer who stops the app from
 * Settings, sends a push, sees nothing, and concludes push is broken is the exact
 * misdiagnosis this tool exists to prevent. `am kill` is the faithful "swiped away" case:
 * the process dies and the push revives it.
 */
export async function setAndroidState(
  serial: string,
  packageName: string,
  state: AppState
): Promise<StateResult> {
  // Start from a clean launch so a cell never inherits the previous cell's state.
  await adb(serial, ['shell', 'am', 'force-stop', packageName], 60_000);
  await sleep(1_500);

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
  if (launch.code !== 0) {
    return {
      ok: false,
      how: 'monkey launch',
      error: launch.stderr.trim().split('\n')[0],
    };
  }
  await sleep(6_000);

  if (state === 'foreground') {
    return { ok: true, how: 'monkey launch (foreground)' };
  }

  if (state === 'background') {
    // A real home press, which is more faithful than anything the iOS simulator offers.
    await adb(serial, ['shell', 'input', 'keyevent', 'KEYCODE_HOME'], 60_000);
    await sleep(2_500);
    return { ok: true, how: 'KEYCODE_HOME (background)' };
  }

  await adb(serial, ['shell', 'am', 'kill', packageName], 60_000);
  await sleep(2_500);
  const stopped = await packageStopped(serial, packageName);
  return {
    ok: true,
    how: 'am kill (killed, not force-stop — a force-stopped app is never delivered to)',
    error:
      stopped === true
        ? 'the package is in the stopped state, which blocks delivery by design'
        : undefined,
  };
}
