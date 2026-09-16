const test = require('node:test');
const assert = require('node:assert');

const { judge } = require('../../dist/verify/matrix');
const {
  NSE_MARKERS,
  deliveryIdsIn,
  ranInExtension,
} = require('../../dist/verify/matrix/logs');
const { Ladder } = require('../../dist/verify/ladder');

const line = (process, message) => ({ at: '00:00:00.000', process, message });

test('arrived but never processed is a different failure from never arrived', () => {
  assert.deepStrictEqual(
    judge({ available: true, arrived: true, extensionRan: false, accepted: false, loggedIds: [] }),
    { verdict: 'fail', cause: 'runtime.nse_did_not_run' }
  );
  assert.deepStrictEqual(
    judge({ available: true, arrived: false, extensionRan: false, accepted: false, loggedIds: [] }),
    { verdict: 'fail', cause: 'runtime.push_never_arrived' }
  );
});

test('the extension running without the metric landing is its own cause', () => {
  assert.deepStrictEqual(
    judge({ available: true, arrived: true, extensionRan: true, accepted: false, loggedIds: [] }),
    { verdict: 'fail', cause: 'runtime.metric_not_accepted' }
  );
});

test('a cell proves nothing without a log, and says so rather than passing', () => {
  assert.deepStrictEqual(
    judge({ available: false, arrived: undefined, extensionRan: false, accepted: false, loggedIds: [] }),
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
      sentId: 'dgS_aaa',
      loggedIds: ['dgS_bbb'],
    }),
    { verdict: 'warn', cause: 'runtime.delivery_id_mismatch' }
  );
  assert.deepStrictEqual(
    judge({
      available: true,
      arrived: true,
      extensionRan: true,
      accepted: true,
      sentId: 'dgS_aaa',
      loggedIds: ['dgS_aaa'],
    }),
    { verdict: 'pass' }
  );
});

test('a send whose id the log never mentions still passes on the metric', () => {
  // The id is absent from plenty of real captures; requiring it would fail correct runs.
  assert.deepStrictEqual(
    judge({ available: true, arrived: true, extensionRan: true, accepted: true, sentId: 'dgS_aaa', loggedIds: [] }),
    { verdict: 'pass' }
  );
});

test('base64url delivery ids are recognised, underscores and dashes included', () => {
  const ids = deliveryIdsIn([
    line('NotificationService', "Tracking push message delivered, deliveryId: dgS_ab-cd_ef12345678"),
    line('NotificationService', 'nothing here'),
  ]);
  assert.deepStrictEqual(ids, ['dgS_ab-cd_ef12345678']);
});

test('the markers are anchored to the SDK’s own sentences', () => {
  // A bare /Successfully/ once reported three errored sends as passing.
  assert.ok(NSE_MARKERS.accepted.test("Successfully tracked push metric 'delivered'"));
  assert.ok(!NSE_MARKERS.accepted.test('Successfully did something else entirely'));
  assert.ok(NSE_MARKERS.tracking.test('Tracking push message delivered'));
  assert.ok(NSE_MARKERS.completion.test('invoking contentHandler — normal completion'));
});

test('the extension is identified by process, not by message text', () => {
  assert.strictEqual(ranInExtension([line('NotificationService', 'anything')]), true);
  assert.strictEqual(
    ranInExtension([line('APN UIKit', 'NotificationService mentioned in passing')]),
    false
  );
});

test('one failing cell fails the run, and the others still report', () => {
  const ladder = new Ladder();
  ladder.setMatrix({
    metric: 'delivered',
    cells: [
      { state: 'killed', verdict: 'pass', evidence: [] },
      { state: 'background', verdict: 'fail', cause: 'runtime.nse_did_not_run', evidence: ['no extension lines'] },
      { state: 'foreground', verdict: 'pass', evidence: [] },
    ],
  });
  assert.strictEqual(ladder.verdict, 'fail');
  assert.deepStrictEqual(ladder.causes().map((c) => c.code), ['runtime.nse_did_not_run']);
  assert.strictEqual(ladder.causes()[0].stage, 'delivered_matrix');
});

test('an unsent matrix keeps the verdict inconclusive even when preflight passed', () => {
  const ladder = new Ladder();
  ladder.adopt({
    id: 'project_wiring',
    title: 'Project wiring',
    checks: [{ id: 'a', verdict: 'pass', label: 'fine' }],
  });
  ladder.setMatrix({ metric: 'delivered', cells: [], skipped: 'no push was sent' });
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
  ladder.setMatrix({
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
