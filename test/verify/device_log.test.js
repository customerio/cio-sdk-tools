const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  NSE_MARKERS,
  deliveryIdsIn,
  parseSyslog,
  ranInExtension,
} = require('../../dist/verify/matrix/logs');
const { judge } = require('../../dist/verify/matrix');

/**
 * A real capture from an iPhone 15, trimmed to the extension's own lines and scrubbed.
 * It exists because every device failure so far has been a parsing failure rather than an
 * integration one, and replaying the bytes is the only test that would have caught them.
 */
const fixture = fs
  .readFileSync(path.join(__dirname, 'fixtures', 'device-syslog.log'), 'utf8')
  .split('\n');

const lines = fixture.flatMap((line) => parseSyslog(line));

test('the process name survives fractional seconds and the logging image', () => {
  // `[\d:]+` never matches `02:52:47.994859`, so every line fell through unattributed —
  // and an extension that had run looked absent.
  const tracked = lines.filter((line) => NSE_MARKERS.accepted.test(line.message));
  assert.ok(tracked.length > 0, 'no accepted marker parsed out of the real capture');
  for (const line of tracked) {
    assert.strictEqual(line.process, 'NotificationServiceExtension');
    assert.match(line.at, /^Sep 17 \d\d:\d\d:\d\d\.\d+$/);
  }
});

test('the real capture shows one full sequence per app state', () => {
  const count = (marker) =>
    lines.filter((line) => marker.test(line.message)).length;
  assert.strictEqual(count(NSE_MARKERS.tracking), 3);
  assert.strictEqual(count(NSE_MARKERS.accepted), 3);
  assert.strictEqual(count(NSE_MARKERS.completion), 3);
  assert.strictEqual(ranInExtension(lines), true);
});

test('all three delivery ids come back, base64url padding and all', () => {
  const ids = deliveryIdsIn(lines);
  assert.strictEqual(ids.length, 3);
  assert.strictEqual(new Set(ids).size, 3);
  for (const id of ids) assert.match(id, /^dgS_[A-Za-z0-9_-]+={0,2}$/);
});

test('judged from the real capture, every cell passes', () => {
  const ids = deliveryIdsIn(lines);
  const seen = new Set();
  for (const id of ids) {
    const fresh = [id].filter((candidate) => !seen.has(candidate));
    seen.add(id);
    assert.deepStrictEqual(
      judge({
        available: true,
        arrived: undefined,
        extensionRan: true,
        accepted: true,
        sawLines: true,
        loggedIds: [id],
        freshIds: fresh,
      }),
      { verdict: 'pass' }
    );
  }
});

test('the metric landing outranks the process attribution', () => {
  // Defence against exactly the regression above: if the parser loses the process name,
  // an accepted metric must still read as a pass rather than an accusation.
  assert.deepStrictEqual(
    judge({
      available: true,
      arrived: undefined,
      extensionRan: false,
      accepted: true,
      sawLines: true,
      loggedIds: ['dgS_x'],
      freshIds: ['dgS_x'],
    }),
    { verdict: 'pass' }
  );
});

test('the fixture carries no device token and no personal address', () => {
  const text = fixture.join('\n');
  assert.ok(!/\b[0-9a-f]{40,}\b/.test(text), 'a token-shaped string is in the fixture');
  assert.ok(!/@(?!example\.com)[\w-]+\.[\w.]+/.test(text), 'an address is in the fixture');
});
