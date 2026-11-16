const test = require('node:test');
const assert = require('node:assert');

const {
  Ladder,
  skipped,
  pass,
} = require('../../dist/verify/core/report/ladder');
const { registerCauses } = require('../../dist/verify/core/report/causes');
const { EXIT } = require('../../dist/verify/core/report/types');

registerCauses('ladder-causes-test', {
  'test.token_unreadable': {
    severity: 'warning',
    summary: 'The token could not be read.',
    remedy: 'Pass --token.',
  },
});

test('a check skipped for a named cause is inconclusive and reports that cause', () => {
  const ladder = new Ladder();
  const rung = ladder.open('device_ready', 'Device ready');
  rung.checks.push(pass('target', 'Target is available', []));
  rung.checks.push({
    ...skipped('token', 'SDK holds a token', 'the store was unreadable'),
    cause: 'test.token_unreadable',
  });

  assert.strictEqual(ladder.verdict, 'skip');
  assert.strictEqual(ladder.exitCode, EXIT.inconclusive);
  assert.deepStrictEqual(
    ladder.causes().map((cause) => cause.code),
    ['test.token_unreadable']
  );
  // The remedy is what a reader or an agent acts on.
  assert.match(ladder.causes()[0].remedy, /--token/);
});

test('a skipped check with no cause names nothing, and a pass never does', () => {
  const ladder = new Ladder();
  const rung = ladder.open('device_ready', 'Device ready');
  rung.checks.push(skipped('token', 'SDK holds a token', 'not run'));
  rung.checks.push({
    ...pass('target', 'Target is available', []),
    cause: 'test.token_unreadable',
  });
  assert.deepStrictEqual(ladder.causes(), []);
});
