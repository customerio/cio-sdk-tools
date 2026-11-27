const test = require('node:test');
const assert = require('node:assert');

const {
  ANDROID_MARKERS,
  OPENED_MARKERS,
  canaryLiterals,
  lineMatch,
  linesChecked,
  matches,
} = require('../../dist/verify/areas/push/on_device/markers');
const { explainUncheckedSdk } = require('../../dist/verify/areas/push/on_device/sdk_lines');
const { judgeOpened, observeOpened } = require('../../dist/verify/areas/push/on_device/opened');
const { androidIdForTitle, androidOpenedIdentity } = require('../../dist/verify/areas/push/on_device/identity');

test('a line with a key tail is read by its key, and a line without one by its sentence', () => {
  assert.deepStrictEqual(
    lineMatch(OPENED_MARKERS.tracked, '[Push] Tracking push message opened with deliveryId: dgS_1'),
    { id: 'dgS_1' }
  );
  // Reworded, with the tail: still the same event.
  assert.deepStrictEqual(lineMatch(OPENED_MARKERS.tracked, '[Push] Open tracked || ev=push.opened id=dgS_1'), {
    id: 'dgS_1',
  });
  // A tailed line is decided by its tail alone: the sentence of another event does not leak through.
  assert.strictEqual(
    matches(OPENED_MARKERS.linkHandled, 'Deep link handled by system || ev=push.deep_link_outcome outcome=not_handled'),
    false
  );
  assert.ok(matches(OPENED_MARKERS.linkUnhandled, 'Deep link handled by system || ev=push.deep_link_outcome outcome=not_handled'));
  assert.ok(matches(OPENED_MARKERS.foreign, '[Push] x || ev=push.clicked cio=false'));
  assert.ok(!matches(OPENED_MARKERS.clicked, '[Push] x || ev=push.clicked cio=false'));
});

test("the delivered-metric worker is WorkManager's line for the SDK's tag, not its class name", () => {
  assert.ok(
    matches(
      ANDROID_MARKERS.metricsWorker,
      'Worker result SUCCESS for Work [ id=d371dd2c, tags={ io.customer.messagingpush.processor.PushDeliveryMetricsWorker,cio-requests,cio-push-delivery } ]'
    )
  );
  assert.ok(
    matches(ANDROID_MARKERS.metricsWorker, 'Worker result SUCCESS for Work [ id=1, tags={ io.customer.Renamed,cio-push-delivery } ]')
  );
  assert.ok(!matches(ANDROID_MARKERS.metricsWorker, 'Worker result SUCCESS for Work [ id=1, tags={ com.app.Sync } ]'));
});

test('a missing line counts only for an SDK version whose sentences were checked', () => {
  assert.ok(linesChecked('ios', '4.9.0'));
  assert.ok(linesChecked('android', '4.23.2'));
  assert.ok(!linesChecked('ios', '3.5.0'), 'older than the tap sentences');
  assert.ok(!linesChecked('ios', '5.0.0'), 'a major the tool has not seen');
  assert.ok(!linesChecked('android', undefined));

  const cells = [
    { state: 'killed', verdict: 'fail', cause: 'runtime.opened_not_tracked', evidence: [] },
    { state: 'background', verdict: 'pass', evidence: [] },
    { state: 'foreground', verdict: 'fail', cause: 'runtime.nse_did_not_run', evidence: [] },
  ];
  const unchecked = explainUncheckedSdk(cells, { platform: 'ios', version: '5.0.0' });
  assert.strictEqual(unchecked[0].verdict, 'skip');
  assert.strictEqual(unchecked[0].cause, 'runtime.sdk_lines_unchecked');
  assert.match(unchecked[0].evidence.join(' '), /5\.0\.0.*was: runtime\.opened_not_tracked/);
  // What the OS showed is not about the SDK's wording, and stays as it was.
  assert.strictEqual(unchecked[2].cause, 'runtime.nse_did_not_run');
  assert.strictEqual(explainUncheckedSdk(cells, { platform: 'ios', version: '4.9.0' }), cells);
});

test("an open whose line names no readable id is not credited to this push", () => {
  const { observed, deliveryId } = observeOpened(['[Push] Clicked CIO push message', '[Push] Tracking push message opened with payload: x']);
  assert.strictEqual(deliveryId, undefined);
  const base = { available: true, linkSent: false, ...observed, tracked: true };
  assert.deepStrictEqual(judgeOpened({ ...base, idUnread: true }), { verdict: 'skip', cause: 'runtime.tap_unmatched' });
  assert.deepStrictEqual(judgeOpened(base), { verdict: 'pass' });
});

test("Android's push is named by its key tail when the SDK writes one", () => {
  assert.strictEqual(
    androidIdForTitle(['[Push] Showing notification for message: … || ev=push.shown id=dgS_9 title=Verify%20push%20ab12'], 'Verify push ab12'),
    'dgS_9'
  );
  assert.deepStrictEqual(androidOpenedIdentity('[Push] opened || ev=push.opened id=dgS_9 title=T'), {
    deliveryId: 'dgS_9',
    title: 'T',
  });
});

test('the canary looks for every SDK sentence and store name the tool reads', () => {
  const { ios, android } = canaryLiterals();
  assert.ok(ios.includes('Tracking push message opened with deliveryId: '));
  assert.ok(ios.includes('delivery_context.json'));
  assert.ok(android.includes('Tracking push message opened with payload: '));
  assert.ok(android.includes('cio-push-delivery'));
  // The OS's own lines have no SDK source to check.
  assert.ok(!ios.some((literal) => /Failed to open URL/.test(literal)));
});
