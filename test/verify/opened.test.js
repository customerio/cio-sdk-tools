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

test('every cell closes its handle, or the result never reaches the screen', async () => {
  const { runOpenedMatrix } = require('../../dist/verify/matrix/opened');
  const closed = [];
  const reporter = {
    level: 'human',
    start: () => {},
    rung: () => ({ phase: () => {}, done: () => {} }),
    matrix: () => {},
    cell: (state) => ({
      phase: () => {},
      done: (cell) => closed.push(`${state}:${cell.verdict}`),
    }),
    note: () => {},
    pause: () => {},
    resume: () => {},
    summary: () => {},
  };

  // Non-interactive short-circuits before any cell runs, which is the one case where
  // nothing should be closed.
  const section = await runOpenedMatrix({
    target: { udid: 'x', name: 'x', kind: 'simulator', state: 'Booted' },
    bundleId: 'io.example',
    environmentId: '1',
    token: 't',
    sandbox: true,
    provider: 'apns',
    link: 'example://x',
    asker: { interactive: false, select: async () => undefined, confirm: async () => false },
    reporter,
  });
  assert.match(section.skipped, /needs a real tap/);
  assert.deepStrictEqual(closed, []);
});

// --- Android parity -------------------------------------------------------

const {
  ANDROID_OPENED_MARKERS,
} = require('../../dist/verify/matrix/android_opened');

test('the Android markers match that SDK sentence for sentence', () => {
  // From customerio-android PushNotificationLogger.kt. The wording differs from iOS —
  // the metric line carries the parsed payload, not a bare delivery id — which is why
  // the markers are per platform while the judgement is shared.
  const payload =
    'CustomerIOParsedPushPayload(deliveryId=dgS_ugc, deviceToken=cjst)';
  assert.ok(
    ANDROID_OPENED_MARKERS.tracked.test(
      `Tracking push message opened with payload: ${payload}`
    )
  );
  assert.ok(
    ANDROID_OPENED_MARKERS.skippedNoId.test(
      'Skipping opened metric for notification without a delivery id/token (locally started, not delivered by Customer.io): x'
    )
  );
  const handling = ANDROID_OPENED_MARKERS.linkHandling.exec(
    `Handling push notification deep link with payload: ${payload} - pushClickBehavior: RESET_TASK_STACK`
  );
  assert.strictEqual(handling[1], 'RESET_TASK_STACK');

  // Android has two outcomes iOS does not, because it can hand the URL to another app
  // or fall back to the launcher.
  for (const line of [
    'Deep link handled by host app callback implementation',
    'Deep link handled by internal host app navigation',
    'Deep link handled by external app',
    'Deep link handled by opening default host app',
  ]) {
    assert.ok(ANDROID_OPENED_MARKERS.linkHandled.test(line), line);
  }
  assert.ok(
    !ANDROID_OPENED_MARKERS.linkHandled.test('Deep link was not handled')
  );
  assert.ok(ANDROID_OPENED_MARKERS.linkUnhandled.test('Deep link was not handled'));
});

test('both platforms reach the same verdict through the same judge', () => {
  const { judgeOpened } = require('../../dist/verify/matrix/opened');
  // Android logs no separate "clicked" line, so the caller derives it — the point is that
  // one cause vocabulary covers both, which is what the plugin will key on.
  assert.deepStrictEqual(
    judgeOpened({
      available: true,
      clicked: true,
      tracked: true,
      foreign: false,
      emptyId: false,
      linkAttempted: true,
      linkHandled: true,
      linkUnhandled: false,
    }),
    { verdict: 'pass' }
  );
});
