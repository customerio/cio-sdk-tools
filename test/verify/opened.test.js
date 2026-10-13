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
  // Attempted and silent is not the same claim: on a phone (2026-10-13) the next cell
  // suspended the app before it said how the link ended. Only the SDK's own "not handled"
  // convicts; silence is a warning, because the open itself was tracked.
  assert.deepStrictEqual(judgeOpened({ ...tapped, linkHandled: false }), {
    verdict: 'warn',
    cause: 'runtime.deep_link_outcome_unseen',
  });
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

const { storedNotificationsFrom } = require('../../dist/verify/matrix/notifications');

/** `plutil -convert xml1` over a DeliveredNotifications.plist, cut down to its shape. */
function storeXml() {
  const uid = (n) => `<dict><key>CF$UID</key><integer>${n}</integer></dict>`;
  const objects = [
    '<string>$null</string>',
    // 1: the root, an array of stored notifications
    `<dict><key>$class</key>${uid(10)}<key>NS.objects</key><array>${uid(2)}${uid(6)}</array></dict>`,
    // 2: our push — its title next to its payload
    `<dict><key>$class</key>${uid(11)}<key>NS.keys</key><array>${uid(3)}${uid(4)}</array><key>NS.objects</key><array>${uid(5)}${uid(7)}</array></dict>`,
    '<string>AppNotificationTitle</string>',
    '<string>UNNotificationUserInfo</string>',
    '<string>cio verify · tap me · killed · 7KQ2M</string>',
    // 6: someone else's notification, with no Customer.io payload
    `<dict><key>$class</key>${uid(11)}<key>NS.keys</key><array>${uid(3)}${uid(4)}</array><key>NS.objects</key><array>${uid(8)}${uid(9)}</array></dict>`,
    // 7: our payload
    `<dict><key>$class</key>${uid(11)}<key>NS.keys</key><array>${uid(12)}</array><key>NS.objects</key><array>${uid(13)}</array></dict>`,
    '<string>Tom &amp; Jerry</string>',
    `<dict><key>$class</key>${uid(11)}<key>NS.keys</key><array>${uid(14)}</array><key>NS.objects</key><array>${uid(14)}</array></dict>`,
    '<dict><key>$classname</key><string>NSMutableArray</string></dict>',
    '<dict><key>$classname</key><string>NSMutableDictionary</string></dict>',
    '<string>CIO-Delivery-ID</string>',
    '<string>dgS_ugcABQAAAaEyeZeNdFdFrj0k0MlRGA==</string>',
    '<string>aps</string>',
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>$archiver</key><string>NSKeyedArchiver</string>
<key>$objects</key><array>${objects.join('\n')}</array>
<key>$top</key><dict><key>root</key>${uid(1)}</dict>
<key>$version</key><integer>100000</integer></dict></plist>`;
}

test('the OS store names each notification by title and by delivery id', () => {
  const stored = storedNotificationsFrom(storeXml());
  assert.deepStrictEqual(stored, [
    {
      title: 'cio verify · tap me · killed · 7KQ2M',
      deliveryId: 'dgS_ugcABQAAAaEyeZeNdFdFrj0k0MlRGA==',
    },
    { title: 'Tom & Jerry', deliveryId: undefined },
  ]);
});

test('a store that will not parse names no notifications rather than throwing', () => {
  assert.deepStrictEqual(storedNotificationsFrom('<plist><dict><key>'), []);
  assert.deepStrictEqual(storedNotificationsFrom(''), []);
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
    asker: {
      interactive: false,
      select: async () => undefined,
      confirm: async () => false,
    },
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
  assert.ok(
    ANDROID_OPENED_MARKERS.linkUnhandled.test('Deep link was not handled')
  );
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

const { openedSkipReason } = require('../../dist/verify/matrix/opened');

test('a dry run never runs the tap test, because it skipped the consent question', () => {
  assert.match(
    openedSkipReason({ dryRun: true, rateLimited: false }),
    /a dry run sends nothing/
  );
  assert.match(
    openedSkipReason({ dryRun: false, rateLimited: true }),
    /provider was refusing sends/
  );
  assert.strictEqual(
    openedSkipReason({ dryRun: false, rateLimited: false }),
    undefined
  );
});

const { observeOpened } = require('../../dist/verify/matrix/opened');

test('an open tracked without "Clicked" or "Tracking push message opened" still passes', () => {
  // Captured from a physical iPhone 15 on 2026-10-13: the build tracked the open and
  // followed the link, and printed neither of the lines the check used to require.
  const iphone = [
    'CombinedCacheEventBusHandler: Posting event TrackMetricEvent(storageId: "AEC89E46-B36F-402D-8117-E73441E74DC8", params: [:], deliveryID: "dgS_ugcABQAAAaEykelzxSgfj-nrCK1jxQ==", event: "opened", deviceToken: "aecc305e54ae")',
    '[Push] Handling push notification deep link with url: apn-uikit://settings',
    '[Push] Deep link handled by host app callback implementation',
    'push metric opened',
  ];
  const { observed, deliveryId } = observeOpened(iphone);
  assert.strictEqual(deliveryId, 'dgS_ugcABQAAAaEykelzxSgfj-nrCK1jxQ==');
  assert.strictEqual(observed.clicked, true, 'a followed deep link is a click');
  assert.strictEqual(observed.tracked, true);
  assert.deepStrictEqual(judgeOpened({ available: true, ...observed }), {
    verdict: 'pass',
  });
});

test('the older wording still reads the same way', () => {
  const { observed, deliveryId } = observeOpened([
    'Clicked notification for message: <payload>',
    'Tracking push message opened with deliveryId: abc123',
    'Handling push notification deep link with url: app://x',
    'Deep link handled by system',
  ]);
  assert.strictEqual(deliveryId, 'abc123');
  assert.deepStrictEqual(judgeOpened({ available: true, ...observed }), {
    verdict: 'pass',
  });
  // And nothing at all is still nothing.
  assert.deepStrictEqual(
    judgeOpened({ available: true, ...observeOpened(['unrelated']).observed }),
    { verdict: 'skip', cause: 'runtime.tap_not_seen' }
  );
});

const { openedSequenceComplete } = require('../../dist/verify/matrix/opened');

test('a tap is not finished until the open is tracked and the link has an outcome', () => {
  // The killed tap of 2026-10-13, read before the app said how the link ended.
  const midway = observeOpened([
    '[Push] Clicked notification for message: UNNotificationWrapper(…)',
    '[Push] Clicked CIO push message',
    'CombinedCacheEventBusHandler: Posting event TrackMetricEvent(deliveryID: "dgS_ugcABQAAAaEyoyVrHPyFGaoC6os_SQ==", event: "opened", deviceToken: "aecc")',
    '[Push] Handling push notification deep link with url: apn-uikit://settings',
  ]).observed;
  assert.strictEqual(
    openedSequenceComplete(midway, { linkSent: true }),
    false,
    'moved on mid-link'
  );
  assert.deepStrictEqual(judgeOpened({ available: true, ...midway }), {
    verdict: 'warn',
    cause: 'runtime.deep_link_outcome_unseen',
  });

  const done = observeOpened([
    '[Push] Clicked CIO push message',
    'push metric opened',
    '[Push] Handling push notification deep link with url: apn-uikit://settings',
    '[Push] Deep link handled by host app callback implementation',
  ]).observed;
  assert.strictEqual(openedSequenceComplete(done, { linkSent: true }), true);

  // The run of 2026-10-13 00:29: the open was tracked and the link not yet started. With a
  // link in the push, that is the middle of the sequence.
  const trackedOnly = observeOpened([
    '[Push] Clicked CIO push message',
    '[Push] Tracking push message opened with deliveryId: dgS_ugcABQAAAaEyrArrbZp8xdiktcNTUA==',
  ]).observed;
  assert.strictEqual(
    openedSequenceComplete(trackedOnly, { linkSent: true }),
    false
  );
  assert.strictEqual(
    openedSequenceComplete(trackedOnly, { linkSent: false }),
    true
  );

  assert.strictEqual(
    openedSequenceComplete(
      observeOpened(['[Push] Deep link was not handled']).observed,
      { linkSent: true }
    ),
    true,
    'an explicit failure ends the wait'
  );
  assert.strictEqual(
    openedSequenceComplete(observeOpened(['nothing yet']).observed, {
      linkSent: true,
    }),
    false
  );
});

const exec = require('../../dist/verify/exec');
const { deviceLogUnavailable } = require('../../dist/verify/matrix/logs');

test('a phone without idevicesyslog is named before anything is sent; a simulator never is', async () => {
  const original = exec.isCommandAvailable;
  exec.isCommandAvailable = async () => false;
  try {
    assert.match(
      await deviceLogUnavailable({
        kind: 'device',
        name: 'iPhone',
        udid: 'u',
        state: 'available',
      }),
      /brew install libimobiledevice/
    );
    assert.strictEqual(
      await deviceLogUnavailable({
        kind: 'simulator',
        name: 'sim',
        udid: 's',
        state: 'booted',
      }),
      undefined
    );
  } finally {
    exec.isCommandAvailable = original;
  }
});

const { explainUnseenTap } = require('../../dist/verify/matrix/opened');
const { blameStoppedCapture } = require('../../dist/verify/matrix/logs');

test('a cell that saw nothing after the capture stopped blames the capture', () => {
  const silent = {
    state: 'killed',
    verdict: 'skip',
    cause: 'runtime.no_evidence',
    evidence: [],
  };
  const blamed = blameStoppedCapture(
    silent,
    'idevicesyslog exited (1) at 04:32:00, partway through the run',
    ['runtime.no_evidence']
  );
  assert.strictEqual(blamed.verdict, 'skip');
  assert.strictEqual(blamed.cause, 'runtime.capture_stopped');
  assert.match(
    blamed.evidence[0],
    /exited \(1\) at 04:32:00.*was: runtime\.no_evidence/
  );

  const passed = { state: 'killed', verdict: 'pass', evidence: [] };
  assert.strictEqual(
    blameStoppedCapture(passed, 'stopped', ['runtime.no_evidence']),
    passed
  );
  assert.strictEqual(
    blameStoppedCapture(silent, undefined, ['runtime.no_evidence']),
    silent
  );
});

test('a tap followed by not one log line says the stream may have stopped', () => {
  // The background tap of 2026-10-13 00:29: the stream went quiet at 04:32:00 without its
  // reader exiting, and the cell said the tap had not arrived.
  const unseen = {
    state: 'background',
    verdict: 'skip',
    cause: 'runtime.tap_not_seen',
    evidence: [],
  };
  const silent = explainUnseenTap(unseen, {
    linesAfterTap: 0,
    lastLineAt: '04:32:00.270',
  });
  assert.strictEqual(silent.cause, 'runtime.capture_silent');
  assert.match(silent.evidence[0], /the last was at 04:32:00\.270/);

  assert.strictEqual(
    explainUnseenTap(unseen, {
      stoppedReason: 'idevicesyslog exited',
      linesAfterTap: 0,
    }).cause,
    'runtime.capture_stopped'
  );
  assert.strictEqual(
    explainUnseenTap(unseen, { linesAfterTap: 412, lastLineAt: 'x' }),
    unseen,
    'a busy log after the tap means the tap really was not seen'
  );
  const other = { ...unseen, cause: 'runtime.deep_link_outcome_unseen' };
  assert.strictEqual(
    explainUnseenTap(other, { linesAfterTap: 0, lastLineAt: 'x' }),
    other
  );
});

test('a tap iOS handed to the app that the SDK never handled is a finding, not "not seen"', () => {
  // The killed tap of 2026-10-13 04:43 on an iPhone 15: a cold launch from the tap, with
  // the response action decoded and delivered in scene-create, and no SDK line after it.
  const cold = observeOpened([
    'Decode <UINotificationResponseAction: 0x002200b0>',
    '[Init] Creating new instance of CustomerIO SDK version: 4.8.1...',
    'CIO: Registering for remote notifications',
    '[(FBSceneManager):sceneID:io.customer.ios-sample.apn-spm.APN-UIKit-default] Received action(s) in scene-create: <UINotificationResponseAction: 0x002200b0>',
  ]).observed;
  assert.strictEqual(cold.osDelivered, true);
  assert.deepStrictEqual(judgeOpened({ available: true, ...cold }), {
    verdict: 'fail',
    cause: 'runtime.tap_not_handled',
  });

  // The same launch at 04:03, where the SDK did its part, still passes.
  const handled = observeOpened([
    'Decode <UINotificationResponseAction: 0x00220043>',
    'Received action(s) in scene-create: <UINotificationResponseAction: 0x00220043>',
    'push metric opened',
    '[Push] Handling push notification deep link with url: apn-uikit://settings',
    '[Push] Deep link handled by host app callback implementation',
  ]).observed;
  assert.deepStrictEqual(judgeOpened({ available: true, ...handled }), {
    verdict: 'pass',
  });

  // Without iOS's lines (a simulator's filtered capture), it stays "not seen".
  assert.strictEqual(
    judgeOpened({ available: true, ...observeOpened(['unrelated']).observed })
      .cause,
    'runtime.tap_not_seen'
  );
});
