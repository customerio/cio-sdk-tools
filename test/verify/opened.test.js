const test = require('node:test');
const assert = require('node:assert');

const {
  judgeOpened,
  OPENED_MARKERS,
  OPENED_STATES,
  openedSkipReason,
} = require('../../dist/verify/areas/push/on_device/opened');

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

test('a push sent without a deep link passes on the open alone: where it goes was not asked', () => {
  const noLink = { ...tapped, linkSent: false, linkAttempted: false, linkHandled: false };
  assert.deepStrictEqual(judgeOpened(noLink), { verdict: 'pass' });
  // The open still has to be there: no link does not excuse a missing open.
  assert.deepStrictEqual(judgeOpened({ ...noLink, tracked: false }), {
    verdict: 'fail',
    cause: 'runtime.opened_not_tracked',
  });
});

test('a click the SDK never turned into an open fails, unless the log can drop lines', () => {
  assert.deepStrictEqual(judgeOpened({ ...tapped, tracked: false }), {
    verdict: 'fail',
    cause: 'runtime.opened_not_tracked',
  });
  // On a phone the missing line may simply be lost.
  assert.deepStrictEqual(
    judgeOpened({ ...tapped, tracked: false, lossy: true }),
    { verdict: 'skip', cause: 'runtime.tap_lines_lost' }
  );
});

test('an open of a different push says nothing about this one', () => {
  assert.deepStrictEqual(judgeOpened({ ...tapped, matched: false }), {
    verdict: 'skip',
    cause: 'runtime.tap_other_push',
  });
  assert.deepStrictEqual(judgeOpened({ ...tapped, matched: true }), {
    verdict: 'pass',
  });
  // Unknown is not a mismatch: without an id to compare, the open is judged on its own.
  assert.deepStrictEqual(judgeOpened({ ...tapped, matched: undefined }), {
    verdict: 'pass',
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

const { storedNotificationsFrom } = require('../../dist/verify/areas/push/on_device/notifications');

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

test('every tapped state gets a line, even one whose push was never sent', () => {
  const { completeTaps } = require('../../dist/verify/areas/push/on_device');
  const { notTappedCell } = require('../../dist/verify/areas/push/on_device/opened');
  const tap = { asker: {}, link: 'app://x', states: ['killed', 'background'] };
  const killed = { state: 'killed', verdict: 'pass', evidence: [] };
  // The provider refused the background send, so that state's cell never ran.
  const cells = completeTaps(tap, ['killed', 'background', 'foreground'], [killed]);
  assert.deepStrictEqual(
    cells.map((cell) => [cell.state, cell.verdict, cell.summary]),
    [
      ['killed', 'pass', undefined],
      ['background', 'skip', 'not tapped'],
    ]
  );
  // A tap state the run does not send is not a cell at all.
  assert.deepStrictEqual(
    completeTaps(tap, ['killed'], [killed]).map((cell) => cell.state),
    ['killed']
  );
  assert.deepStrictEqual(notTappedCell('killed', 'why').evidence, ['why']);
});

test('a run that cannot ask for a tap says so instead of tapping; a missing deep link does not stop it', () => {
  assert.match(
    openedSkipReason({ dryRun: false, interactive: false }),
    /needs a real tap/
  );
  assert.match(
    openedSkipReason({ dryRun: true, interactive: true }),
    /dry run sends nothing/
  );
  // Without --deep-link the open is still checked; only where the tap goes is not.
  assert.strictEqual(
    openedSkipReason({ dryRun: false, interactive: true }),
    undefined
  );
});

// --- Android parity -------------------------------------------------------

const {
  ANDROID_OPENED_MARKERS,
} = require('../../dist/verify/areas/push/on_device/android_opened');

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
  const { judgeOpened } = require('../../dist/verify/areas/push/on_device/opened');
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

const { observeOpened } = require('../../dist/verify/areas/push/on_device/opened');

test('internal event lines no longer stand in for the SDK handling the open', () => {
  // Captured from a physical iPhone 15 on 2026-10-13. The lines the check needs were not
  // missing from the build — the app's own diagnostics file shows it printing them — they
  // were dropped by the phone's log stream. So on a phone this is unproven, not a pass.
  const iphone = [
    'CombinedCacheEventBusHandler: Posting event TrackMetricEvent(storageId: "AEC89E46-B36F-402D-8117-E73441E74DC8", params: [:], deliveryID: "dgS_ugcABQAAAaEykelzxSgfj-nrCK1jxQ==", event: "opened", deviceToken: "aecc305e54ae")',
    '[Push] Handling push notification deep link with url: apn-uikit://settings',
    '[Push] Deep link handled by host app callback implementation',
    'push metric opened',
  ];
  const { observed, deliveryId } = observeOpened(iphone);
  assert.strictEqual(deliveryId, undefined);
  assert.strictEqual(observed.clicked, true, 'a followed deep link is a click');
  assert.strictEqual(observed.tracked, false);
  assert.deepStrictEqual(
    judgeOpened({ available: true, lossy: true, ...observed }),
    { verdict: 'skip', cause: 'runtime.tap_lines_lost' }
  );
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

const { openedSequenceComplete } = require('../../dist/verify/areas/push/on_device/opened');

test('a tap is not finished until the open is tracked and the link has an outcome', () => {
  // The killed tap of 2026-10-13, read before the app said how the link ended.
  const midway = observeOpened([
    '[Push] Clicked notification for message: UNNotificationWrapper(…)',
    '[Push] Clicked CIO push message',
    '[Push] Tracking push message opened with deliveryId: dgS_ugcABQAAAaEyoyVrHPyFGaoC6os_SQ==',
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
    '[Push] Tracking push message opened with deliveryId: dgS_ugcABQAAAaEyoyVrHPyFGaoC6os_SQ==',
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

const exec = require('../../dist/verify/core/exec');
const { deviceLogUnavailable } = require('../../dist/verify/platform/ios/logs');

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

const { explainUnseenTap } = require('../../dist/verify/areas/push/on_device/opened');
const { blameStoppedCapture } = require('../../dist/verify/areas/push/on_device/sdk_lines');

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

test('a tap iOS handed to the app with no SDK line after it is lost lines, not a finding', () => {
  // The killed tap of 2026-10-13 04:43 on an iPhone 15: a cold launch from the tap, with the
  // response action decoded and delivered in scene-create, and no SDK line after it in the
  // phone's log. The app's own diagnostics file shows the SDK handled that tap at
  // 04:43:22.230 — the log stream lost the lines. The same happened to six more taps.
  const cold = observeOpened([
    'Decode <UINotificationResponseAction: 0x002200b0>',
    '[Init] Creating new instance of CustomerIO SDK version: 4.8.1...',
    'CIO: Registering for remote notifications',
    '[(FBSceneManager):sceneID:io.customer.ios-sample.apn-spm.APN-UIKit-default] Received action(s) in scene-create: <UINotificationResponseAction: 0x002200b0>',
  ]).observed;
  assert.strictEqual(cold.osDelivered, true);
  assert.deepStrictEqual(judgeOpened({ available: true, lossy: true, ...cold }), {
    verdict: 'skip',
    cause: 'runtime.tap_lines_lost',
  });

  // The same launch with the SDK's lines intact passes.
  const handled = observeOpened([
    'Decode <UINotificationResponseAction: 0x00220043>',
    'Received action(s) in scene-create: <UINotificationResponseAction: 0x00220043>',
    '[Push] Clicked CIO push message',
    '[Push] Tracking push message opened with deliveryId: dgS_ugcABQAAAaE2jyHtPzZT21RAOnpLAw==',
    '[Push] Handling push notification deep link with url: apn-uikit://settings',
    '[Push] Deep link handled by host app callback implementation',
  ]).observed;
  assert.deepStrictEqual(
    judgeOpened({ available: true, lossy: true, ...handled }),
    { verdict: 'pass' }
  );

  // Without iOS's lines (a simulator's filtered capture), it stays "not seen".
  assert.strictEqual(
    judgeOpened({ available: true, ...observeOpened(['unrelated']).observed })
      .cause,
    'runtime.tap_not_seen'
  );
});

test('a capture that stopped explains lost tap lines too', () => {
  const lost = {
    state: 'killed',
    verdict: 'skip',
    cause: 'runtime.tap_lines_lost',
    evidence: [],
  };
  assert.strictEqual(
    explainUnseenTap(lost, { stoppedReason: 'idevicesyslog exited', linesAfterTap: 3 })
      .cause,
    'runtime.capture_stopped'
  );
  assert.strictEqual(
    explainUnseenTap(lost, { linesAfterTap: 0, lastLineAt: 'x' }),
    lost,
    'iOS logged the tap, so the stream was not silent'
  );
});

// --- the tap prompt ---------------------------------------------------------

const { PassThrough } = require('stream');
const { createAsker } = require('../../dist/verify/core/prompt');
const { untappedCell } = require('../../dist/verify/areas/push/on_device/opened');

const tapAsker = (lines, timeoutMs = 200) => {
  const input = new PassThrough();
  for (const line of lines) input.write(`${line}\n`);
  const written = [];
  const asker = createAsker({
    interactive: true,
    input,
    output: { write: (chunk) => written.push(String(chunk)) },
    timeoutMs,
  });
  return { asker, text: () => written.join('') };
};

test('the tap prompt offers tapped, never showed up, and skip', async () => {
  const { asker, text } = tapAsker(['2']);
  assert.strictEqual(await asker.askTap('Tap the "x" notification.'), 'not_shown');
  assert.match(text(), /1\s+I tapped it/);
  assert.match(text(), /2\s+It never showed up/);
  assert.match(text(), /3\s+Skip this state/);
  assert.doesNotMatch(text(), /press Enter when done/);

  assert.strictEqual(await tapAsker(['3']).asker.askTap('x'), 'skipped');
  assert.strictEqual(await tapAsker(['1']).asker.askTap('x'), 'tapped');
  // Enter still means tapped, as it did before there was a choice.
  assert.strictEqual(await tapAsker(['']).asker.askTap('x'), 'tapped');
});

test('silence or nonsense at the tap prompt is no answer, never a tap', async () => {
  assert.strictEqual(await tapAsker([]).asker.askTap('x'), 'no_answer');
  assert.strictEqual(
    await tapAsker(['9', 'yes', 'tapped']).asker.askTap('x'),
    'no_answer'
  );
  const quiet = createAsker({ interactive: false });
  assert.strictEqual(await quiet.askTap('x'), 'no_answer');
});

test('"never showed up" is as strong as the arrival evidence behind it', () => {
  // The simulator run of 2026-10-13: the store held the push, the screen had no banner.
  assert.deepStrictEqual(
    untappedCell('background', 'not_shown', ['arrived: in the notification store'], true),
    {
      state: 'background',
      verdict: 'skip',
      cause: 'runtime.banner_not_seen',
      evidence: [
        'arrived: in the notification store',
        'the person asked to tap it saw no banner',
      ],
    }
  );
  // On a phone whose log never showed the push landing, it may never have come.
  assert.strictEqual(
    untappedCell('killed', 'not_shown', [], false).cause,
    'runtime.push_not_seen'
  );
  assert.deepStrictEqual(
    untappedCell('killed', 'skipped', [], true),
    {
      state: 'killed',
      verdict: 'skip',
      cause: 'runtime.tap_not_confirmed',
      evidence: ['skipped at the prompt'],
    }
  );
  assert.match(
    untappedCell('killed', 'no_answer', [], true).evidence[0],
    /nobody answered/
  );
});

// --- arrow keys on a terminal -------------------------------------------------

const fakeTerminal = () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (mode) => {
    input.isRaw = mode;
  };
  const written = [];
  const output = { isTTY: true, write: (chunk) => written.push(String(chunk)) };
  return { input, output, text: () => written.join('') };
};

const press = (input, ...keys) => {
  let delay = 10;
  for (const key of keys) {
    setTimeout(() => input.write(key), delay);
    delay += 10;
  }
};

test('on a terminal, the arrow keys move and Enter picks', async () => {
  const { input, output, text } = fakeTerminal();
  const asker = createAsker({ interactive: true, input, output, timeoutMs: 2_000 });
  press(input, '\u001b[B', '\r');
  assert.strictEqual(await asker.askTap('Tap the "x" notification.'), 'not_shown');
  assert.match(text(), /↑\/↓ to move/);
  assert.match(text(), /✔.*It never showed up/);
  assert.strictEqual(input.isRaw, false, 'raw mode was left on');
});

test('arrows wrap, a number jumps, and the default is where the cursor starts', async () => {
  const { pickWithArrows } = require('../../dist/verify/core/prompt');
  const rows = [{ label: 'a' }, { label: 'b' }, { label: 'c' }];

  let terminal = fakeTerminal();
  press(terminal.input, '\u001b[A', '\r');
  assert.strictEqual(
    await pickWithArrows(terminal.input, terminal.output, rows, 0, 2_000),
    2,
    'up from the first row wraps to the last'
  );

  terminal = fakeTerminal();
  press(terminal.input, '2', '\r');
  assert.strictEqual(
    await pickWithArrows(terminal.input, terminal.output, rows, 0, 2_000),
    1
  );

  terminal = fakeTerminal();
  press(terminal.input, '\r');
  assert.strictEqual(
    await pickWithArrows(terminal.input, terminal.output, rows, 2, 2_000),
    2
  );
});

test('no key in time is no answer, and the terminal is restored', async () => {
  const { pickWithArrows } = require('../../dist/verify/core/prompt');
  const { input, output, text } = fakeTerminal();
  assert.strictEqual(
    await pickWithArrows(input, output, [{ label: 'a' }], 0, 50),
    undefined
  );
  assert.strictEqual(input.isRaw, false);
  assert.match(text(), /no answer/);
});

test('a select on a terminal uses the arrows too, and a pipe still answers by number', async () => {
  const terminal = fakeTerminal();
  const onTerminal = createAsker({
    interactive: true,
    input: terminal.input,
    output: terminal.output,
    timeoutMs: 2_000,
  });
  press(terminal.input, '\u001b[B', '\r');
  const picked = await onTerminal.select(
    'How much should be sent?',
    [
      { value: 'all', label: 'All three app states' },
      { value: 'killed', label: 'Killed only' },
    ],
    { flag: '--states' }
  );
  assert.strictEqual(picked, 'killed');

  // A pipe is not a terminal: numbers, as before.
  assert.strictEqual(await tapAsker(['2']).asker.askTap('x'), 'not_shown');
});

test('with the launch held from its first line, silence after the tap is the SDK\'s, not the stream\'s', () => {
  const handedOver = {
    available: true,
    clicked: false,
    tracked: false,
    foreign: false,
    emptyId: false,
    linkAttempted: false,
    linkHandled: false,
    linkUnhandled: false,
    osDelivered: true,
  };
  // Held: every line the app wrote was read, so a tap iOS delivered and the SDK never
  // logged is the SDK set up too late for a launch.
  assert.deepStrictEqual(judgeOpened({ ...handedOver, lossy: false }), {
    verdict: 'fail',
    cause: 'runtime.cold_tap_not_handled',
  });
  // Not held: the phone may have dropped the lines, so nothing is proven either way.
  assert.deepStrictEqual(judgeOpened({ ...handedOver, lossy: true }), {
    verdict: 'skip',
    cause: 'runtime.tap_lines_lost',
  });
  // A click with no open, read in full, is the open never being reported.
  assert.deepStrictEqual(
    judgeOpened({ ...tapped, tracked: false, lossy: false }),
    { verdict: 'fail', cause: 'runtime.opened_not_tracked' }
  );
});

test('a capture that stopped explains a held launch that looks unhandled', () => {
  const { explainUnseenTap } = require('../../dist/verify/areas/push/on_device/opened');
  const cell = {
    state: 'killed',
    verdict: 'fail',
    cause: 'runtime.cold_tap_not_handled',
    evidence: [],
  };
  const explained = explainUnseenTap(cell, {
    stoppedReason: 'idevicesyslog -p 1220 exited at 17:02:01, partway through the run',
    linesAfterTap: 0,
  });
  assert.strictEqual(explained.cause, 'runtime.capture_stopped');
  assert.strictEqual(explained.verdict, 'skip');
});

test('a caught launch is complete only from its first line, and when its stream missed nothing', () => {
  const { describeCaughtLaunch } = require('../../dist/verify/areas/push/on_device/opened');
  const caught = { pid: 1236, slot: 1, fromFirstLine: true, how: 'idevicesyslog -p 1236' };
  const rescued = describeCaughtLaunch({ caught }, { both: 300, onlyFollowed: 42, onlyMain: 0 });
  assert.strictEqual(rescued.complete, true);
  assert.match(rescued.evidence, /opened before that pid was in use \(pid 1 of the 8 watched\)/);
  assert.match(rescued.evidence, /42 only the pid's \(the whole-log stream dropped them\)/);

  const leaky = describeCaughtLaunch({ caught }, { both: 300, onlyFollowed: 0, onlyMain: 2 });
  assert.strictEqual(leaky.complete, false);
  assert.match(leaky.evidence, /that stream missed lines too/);

  // Opened only after the app had started: its first lines may have gone before it.
  assert.strictEqual(describeCaughtLaunch({ caught: { ...caught, fromFirstLine: false } }).complete, false);
  const missed = describeCaughtLaunch({ missed: { pid: 1250, from: 1240, to: 1247 } });
  assert.strictEqual(missed.complete, false);
  assert.match(missed.evidence, /outside the pids watched for it \(1240–1247\)/);
  assert.strictEqual(describeCaughtLaunch({}).complete, false);
});

test("Customer.io's record of the open settles what the phone's log could not", () => {
  const { withRecordedOpen } = require('../../dist/verify/areas/push/on_device/opened');
  const lost = { state: 'killed', verdict: 'skip', cause: 'runtime.tap_lines_lost', evidence: [] };
  const recorded = { answer: 'opened', deliveryId: 'dgS_ug', at: 1791983000 };

  // An open it recorded proves the open; where the tap went was only in the lost lines.
  const linked = withRecordedOpen(lost, recorded, true);
  assert.strictEqual(linked.verdict, 'warn');
  assert.strictEqual(linked.cause, 'runtime.opened_recorded_link_unseen');
  assert.strictEqual(linked.recorded, 'recorded');
  assert.strictEqual(withRecordedOpen(lost, recorded, false).verdict, 'pass');

  // It overturns a failure the log suggested: only lost lines can explain the two disagreeing.
  const failed = { ...lost, verdict: 'fail', cause: 'runtime.cold_tap_not_handled' };
  assert.strictEqual(withRecordedOpen(failed, recorded, false).verdict, 'pass');

  // No open recorded yet, or no record at all, leaves the device's verdict as it was.
  const none = withRecordedOpen(failed, { answer: 'not_opened', deliveryIds: ['dgS_ug'], waitedMs: 30000 }, false);
  assert.strictEqual(none.verdict, 'fail');
  assert.strictEqual(none.recorded, 'not_recorded');
  const unread = withRecordedOpen(lost, { answer: 'unavailable', reason: 'the send returned no delivery id' }, true);
  assert.strictEqual(unread.verdict, 'skip');
  assert.match(unread.evidence.at(-1), /not read: the send returned no delivery id/);
});
