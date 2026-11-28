const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { withLocatedApp } = require('../../dist/verify/areas/push/ios_flow');
const { pathStamp, localStamp, evidenceDirectoryFor } = require('../../dist/verify/areas/push/options');
const { selectTarget } = require('../../dist/verify/platform/ios/device');

test("the container copy of a polled app is released after every use, even when reading it throws", async () => {
  let released = 0;
  const located = { installed: true, cleanup: async () => void released++ };
  assert.strictEqual(await withLocatedApp(async () => located, async () => 'state'), 'state');
  assert.strictEqual(await withLocatedApp(async () => located, async () => undefined), undefined);
  await assert.rejects(
    withLocatedApp(async () => located, async () => {
      throw new Error('plist unreadable');
    }),
    /plist unreadable/
  );
  assert.strictEqual(released, 3);
  // A target with nothing to release is fine.
  assert.strictEqual(await withLocatedApp(async () => ({}), async () => 1), 1);
});

test('the default evidence folder name carries no colon, which Windows refuses in a path', () => {
  const at = new Date(2026, 9, 15, 23, 15, 6);
  assert.strictEqual(localStamp(at), '2026-10-15T23:15:06');
  assert.strictEqual(pathStamp(at), '2026-10-15T23-15-06');
  assert.match(path.basename(evidenceDirectoryFor({})), /^cio-verify-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d$/);
});

test('a --device name typed in other letters still finds the simulator to observe', () => {
  const targets = [{ kind: 'simulator', name: 'iPhone 16', udid: 'U1', state: 'booted' }];
  assert.strictEqual(selectTarget(targets, 'iphone 16').target?.udid, 'U1');
});

test('a run counts as sending only when it holds everything a send needs', () => {
  const { sendsPlanned } = require('../../dist/verify/areas/push/android_flow');
  const ready = { send: true, serial: 'S', packageName: 'com.example.app', environmentId: '1', token: 'tok' };
  assert.strictEqual(sendsPlanned(ready), true);
  // The profile's token is never sent to, so the flow passes none and nothing is sent.
  assert.strictEqual(sendsPlanned({ ...ready, token: undefined }), false);
  assert.strictEqual(sendsPlanned({ ...ready, environmentId: undefined }), false);
  assert.strictEqual(sendsPlanned({ ...ready, dryRun: true }), false);
  assert.strictEqual(sendsPlanned({ ...ready, send: false }), false);
});

test('--watch-registration on Android watches the serial the device name resolves to', async () => {
  const device = require('../../dist/verify/platform/android/device');
  const logcat = require('../../dist/verify/platform/android/logcat');
  const wiring = require('../../dist/verify/areas/push/registration/android_wiring');
  const { climbAndroid } = require('../../dist/verify/areas/push/android_flow');
  const { Ladder } = require('../../dist/verify/core/report/ladder');
  device.listAndroidTargets = async () => [
    { serial: 'emulator-5554', model: 'Pixel 8', state: 'device' },
  ];
  wiring.androidWiring = async () => ({
    rung: { id: 'project_wiring', title: 'Project wiring', checks: [] },
    model: { appModuleName: 'app' },
    applicationId: 'io.example.app',
  });
  const watched = [];
  logcat.startAndroidCapture = async (serial) => {
    watched.push(serial);
    throw new Error('stop here');
  };
  const handle = { phase() {}, done() {} };
  const reporter = { rung: () => handle };
  const run = (targetSelector) =>
    climbAndroid(new Ladder(), '/project', { observe: true }, reporter, {}, { targetSelector }, {});
  await assert.rejects(run('Pixel 8'), /stop here/);
  assert.deepStrictEqual(watched, ['emulator-5554']);
  // A name no device answers to is not handed to adb as a serial: the watch is skipped, and
  // the device rung says what matched.
  watched.length = 0;
  await run('Pixel 9').catch(() => {});
  assert.deepStrictEqual(watched, []);
});

test('a registration run that watches gets an evidence folder, so --verbose keeps its logs', () => {
  const { capturesLogs } = require('../../dist/verify/areas/push/run');
  assert.strictEqual(capturesLogs({ send: false, observe: true }), true);
  assert.strictEqual(capturesLogs({ send: true, observe: false }), true);
  assert.strictEqual(capturesLogs({ send: false, observe: false }), false);
});
