const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** `adb devices -l` is played from the environment, one list per test. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-adb-pick-'));
fs.writeFileSync(
  path.join(dir, 'adb'),
  `#!/bin/sh
case "$*" in
  *"devices -l"*) printf 'List of devices attached\\n%b' "$FAKE_DEVICES"; exit 0 ;;
  *getprop*) echo 35; exit 0 ;;
esac
exit 0
`,
  { mode: 0o755 }
);
process.env.PATH = `${dir}:${process.env.PATH}`;

const { chooseAndroidTarget } = require('../../dist/verify/platform/select');
const { dnsResolved } = require('../../dist/verify/platform/android/device');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const USABLE = 'emulator-5554\\tdevice product:sdk model:Pixel_7 device:emu\\n';
const UNAUTHORIZED = 'R5CT12345\\tunauthorized transport_id:2\\n';
const OFFLINE = 'emulator-5556\\toffline\\n';

const noQuestions = {
  select: async () => assert.fail('a question was asked'),
};
const pick = (devices, target) => {
  process.env.FAKE_DEVICES = devices;
  return chooseAndroidTarget({ cio: {}, asker: noQuestions, target });
};

test('the one usable device is taken without a question, whatever else is attached', async () => {
  const picked = await pick(USABLE + UNAUTHORIZED + OFFLINE);
  assert.strictEqual(picked.id, 'emulator-5554');
  assert.strictEqual(picked.source, 'only one');
});

test('a lone unauthorized or offline device is not a target', async () => {
  assert.deepStrictEqual(await pick(UNAUTHORIZED), {});
  assert.deepStrictEqual(await pick(OFFLINE), {});
});

test('only usable devices are offered when several can be picked', async () => {
  process.env.FAKE_DEVICES =
    USABLE + 'emulator-5560\\tdevice model:Pixel_8\\n' + UNAUTHORIZED;
  let offered;
  const picked = await chooseAndroidTarget({
    cio: {},
    asker: {
      select: async (_question, options) => {
        offered = options.map((option) => option.value.serial);
        return options[1].value;
      },
    },
  });
  assert.deepStrictEqual(offered, ['emulator-5554', 'emulator-5560']);
  assert.strictEqual(picked.id, 'emulator-5560');
});

test('--device takes a model name and hands back the serial', async () => {
  const picked = await pick(USABLE, 'Pixel_7');
  assert.strictEqual(picked.selector, 'emulator-5554');
  assert.strictEqual(picked.id, 'emulator-5554');
  assert.strictEqual(picked.name, 'Pixel_7');
  // An unknown name is passed through for the run to report.
  assert.strictEqual((await pick(USABLE, 'nope')).selector, 'nope');
});

test('DNS is judged by the name resolving, not by a ping reply', () => {
  const resolved =
    'PING fcm.googleapis.com (142.250.1.95) 56(84) bytes of data.\n\n--- 1 packets transmitted, 0 received, 100% packet loss';
  assert.strictEqual(dnsResolved(resolved, '', 1), true);
  assert.strictEqual(dnsResolved('1 packets received', '', 0), true);
  assert.strictEqual(
    dnsResolved('', 'ping: unknown host fcm.googleapis.com', 2),
    false
  );
  assert.strictEqual(dnsResolved('', '', 1), false);
});
