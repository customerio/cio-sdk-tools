const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * `adb` is played by a script on PATH that records its calls and answers from the
 * environment: whether the Home press lands, and what the device's log holds.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-adb-capture-'));
const log = path.join(dir, 'calls.log');
fs.writeFileSync(
  path.join(dir, 'adb'),
  `#!/bin/sh
echo "$@" >> "${log}"
case "$*" in
  *KEYCODE_HOME*)
    if [ "$FAKE_HOME" = fail ]; then echo 'error: device offline' >&2; exit 1; fi
    exit 0 ;;
  *"shell date"*) printf '11-24_10:00:00.000\\n'; exit 0 ;;
  *"logcat"*)
    printf '11-24 10:00:01.000 I/CIO-SDK( 100): sdk line\\n'
    printf '11-24 10:00:01.500 I/OtherApp( 200): someone else\\n'
    exec sleep 4 ;;
  *pidof*) exit 1 ;;
  *resolve-activity*) printf 'com.example.app/.Main\\n'; exit 0 ;;
  *"am start"*) echo "Starting: Intent { cmp=com.example.app/.Main }"; exit 0 ;;
esac
exit 0
`,
  { mode: 0o755 }
);
process.env.PATH = `${dir}:${process.env.PATH}`;

const { setAndroidState } = require('../../dist/verify/platform/android/app_state');
const { startAndroidCapture } = require('../../dist/verify/platform/android/logcat');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a Home press that fails leaves the background setup unproven', async () => {
  process.env.FAKE_HOME = 'fail';
  const result = await setAndroidState('SER', 'com.example.app', 'background');
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /Home press failed.*device offline/);
});

test('a Home press that fails leaves the killed setup unproven', async () => {
  process.env.FAKE_HOME = 'fail';
  const result = await setAndroidState('SER', 'com.example.app', 'killed');
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /Home press failed/);
});

test('the capture leaves the device log alone and keeps other apps out of the evidence', async () => {
  fs.writeFileSync(log, '');
  const evidence = path.join(dir, 'evidence');
  const capture = await startAndroidCapture('SER', evidence);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await capture.stop();

  const calls = fs.readFileSync(log, 'utf8');
  assert.doesNotMatch(calls, /logcat -c/);
  assert.match(calls, /logcat -v time -T 11-24 10:00:00\.000/);

  assert.strictEqual(capture.lines.length, 1);
  const written = fs.readFileSync(path.join(evidence, 'android-SER.log'), 'utf8');
  assert.match(written, /sdk line/);
  assert.doesNotMatch(written, /someone else/);
});
