const test = require('node:test');
const assert = require('node:assert');

const { deliveredRequest, judge } = require('../../dist/verify/matrix');
const {
  NSE_MARKERS,
  deliveryIdsIn,
  ranInExtension,
} = require('../../dist/verify/matrix/logs');
const { Ladder } = require('../../dist/verify/ladder');

const line = (process, message) => ({ at: '00:00:00.000', process, message });

test('arrived but never processed is a different failure from never arrived', () => {
  assert.deepStrictEqual(
    judge({
      available: true,
      arrived: true,
      extensionRan: false,
      accepted: false,
      tracked: false,
      sawLines: true,
      loggedIds: [],
      freshIds: [],
    }),
    { verdict: 'fail', cause: 'runtime.nse_did_not_run' }
  );
  assert.deepStrictEqual(
    judge({
      available: true,
      arrived: false,
      extensionRan: false,
      accepted: false,
      tracked: false,
      sawLines: true,
      loggedIds: [],
      freshIds: [],
    }),
    { verdict: 'fail', cause: 'runtime.push_never_arrived' }
  );
});

test('a report that never landed is not judged on the device', () => {
  // The extension ran on the push: that is "received". Whether its report reached
  // Customer.io is Customer.io's to say, and the device's log of it is the evidence most
  // often missing.
  assert.deepStrictEqual(
    judge({
      available: true,
      arrived: true,
      extensionRan: true,
      sawLines: true,
      loggedIds: [],
      freshIds: [],
    }),
    { verdict: 'pass' }
  );
});

test('on a phone, a missing extension line is unproven, never a failure', () => {
  // idevicesyslog drops lines; a phone has no notification store to say the push arrived.
  assert.deepStrictEqual(
    judge({
      available: true,
      lossy: true,
      arrived: undefined,
      extensionRan: false,
      sawLines: true,
      loggedIds: [],
      freshIds: [],
    }),
    { verdict: 'skip', cause: 'runtime.push_not_seen' }
  );
  // On a simulator the store says the push is there and nothing is dropped: an extension
  // that never logged never ran.
  assert.deepStrictEqual(
    judge({
      available: true,
      lossy: false,
      arrived: true,
      extensionRan: false,
      sawLines: true,
      loggedIds: [],
      freshIds: [],
    }),
    { verdict: 'fail', cause: 'runtime.nse_did_not_run' }
  );
});

test('a cell proves nothing without a log, and says so rather than passing', () => {
  assert.deepStrictEqual(
    judge({
      available: false,
      arrived: undefined,
      extensionRan: false,
      accepted: false,
      sawLines: false,
      loggedIds: [],
      freshIds: [],
    }),
    { verdict: 'skip' }
  );
});

test('counting somebody else’s delivery is a warning, not a pass', () => {
  assert.deepStrictEqual(
    judge({
      available: true,
      arrived: true,
      extensionRan: true,
      accepted: true,
      sawLines: true,
      expectedId: 'dgS_aaa',
      loggedIds: ['dgS_bbb'],
      freshIds: ['dgS_bbb'],
    }),
    { verdict: 'warn', cause: 'runtime.delivery_id_mismatch' }
  );
  assert.deepStrictEqual(
    judge({
      available: true,
      arrived: true,
      extensionRan: true,
      accepted: true,
      sawLines: true,
      expectedId: 'dgS_aaa',
      loggedIds: ['dgS_aaa'],
      freshIds: ['dgS_aaa'],
    }),
    { verdict: 'pass' }
  );
});

test('a push whose id the log never mentions still passes on the extension running', () => {
  // The id is absent from plenty of real captures; requiring it would fail correct runs.
  assert.deepStrictEqual(
    judge({
      available: true,
      arrived: true,
      extensionRan: true,
      accepted: true,
      sawLines: true,
      expectedId: 'dgS_aaa',
      loggedIds: [],
      freshIds: [],
    }),
    { verdict: 'pass' }
  );
});

test('base64url delivery ids are recognised, underscores and dashes included', () => {
  const ids = deliveryIdsIn([
    line(
      'NotificationService',
      'Tracking push message delivered, deliveryId: dgS_ab-cd_ef12345678'
    ),
    line('NotificationService', 'nothing here'),
  ]);
  assert.deepStrictEqual(ids, ['dgS_ab-cd_ef12345678']);
});

test('the markers are anchored to the SDK’s own sentences', () => {
  // A bare /Successfully/ once reported three errored sends as passing.
  assert.ok(
    NSE_MARKERS.accepted.test("Successfully tracked push metric 'delivered'")
  );
  assert.ok(
    !NSE_MARKERS.accepted.test('Successfully did something else entirely')
  );
  assert.ok(NSE_MARKERS.tracking.test('Tracking push message delivered'));
  assert.ok(
    NSE_MARKERS.completion.test('invoking contentHandler — normal completion')
  );
});

test('the extension is identified by process, not by message text', () => {
  assert.strictEqual(
    ranInExtension([line('NotificationService', 'anything')]),
    true
  );
  assert.strictEqual(
    ranInExtension([
      line('APN UIKit', 'NotificationService mentioned in passing'),
    ]),
    false
  );
  // An extension named anything else is recognised by the name the project gives it.
  assert.strictEqual(
    ranInExtension([line('RichPushExtension', 'anything')], 'RichPushExtension'),
    true
  );
  assert.strictEqual(
    ranInExtension([line('RichPushExtension', 'anything')]),
    false
  );
});

test('the line only the extension writes stands in when the process name is lost', () => {
  const { extensionRanIn } = require('../../dist/verify/matrix/logs');
  assert.strictEqual(
    extensionRanIn([line('', '[Push] Tracking push message delivered with deliveryId: dgS_x')]),
    true
  );
  assert.strictEqual(extensionRanIn([line('APN UIKit', 'unrelated')]), false);
});

test('one failing cell fails the run, and the others still report', () => {
  const ladder = new Ladder();
  ladder.addMatrix({
    metric: 'delivered',
    cells: [
      { state: 'killed', verdict: 'pass', evidence: [] },
      {
        state: 'background',
        verdict: 'fail',
        cause: 'runtime.nse_did_not_run',
        evidence: ['no extension lines'],
      },
      { state: 'foreground', verdict: 'pass', evidence: [] },
    ],
  });
  assert.strictEqual(ladder.verdict, 'fail');
  assert.deepStrictEqual(
    ladder.causes().map((c) => c.code),
    ['runtime.nse_did_not_run']
  );
  assert.strictEqual(ladder.causes()[0].stage, 'delivered_matrix');
});

test('an unsent matrix keeps the verdict inconclusive even when preflight passed', () => {
  const ladder = new Ladder();
  ladder.adopt({
    id: 'project_wiring',
    title: 'Project wiring',
    checks: [{ id: 'a', verdict: 'pass', label: 'fine' }],
  });
  ladder.addMatrix({
    metric: 'delivered',
    cells: [],
    skipped: 'no push was sent',
  });
  assert.strictEqual(ladder.verdict, 'skip');
  assert.strictEqual(ladder.exitCode, 21);
});

test('all cells passing with a clean climb is the only way to exit zero', () => {
  const ladder = new Ladder();
  ladder.adopt({
    id: 'project_wiring',
    title: 'Project wiring',
    checks: [{ id: 'a', verdict: 'pass', label: 'fine' }],
  });
  ladder.addMatrix({
    metric: 'delivered',
    cells: [
      { state: 'killed', verdict: 'pass', evidence: [] },
      { state: 'background', verdict: 'pass', evidence: [] },
      { state: 'foreground', verdict: 'pass', evidence: [] },
    ],
  });
  assert.strictEqual(ladder.verdict, 'pass');
  assert.strictEqual(ladder.exitCode, 0);
});

test('with no id from the send, a cell must count an id no earlier cell saw', () => {
  // The route that keeps the workspace credential untouched returns no delivery id, so
  // freshness is the correlation: a leftover delivery would otherwise pass three times.
  assert.deepStrictEqual(
    judge({
      available: true,
      arrived: true,
      extensionRan: true,
      accepted: true,
      sawLines: true,
      loggedIds: ['dgS_first'],
      freshIds: [],
    }),
    { verdict: 'warn', cause: 'runtime.delivery_id_mismatch' }
  );
  assert.deepStrictEqual(
    judge({
      available: true,
      arrived: true,
      extensionRan: true,
      accepted: true,
      sawLines: true,
      loggedIds: ['dgS_first', 'dgS_second'],
      freshIds: ['dgS_second'],
    }),
    { verdict: 'pass' }
  );
});

test('a stream that attached and saw nothing blames the capture, not the extension', () => {
  // idevicesyslog rejects `-p` together with `-K`: it prints usage, exits, and every cell
  // then looked like the invisible failure. Silence is not evidence.
  assert.deepStrictEqual(
    judge({
      available: true,
      arrived: undefined,
      extensionRan: false,
      accepted: false,
      sawLines: false,
      loggedIds: [],
      freshIds: [],
    }),
    { verdict: 'skip', cause: 'runtime.no_evidence' }
  );
});

test('an extension that runs and never forwards passes on the device; wiring names it', () => {
  // Arm B3: the extension is embedded and entitled, the push displays, and the SDK is never
  // handed the request. On the device that is a push received; the static wiring check
  // (wiring.nse_does_not_forward) names the missing call, and only Customer.io's record can
  // show that nothing was counted.
  assert.deepStrictEqual(
    judge({
      available: true,
      arrived: true,
      extensionRan: true,
      sawLines: true,
      loggedIds: [],
      freshIds: [],
    }),
    { verdict: 'pass' }
  );
});

test('an interrupted run cannot leave a log stream attached', () => {
  const { trackCapture } = require('../../dist/verify/matrix/logs');
  const before = process.listenerCount('SIGINT');
  const killed = [];
  const fake = {
    kill: (signal) => killed.push(signal),
    once: (event, handler) => (event === 'exit' ? undefined : handler),
  };
  trackCapture(fake);
  // The handlers are installed once, whatever the number of captures.
  trackCapture(fake);
  assert.ok(
    process.listenerCount('SIGINT') >= before,
    'no interrupt handler was installed'
  );

  // The exit path kills what is still live: a leftover stream against the same target
  // makes the next run's capture silently return nothing.
  process.emit('exit', 0);
  assert.deepStrictEqual(killed, ['SIGKILL']);
});

test('a target that will not deliver a local push convicts nothing', () => {
  const nothingArrived = {
    available: true,
    arrived: false,
    extensionRan: false,
    tracked: false,
    accepted: false,
    sawLines: true,
    loggedIds: [],
    freshIds: [],
  };

  // The old behaviour, kept for a target that is demonstrably healthy: the push is the
  // thing that failed.
  assert.deepStrictEqual(judge({ ...nothingArrived, localProbe: 'landed' }), {
    verdict: 'fail',
    cause: 'runtime.push_never_arrived',
  });

  // A stuck target is not evidence about the integration — it is the absence of evidence,
  // so the cell is inconclusive rather than a conviction.
  assert.deepStrictEqual(judge({ ...nothingArrived, localProbe: 'absent' }), {
    verdict: 'skip',
    cause: 'device.notifications_wedged',
  });

  // No probe available (a physical device) leaves the verdict where it was.
  assert.deepStrictEqual(
    judge({ ...nothingArrived, localProbe: 'unavailable' }),
    { verdict: 'fail', cause: 'runtime.push_never_arrived' }
  );
  assert.deepStrictEqual(judge(nothingArrived), {
    verdict: 'fail',
    cause: 'runtime.push_never_arrived',
  });
});

test('a definite no-arrival outranks a silent log, because the store is independent of it', () => {
  // The store said nothing new and the target passed its local probe: the push did not
  // land, and reporting that as "no evidence" while holding this evidence is wrong.
  assert.deepStrictEqual(
    judge({
      available: true,
      arrived: false,
      extensionRan: false,
      tracked: false,
      accepted: false,
      sawLines: false,
      loggedIds: [],
      freshIds: [],
      localProbe: 'landed',
    }),
    { verdict: 'fail', cause: 'runtime.push_never_arrived' }
  );

  // Arrival unknown (a physical device has no store to read) keeps the old reading: a
  // silent log is the capture's problem, not the extension's.
  assert.deepStrictEqual(
    judge({
      available: true,
      arrived: undefined,
      extensionRan: false,
      tracked: false,
      accepted: false,
      sawLines: false,
      loggedIds: [],
      freshIds: [],
    }),
    { verdict: 'skip', cause: 'runtime.no_evidence' }
  );
});

test('the re-send goes out the same way as the first send, Firebase included', () => {
  const options = {
    environmentId: '122175',
    token: 'fcm-token',
    sandbox: true,
    provider: 'fcm',
  };
  const first = deliveredRequest(options, 'cio verify · killed');
  const retry = deliveredRequest(options, 'cio verify · killed · 9DG62');
  for (const request of [first, retry]) {
    assert.strictEqual(request.provider, 'fcm');
    assert.strictEqual(request.platform, 'ios');
    assert.strictEqual(request.sandbox, true);
  }
  assert.strictEqual(retry.title, 'cio verify · killed · 9DG62');
});

const { explainNotificationsOff } = require('../../dist/verify/matrix');

test('silence in every state with notifications off is named as that, once', () => {
  // The iPhone run of 2026-10-13, before notifications were allowed for the app.
  const silent = {
    metric: 'delivered',
    cells: [
      {
        state: 'killed',
        verdict: 'skip',
        cause: 'runtime.no_evidence',
        evidence: ['log: 0 lines'],
      },
      {
        state: 'background',
        verdict: 'skip',
        cause: 'runtime.no_evidence',
        evidence: ['log: 0 lines'],
      },
      {
        state: 'foreground',
        verdict: 'fail',
        cause: 'runtime.nse_did_not_run',
        evidence: ['log: 215 lines'],
      },
    ],
  };
  const explained = explainNotificationsOff(silent, true);
  assert.deepStrictEqual(
    explained.cells.map((cell) => [cell.verdict, cell.cause]),
    [
      ['fail', 'device.notifications_disabled'],
      ['fail', 'device.notifications_disabled'],
      ['fail', 'device.notifications_disabled'],
    ]
  );
  assert.match(
    explained.cells[2].evidence.at(-1),
    /was: runtime\.nse_did_not_run/
  );

  const ladder = new Ladder();
  ladder.addMatrix(explained);
  const causes = ladder.causes();
  assert.deepStrictEqual(
    causes.map((cause) => cause.code),
    ['device.notifications_disabled'],
    'one finding, not one per state'
  );
  assert.match(causes[0].remedy, /allow notifications/);
  assert.strictEqual(
    explained.cells[0].evidence.length,
    2,
    'merging the evidence rewrote the first cell'
  );
});

test('notifications-off is not claimed when anything arrived, or when the profile says on', () => {
  const mixed = {
    metric: 'delivered',
    cells: [
      {
        state: 'killed',
        verdict: 'fail',
        cause: 'runtime.push_never_arrived',
        evidence: [],
      },
      { state: 'foreground', verdict: 'pass', evidence: [] },
    ],
  };
  assert.strictEqual(explainNotificationsOff(mixed, true), mixed);

  const silentButOn = {
    metric: 'delivered',
    cells: [
      {
        state: 'killed',
        verdict: 'fail',
        cause: 'runtime.push_never_arrived',
        evidence: [],
      },
    ],
  };
  assert.strictEqual(explainNotificationsOff(silentButOn, false), silentButOn);
});

const { explainSdkSilence, SDK_PUSH_LINE } = require('../../dist/verify/matrix/logs');

test('an app that logged while the SDK wrote nothing names the log level, not the push', () => {
  const cells = [
    { state: 'killed', verdict: 'skip', cause: 'runtime.tap_not_seen', evidence: [] },
    { state: 'background', verdict: 'fail', cause: 'runtime.push_not_handled', evidence: [] },
    { state: 'foreground', verdict: 'pass', evidence: [] },
    { state: 'killed', verdict: 'fail', cause: 'runtime.push_never_arrived', evidence: [] },
  ];
  const quiet = explainSdkSilence(cells, {
    appSpoke: true,
    sdkSpoke: false,
    how: "the app's processes logged",
  });
  assert.deepStrictEqual(
    quiet.map((cell) => [cell.verdict, cell.cause]),
    [
      ['skip', 'runtime.sdk_logging_off'],
      ['skip', 'runtime.sdk_logging_off'],
      ['pass', undefined],
      // Arrival is read from the OS, so a push that never arrived still never arrived.
      ['fail', 'runtime.push_never_arrived'],
    ]
  );
  assert.match(quiet[0].evidence[0], /not one \[Push\] line.*was: runtime\.tap_not_seen/);

  // Either signal missing leaves the cells alone.
  assert.strictEqual(
    explainSdkSilence(cells, { appSpoke: true, sdkSpoke: true, how: 'x' }),
    cells
  );
  assert.strictEqual(
    explainSdkSilence(cells, { appSpoke: false, sdkSpoke: false, how: 'x' }),
    cells
  );
});

test('an SDK line is one the SDK tagged, not any bracketed framework line', () => {
  assert.ok(SDK_PUSH_LINE.test('[Push] Received new message with deliveryId: x'));
  assert.ok(!SDK_PUSH_LINE.test('[TLSCBQ] something from CFNetwork'));
  assert.ok(!SDK_PUSH_LINE.test('Pushing a view controller'));
});
