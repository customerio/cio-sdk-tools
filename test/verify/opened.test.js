const test = require('node:test');
const assert = require('node:assert');

const {
  judgeOpened,
  OPENED_MARKERS,
  OPENED_STATES,
} = require('../../dist/verify/matrix/opened');

const tapped = {
  available: true,
  clicked: true,
  tracked: true,
  foreign: false,
  emptyId: false,
  linkAttempted: true,
  linkHandled: true,
  linkUnhandled: false,
};

test('a tap that is counted and routed passes', () => {
  assert.deepStrictEqual(judgeOpened(tapped), { verdict: 'pass' });
});

test('an open that is counted but routes nowhere is a real defect', () => {
  assert.deepStrictEqual(
    judgeOpened({ ...tapped, linkHandled: false, linkUnhandled: true }),
    { verdict: 'fail', cause: 'runtime.deep_link_not_handled' }
  );
  // Attempted and silent counts the same: nothing claimed the URL.
  assert.deepStrictEqual(
    judgeOpened({ ...tapped, linkHandled: false }),
    { verdict: 'fail', cause: 'runtime.deep_link_not_handled' }
  );
});

test('a push with no link is a warning, because the open itself is fine', () => {
  assert.deepStrictEqual(
    judgeOpened({ ...tapped, linkAttempted: false, linkHandled: false }),
    { verdict: 'warn', cause: 'runtime.deep_link_absent' }
  );
});

test('the click reaching the SDK without a metric is the invisible failure', () => {
  assert.deepStrictEqual(judgeOpened({ ...tapped, tracked: false }), {
    verdict: 'fail',
    cause: 'runtime.opened_not_tracked',
  });
});

test('a tap nothing saw proves nothing; a tap on a foreign notification is named', () => {
  // Skip, not fail: the banner may have gone, and convicting on that is how false
  // failures get manufactured.
  assert.deepStrictEqual(
    judgeOpened({ ...tapped, clicked: false, tracked: false }),
    { verdict: 'skip', cause: 'runtime.tap_not_seen' }
  );
  assert.deepStrictEqual(
    judgeOpened({ ...tapped, clicked: false, tracked: false, foreign: true }),
    { verdict: 'fail', cause: 'runtime.tap_not_ours' }
  );
});

test('a click with no delivery id cannot be attributed', () => {
  assert.deepStrictEqual(judgeOpened({ ...tapped, emptyId: true }), {
    verdict: 'fail',
    cause: 'runtime.opened_without_delivery_id',
  });
});

test('the markers match the SDK sentences verbatim', () => {
  // Taken from customerio-ios: PushNotificationLogger.swift and SdkCommonLoggerLogger.swift.
  const lines = [
    'Clicked CIO push message',
    'Tracking push message opened with deliveryId: dgS_ugcABQAAAaCvRsEX24T-ZFs',
    'Handling push notification deep link with url: apn-uikit://settings',
    'Deep link handled by host app callback implementation',
  ];
  assert.ok(OPENED_MARKERS.clicked.test(lines[0]));
  assert.strictEqual(
    OPENED_MARKERS.tracked.exec(lines[1])[1],
    'dgS_ugcABQAAAaCvRsEX24T-ZFs'
  );
  assert.ok(OPENED_MARKERS.linkHandling.test(lines[2]));
  assert.ok(OPENED_MARKERS.linkHandled.test(lines[3]));
  assert.ok(OPENED_MARKERS.linkUnhandled.test('Deep link was not handled'));
  assert.ok(!OPENED_MARKERS.linkHandled.test('Deep link was not handled'));
});

test('foreground is not offered by default — there is no banner to tap', () => {
  assert.deepStrictEqual(OPENED_STATES, ['killed', 'background']);
});

// --- arrival by title ----------------------------------------------------

const { titlesFrom } = require('../../dist/verify/matrix/notifications');

test('titles are read out of the archived store, which grep cannot see into', () => {
  // Shape of real `plutil -p` output over a DeliveredNotifications.plist: an
  // NSKeyedArchiver object table, which is why the raw file is not greppable.
  const printed = `{
  "$archiver" => "NSKeyedArchiver"
  "$objects" => [
    0 => "$null"
    12 => "cio verify · tap me · killed"
    13 => "io.customer.ios-sample.apn-spm.APN-UIKit"
    14 => "Tap this notification to verify the opened metric."
  ]
}`;
  const titles = titlesFrom(printed);
  assert.ok(titles.includes('cio verify · tap me · killed'));
  assert.ok(titles.includes('io.customer.ios-sample.apn-spm.APN-UIKit'));
  // An exact title is the whole point: counting entries called an unrelated system
  // notification our push arriving, and sent someone looking for a banner nobody sent.
  assert.ok(!titles.includes('cio verify · tap me · background'));
});
