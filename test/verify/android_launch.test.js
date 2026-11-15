const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * `monkey` launches nothing on some API 35 Play Store emulator images, so the launch starts
 * the app's resolved launcher component. These tests play `adb` with a script on PATH: it
 * records every call and answers from the environment, so each test chooses what the device
 * says.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-adb-'));
const log = path.join(dir, 'calls.log');
fs.writeFileSync(
  path.join(dir, 'adb'),
  `#!/bin/sh
echo "$@" >> "${log}"
case "$*" in
  *resolve-activity*)
    if [ "$FAKE_RESOLVE" = component ]; then
      printf 'priority=0 preferredOrder=0 match=0x108000\\ncom.example.app/.ui.MainActivity\\n'
    else
      printf 'No activity found\\n'
    fi
    exit 0 ;;
  *"am start"*)
    if [ "$FAKE_START" = ok ]; then
      echo "Starting: Intent { cmp=com.example.app/.ui.MainActivity }"
    else
      echo "Error: Activity not started, unable to resolve Intent"
    fi
    exit 0 ;;
  *monkey*)
    if [ "$FAKE_MONKEY" = ok ]; then exit 0; fi
    echo "args: [-p, com.example.app]" >&2
    exit 251 ;;
esac
exit 0
`,
  { mode: 0o755 }
);
process.env.PATH = `${dir}:${process.env.PATH}`;

const { launchAndroidApp } = require('../../dist/verify/platform/android/app_state');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function device(env) {
  fs.writeFileSync(log, '');
  Object.assign(
    process.env,
    { FAKE_RESOLVE: 'none', FAKE_START: 'error', FAKE_MONKEY: 'fail' },
    env
  );
}

const calls = () =>
  fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);

test('starts the resolved launcher component and never calls monkey', async () => {
  device({ FAKE_RESOLVE: 'component', FAKE_START: 'ok' });
  const result = await launchAndroidApp('emulator-5554', 'com.example.app');
  assert.deepStrictEqual(result, { ok: true, how: 'am start launch' });
  const all = calls();
  assert.ok(
    all.some((c) => c.includes('am start') && c.includes('-n com.example.app/.ui.MainActivity')),
    'started the component by name'
  );
  assert.ok(!all.some((c) => c.includes('monkey')), 'monkey was not needed');
  assert.ok(all.every((c) => c.startsWith('-s emulator-5554 ')), 'every call named the device');
});

test('falls back to monkey when the launcher component cannot be resolved', async () => {
  device({ FAKE_RESOLVE: 'none', FAKE_MONKEY: 'ok' });
  const result = await launchAndroidApp('emulator-5554', 'com.example.app');
  assert.deepStrictEqual(result, { ok: true, how: 'monkey launch' });
  assert.ok(!calls().some((c) => c.includes('am start')), 'no start without a component');
});

test('falls back to monkey when starting the component is refused', async () => {
  device({ FAKE_RESOLVE: 'component', FAKE_START: 'error', FAKE_MONKEY: 'ok' });
  const result = await launchAndroidApp('emulator-5554', 'com.example.app');
  assert.deepStrictEqual(result, { ok: true, how: 'monkey launch' });
});

test('fails with monkey’s first error line when nothing can launch the app', async () => {
  device({ FAKE_RESOLVE: 'component', FAKE_START: 'error', FAKE_MONKEY: 'fail' });
  const result = await launchAndroidApp('emulator-5554', 'com.example.app');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.how, 'monkey launch');
  assert.match(result.error, /args: \[-p, com\.example\.app\]/);
});
