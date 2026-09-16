const test = require('node:test');
const assert = require('node:assert');

const { Ladder, fail, pass, warn, skipped } = require('../../dist/verify/ladder');
const { EXIT } = require('../../dist/verify/types');
const { resolveCause } = require('../../dist/verify/causes');

const rung = (id, title, checks) => ({ id, title, checks });

test('a failing rung halts the ladder and sets the failure exit code', () => {
  const ladder = new Ladder();
  ladder.adopt(
    rung('project_wiring', 'Project wiring', [
      pass('a', 'fine'),
      fail('b', 'broken', 'wiring.nse_missing', ['no extension targets']),
    ])
  );
  assert.strictEqual(ladder.halted, true);
  assert.strictEqual(ladder.verdict, 'fail');
  assert.strictEqual(ladder.exitCode, EXIT.verificationFailed);
  assert.deepStrictEqual(
    ladder.causes().map((c) => c.code),
    ['wiring.nse_missing']
  );
});

test('skipped is not passed — it gets its own exit code', () => {
  const ladder = new Ladder();
  ladder.adopt(rung('project_wiring', 'Project wiring', [pass('a', 'fine')]));
  ladder.skip('device_ready', 'Device ready', 'no device connected');
  assert.strictEqual(ladder.verdict, 'skip');
  assert.strictEqual(ladder.exitCode, EXIT.inconclusive);
});

test('a warning does not fail the run but is still named', () => {
  const ladder = new Ladder();
  ladder.adopt(
    rung('project_wiring', 'Project wiring', [
      pass('a', 'fine'),
      warn('b', 'worth a look', 'wiring.nse_does_not_forward'),
    ])
  );
  assert.strictEqual(ladder.halted, false);
  assert.strictEqual(ladder.verdict, 'warn');
  assert.strictEqual(ladder.exitCode, EXIT.ok);
  assert.strictEqual(ladder.causes()[0].severity, 'warning');
});

test('a rung of nothing but skips is a skip, not a pass', () => {
  const ladder = new Ladder();
  ladder.adopt(
    rung('project_wiring', 'Project wiring', [skipped('a', 'not run', 'no extension')])
  );
  assert.strictEqual(Ladder.verdictOf(ladder.toReport(meta()).rungs[0]), 'skip');
  assert.strictEqual(ladder.verdict, 'skip');
});

test('failure outranks skip, so a halt reads as broken rather than unproven', () => {
  const ladder = new Ladder();
  ladder.adopt(
    rung('project_wiring', 'Project wiring', [fail('a', 'broken', 'wiring.nse_missing')])
  );
  ladder.skip('device_ready', 'Device ready', 'earlier rung failed');
  assert.strictEqual(ladder.verdict, 'fail');
});

test('the report carries causes with their remedy, which is what the plugin reads', () => {
  const ladder = new Ladder();
  ladder.adopt(
    rung('project_wiring', 'Project wiring', [
      fail('a', 'broken', 'wiring.app_group_mismatch', ['code: group.a', 'extension: none']),
    ])
  );
  const report = ladder.toReport(meta());
  assert.strictEqual(report.schema, 1);
  assert.strictEqual(report.causes.length, 1);
  assert.strictEqual(report.causes[0].stage, 'project_wiring');
  assert.match(report.causes[0].remedy, /three places/);
  assert.deepStrictEqual(report.causes[0].evidence, ['code: group.a', 'extension: none']);
  assert.strictEqual(report.exitCode, EXIT.verificationFailed);
});

test('an unregistered cause code reports itself as a tool defect rather than vanishing', () => {
  const resolved = resolveCause('wiring.not_a_real_code');
  assert.match(resolved.summary, /Unregistered cause code/);
  assert.match(resolved.remedy, /defect in cio-sdk-tools/);
});

function meta() {
  return {
    schema: 1,
    tool: { name: 'cio-sdk-tools', version: '0.0.0' },
    command: 'verify push',
    startedAt: '2026-09-17T00:00:00.000Z',
    finishedAt: '2026-09-17T00:00:01.000Z',
    project: { path: '/tmp/App.xcodeproj', framework: 'iOS' },
  };
}
