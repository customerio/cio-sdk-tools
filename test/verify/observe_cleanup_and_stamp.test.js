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
