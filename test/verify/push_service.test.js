const test = require('node:test');
const assert = require('node:assert');

const {
  lastPushServiceState,
  describePushService,
} = require('../../dist/verify/platform/ios/push_service');
const { deviceReady } = require('../../dist/verify/areas/push/registration/device_ready');
const { markLateArrivals } = require('../../dist/verify/areas/push/on_device/send');
const { Ladder } = require('../../dist/verify/core/report/ladder');
const { CAUSES } = require('../../dist/verify/areas/push/causes');

/**
 * A simulator's `apsd` lost Apple's sandbox servers at 20:58 and kept retrying every seven
 * minutes; every push sent after that was accepted and never arrived, and the run blamed the
 * credential. These are the lines its log printed then, and after a restart.
 */
const OFFLINE = [
  '2026-10-14 23:20:55.469 Df apsd[4378:5748cd8] [com.apple.apsd:courier] APSUserCourier <APSCourierConnectionManager: 0x100f05280; development> adjusting connection. Connected on 0 interfaces. Current link quality: wwan is unknown; wifi is good',
  '2026-10-14 23:26:29.721 Df apsd[4378:5748cd8] [com.apple.apsd:courier] <APSUserCourier 0x104a044a0 development 0> topicManager <APSTopicManager: 0x600003008240; development; 0> requested to send filter. Connected on 0 interfaces.',
  '2026-10-14 23:27:55.476 Df apsd[4378:5748cd8] [com.apple.apsd:courier] APSUserCourier <APSCourierConnectionManager: 0x100f05280; development> adjusting connection. Connected on 0 interfaces. Current link quality: wwan is unknown; wifi is good',
].join('\n');
const RECONNECTED = [
  OFFLINE,
  '2026-10-14 23:30:40.214 Df apsd[63137:5816534] [com.apple.apsd:courier] APSUserCourier <APSCourierConnectionManager: 0x105304140; development> adjusting connection. Connected on 1 interfaces. Current link quality: wwan is unknown; wifi is good',
].join('\n');

test("the last line about the sandbox connection is the push service's state now", () => {
  const offline = lastPushServiceState(OFFLINE);
  assert.deepStrictEqual(offline, {
    connected: false,
    at: '23:27:55',
    said: 'Connected on 0 interfaces',
  });
  assert.match(describePushService(offline), /last said "Connected on 0 interfaces" at 23:27:55: it has no connection/);

  // A reconnect is a later line, and it wins.
  assert.strictEqual(lastPushServiceState(RECONNECTED).connected, true);

  // Nothing said in the window, or only about another connection, means it cannot be told.
  assert.strictEqual(lastPushServiceState(''), undefined);
  assert.strictEqual(
    lastPushServiceState(OFFLINE.replace(/development/g, 'production')),
    undefined
  );
});

const simulator = { kind: 'simulator', name: 'cio-verify-ios-simulator', udid: 'BAC485BA', state: 'booted' };
const facts = (pushService) => ({
  target: simulator,
  usable: [],
  ambiguous: [],
  installed: true,
  preferences: '/tmp/prefs',
  sdk: { pushDeviceToken: 'a'.repeat(64), userId: 'someone@example.com', sources: [] },
  pushService,
});
const check = (rung) => rung.checks.find((each) => each.id === 'push_service_connected');

test('an offline simulator is a warning before anything is sent, with the restart in the evidence', () => {
  const rung = deviceReady(facts(lastPushServiceState(OFFLINE)), 'io.example.app');
  assert.strictEqual(Ladder.verdictOf(rung), 'warn', 'the integration is not what is wrong');
  assert.strictEqual(check(rung).cause, 'device.apns_offline');
  assert.ok(check(rung).evidence.includes('restart it: xcrun simctl shutdown BAC485BA && xcrun simctl boot BAC485BA'));
  assert.ok(CAUSES['device.apns_offline']);

  const online = deviceReady(facts(lastPushServiceState(RECONNECTED)), 'io.example.app');
  assert.strictEqual(check(online).verdict, 'pass');
  // Unknown says nothing at all, rather than a pass it cannot back.
  assert.strictEqual(check(deviceReady(facts(undefined), 'io.example.app')), undefined);
});

test('a push held while the simulator was offline that turns up by the end is called late', async () => {
  const cells = [
    { state: 'killed', verdict: 'skip', cause: 'device.apns_offline', title: 'cio verify KMABJ · killed', evidence: [] },
  ];
  const [cell] = await markLateArrivals(cells, async () => true);
  assert.strictEqual(cell.cause, 'runtime.push_arrived_late');
});
