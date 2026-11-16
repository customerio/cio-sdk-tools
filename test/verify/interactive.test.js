const test = require('node:test');
const assert = require('node:assert');

const { canAsk } = require('../../dist/verify/core/run');

const tty = { isTTY: true };
const pipe = {};

test('a run can ask only when both ends are a terminal', () => {
  const base = { level: 'human', stdin: tty, stderr: tty };
  assert.strictEqual(canAsk(base), true);
  // Prompts are drawn on stderr: redirected, the question would be invisible.
  assert.strictEqual(canAsk({ ...base, stderr: pipe }), false);
  assert.strictEqual(canAsk({ ...base, stdin: pipe }), false);
});

test('--json and --non-interactive never ask', () => {
  const ends = { stdin: tty, stderr: tty };
  assert.strictEqual(canAsk({ ...ends, level: 'json' }), false);
  assert.strictEqual(
    canAsk({ ...ends, level: 'human', nonInteractive: true }),
    false
  );
});
