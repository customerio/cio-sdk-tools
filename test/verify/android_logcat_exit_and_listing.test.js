const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * `adb` is played by a script on PATH: a logcat that dies partway through the run, and an
 * app directory that only the root shell can list.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-adb-exit-'));
fs.writeFileSync(
  path.join(dir, 'adb'),
  `#!/bin/sh
case "$*" in
  *"shell date"*) printf '11-24_10:00:00.000\\n'; exit 0 ;;
  *logcat*)
    printf '11-24 10:00:01.000 I/CIO-SDK( 100): sdk line\\n'
    if [ "$FAKE_LOGCAT" = dies ]; then sleep 1.6; exit 3; fi
    exec sleep 4 ;;
  *"run-as"*"cat"*)
    printf '<map><string name="config_settings">{&quot;writeKey&quot;:&quot;WK&quot;}</string></map>'; exit 0 ;;
  *"run-as"*" ls "*) echo 'run-as: Could not stat' >&2; exit 1 ;;
  *"su 0 ls"*) printf 'analytics-android-WK.xml\\nio.customer.sdk.com.example.app.xml\\n'; exit 0 ;;
esac
exit 0
`,
  { mode: 0o755 }
);
process.env.PATH = `${dir}:${process.env.PATH}`;

const { startAndroidCapture } = require('../../dist/verify/platform/android/logcat');
const { readAndroidSdkState } = require('../../dist/verify/platform/android/device');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a logcat that dies after it started says so, instead of reading as a quiet stream', async () => {
  process.env.FAKE_LOGCAT = 'dies';
  const capture = await startAndroidCapture('SER');
  assert.strictEqual(capture.available, true);
  assert.strictEqual(capture.stoppedReason(), undefined);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.match(capture.stoppedReason(), /adb logcat exited \(3\) partway through the run/);
  await capture.stop();
});

test('a logcat that this tool stops is not reported as having died', async () => {
  process.env.FAKE_LOGCAT = 'lives';
  const capture = await startAndroidCapture('SER');
  await capture.stop();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.strictEqual(capture.stoppedReason(), undefined);
});

test('the CDP store is listed through the root shell when run-as cannot list the directory', async () => {
  const state = await readAndroidSdkState('SER', 'com.example.app');
  assert.strictEqual(state.stores.cdp, true);
  assert.ok(state.sources.includes('analytics-android-WK.xml'));
});
