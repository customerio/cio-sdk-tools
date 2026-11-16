const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sdkEvent, latestSdkState } = require('../../dist/verify/platform/sdk_events');
const {
  compareVersions,
  iosSdkVersion,
  podVersion,
  resolvedVersion,
  versionChecked,
} = require('../../dist/verify/platform/sdk_version');
const { unwrapForwarded } = require('../../dist/verify/platform/logs');
const { parseNdjson, parseSyslog } = require('../../dist/verify/platform/ios/logs');

test('a key tail is read from the last delimiter, a pair splits at its first equals sign, and values decode', () => {
  assert.deepStrictEqual(
    sdkEvent('[Push] Tracking push message opened with deliveryId: dgS_abc== || ev=push.opened id=dgS_abc=='),
    { ev: 'push.opened', fields: { id: 'dgS_abc==' } }
  );
  assert.deepStrictEqual(
    sdkEvent('[Push] Showing notification for message: {a || b} || ev=push.shown id=dgS_1 title=Verify%20push%7C3%2520'),
    { ev: 'push.shown', fields: { id: 'dgS_1', title: 'Verify push|3%20' } }
  );
});

test('a sentence that only contains the delimiter is not an event', () => {
  assert.strictEqual(sdkEvent('Deep link handled || nothing here'), undefined);
  assert.strictEqual(sdkEvent('[Push] Notification permission: granted'), undefined);
  assert.strictEqual(sdkEvent('x || id=1'), undefined);
});

test("the SDK's latest state line wins, and it says none and anonymous in words", () => {
  const lines = [
    { at: '1', process: 'app', message: '[Init] SDK state || ev=sdk.state version=4.9.0 user=anonymous token=none key=1a2b3c4d' },
    { at: '2', process: 'app', message: '[Init] SDK state || ev=sdk.state version=4.9.0 user=u%2042 token=abcdef key=1a2b3c4d' },
    { at: '3', process: 'app', message: '[Push] something else' },
  ];
  assert.deepStrictEqual(latestSdkState(lines), {
    version: '4.9.0',
    userId: 'u 42',
    anonymous: false,
    token: 'abcdef',
    noToken: false,
    keyPrefix: '1a2b3c4d',
    at: '2',
  });
  const first = latestSdkState(lines.slice(0, 1));
  assert.strictEqual(first.anonymous, true);
  assert.strictEqual(first.noToken, true);
  assert.strictEqual(first.userId, undefined);
  assert.strictEqual(latestSdkState(lines.slice(2)), undefined);
});

test('versions compare by number, and only a known major is a checked one', () => {
  assert.ok(compareVersions('4.10.0', '4.9.2') > 0);
  assert.strictEqual(compareVersions('4.9', '4.9.0'), 0);
  assert.ok(versionChecked('ios', '3.10.1'));
  assert.ok(versionChecked('android', '4.23.2'));
  assert.ok(!versionChecked('android', '3.9.0'));
  assert.ok(!versionChecked('ios', '5.0.0'));
  assert.ok(!versionChecked('ios', undefined));
});

test("the iOS SDK's version comes from CocoaPods' lock or SwiftPM's resolution, not the wrapper's", async () => {
  assert.strictEqual(
    podVersion('PODS:\n  - customerio-reactnative (6.13.1):\n    - CustomerIO/DataPipelines (= 4.9.0)\n'),
    '4.9.0'
  );
  assert.strictEqual(podVersion('PODS:\n  - CustomerIOCommon (4.8.1)\n'), '4.8.1');
  assert.strictEqual(
    resolvedVersion(JSON.stringify({ pins: [{ identity: 'customerio-ios', state: { version: '4.9.0' } }] })),
    '4.9.0'
  );
  assert.strictEqual(
    resolvedVersion(
      JSON.stringify({ object: { pins: [{ package: 'CustomerIO', repositoryURL: 'https://github.com/customerio/customerio-ios.git', state: { version: '3.10.0' } }] } })
    ),
    '3.10.0'
  );
  // A local package reference resolves to no version.
  assert.strictEqual(resolvedVersion(JSON.stringify({ pins: [] })), undefined);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cio-verify-'));
  const resolved = path.join(root, 'Runner.xcworkspace', 'xcshareddata', 'swiftpm');
  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(
    path.join(resolved, 'Package.resolved'),
    JSON.stringify({ pins: [{ identity: 'customerio-ios', state: { version: '4.9.0' } }] })
  );
  assert.deepStrictEqual(await iosSdkVersion(root), {
    version: '4.9.0',
    source: path.join('Runner.xcworkspace', 'xcshareddata', 'swiftpm', 'Package.resolved'),
  });
});

test("a React Native app's forwarded lines read as the SDK's own", () => {
  const forwarded = parseNdjson(
    JSON.stringify({
      timestamp: '2026-10-18 18:28:01.123456+0200',
      processImagePath: '/x/SampleApp.app/SampleApp',
      subsystem: 'com.facebook.react.log',
      messageType: 'Debug',
      eventMessage: '[CIO] [Push] Tracking push message opened with deliveryId: dgS_1',
    })
  )[0];
  assert.strictEqual(forwarded.message, '[Push] Tracking push message opened with deliveryId: dgS_1');
  assert.strictEqual(forwarded.subsystem, 'io.customer.sdk');
  assert.strictEqual(forwarded.level, 'debug');

  const phone = parseSyslog('Oct 18 18:28:01.123456 SampleApp(SampleApp)[812] <Debug>: [CIO] [Push] Clicked CIO push message')[0];
  assert.strictEqual(phone.message, '[Push] Clicked CIO push message');

  const native = { at: '', process: 'app', message: '[Push] x', subsystem: 'io.customer.sdk' };
  assert.strictEqual(unwrapForwarded(native), native);
});
