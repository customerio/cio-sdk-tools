const test = require('node:test');
const assert = require('node:assert');

const { markLateArrivals, RATE_LIMITED_CAUSE } = require('../../dist/verify/areas/push/on_device/send');
const { explainSdkSilence, blameStoppedCapture } = require('../../dist/verify/areas/push/on_device/sdk_lines');
const { SILENT } = require('../../dist/verify/areas/push/on_device');
const { judgeOpened } = require('../../dist/verify/areas/push/on_device/opened');

const never = { state: 'killed', verdict: 'fail', cause: 'runtime.push_never_arrived', evidence: [] };

test('a re-sent state is late when either of its two pushes turns up after the cell', async () => {
  const cell = { ...never, title: 'first', retryTitle: 'second' };
  const [late] = await markLateArrivals([cell], async (title) => title === 'second');
  assert.strictEqual(late.cause, 'runtime.push_arrived_late');
  assert.match(late.evidence.at(-1), /"second" was on the target/);
  const [still] = await markLateArrivals([cell], async () => false);
  assert.strictEqual(still.cause, 'runtime.push_never_arrived');
});

test('a re-send the provider refused leaves the first push, which was accepted, able to be late', async () => {
  const refused = { state: 'killed', verdict: 'skip', cause: RATE_LIMITED_CAUSE, title: 'first', evidence: [] };
  const [late] = await markLateArrivals([refused], async (title) => title === 'first');
  assert.strictEqual(late.cause, 'runtime.push_arrived_late');
  // A refused first send has no title, so nothing is looked for.
  const [untouched] = await markLateArrivals([{ ...refused, title: undefined }], async () => true);
  assert.strictEqual(untouched.cause, RATE_LIMITED_CAUSE);
});

test('a miss the notification store proved is not rewritten as a capture that stopped', () => {
  assert.ok(!SILENT.includes('runtime.push_never_arrived'));
  const blamed = blameStoppedCapture({ ...never }, 'idevicesyslog exited', SILENT);
  assert.strictEqual(blamed.cause, 'runtime.push_never_arrived');
  const silent = blameStoppedCapture({ ...never, cause: 'runtime.no_evidence' }, 'idevicesyslog exited', SILENT);
  assert.strictEqual(silent.cause, 'runtime.capture_stopped');
});

test('cells re-judged for the SDK being quiet reprint under the section they belong to', () => {
  const printed = [];
  const reporter = { cell: (state, section) => ({ done: () => printed.push([state, section]) }) };
  const cells = [{ state: 'killed', verdict: 'fail', cause: 'runtime.opened_not_tracked', evidence: [] }];
  const quiet = { appSpoke: true, sdkSpoke: false, how: 'the app wrote lines' };
  explainSdkSilence(cells, quiet, reporter, 'opened');
  explainSdkSilence(cells, quiet, reporter);
  assert.deepStrictEqual(printed, [['killed', 'opened'], ['killed', undefined]]);
});

test('a deep link whose outcome line arrived was followed, even with its start line lost', () => {
  const tapped = {
    available: true, clicked: true, tracked: true, foreign: false, emptyId: false,
    linkAttempted: false, linkHandled: true, linkUnhandled: false, linkSent: true,
  };
  assert.deepStrictEqual(judgeOpened(tapped), { verdict: 'pass' });
  assert.strictEqual(judgeOpened({ ...tapped, linkHandled: false }).cause, 'runtime.deep_link_absent');
});
