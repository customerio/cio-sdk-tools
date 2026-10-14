const test = require('node:test');
const assert = require('node:assert');

const { formatMs, stopwatch } = require('../../dist/verify/core/clock');

test('durations read at the scale a developer thinks in', () => {
  assert.strictEqual(formatMs(0), '0ms');
  assert.strictEqual(formatMs(312), '312ms');
  assert.strictEqual(formatMs(999), '999ms');
  assert.strictEqual(formatMs(1_000), '1.0s');
  assert.strictEqual(formatMs(9_040), '9.0s');
  assert.strictEqual(formatMs(59_999), '60.0s');
  assert.strictEqual(formatMs(60_000), '1m00s');
  assert.strictEqual(formatMs(151_000), '2m31s');
});

test('a stopwatch measures forward and can be read more than once', async () => {
  const elapsed = stopwatch();
  await new Promise((resolve) => setTimeout(resolve, 25));
  const first = elapsed();
  assert.ok(first >= 20, `expected >=20ms, got ${first}`);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(elapsed() >= first, 'a second read went backwards');
});
