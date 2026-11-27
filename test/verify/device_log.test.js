const test = require('node:test');
const assert = require('node:assert');
const { matches } = require('../../dist/verify/areas/push/on_device/markers');
const fs = require('fs');
const path = require('path');

const { NSE_MARKERS, deliveryIdsIn, ranInExtension } = require('../../dist/verify/areas/push/on_device/sdk_lines');
const { parseSyslog } = require('../../dist/verify/platform/ios/logs');
const { judge } = require('../../dist/verify/areas/push/on_device');

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
  const tracked = lines.filter((line) => matches(NSE_MARKERS.accepted, line.message));
  assert.ok(tracked.length > 0, 'no accepted marker parsed out of the real capture');
  for (const line of tracked) {
    assert.strictEqual(line.process, 'NotificationServiceExtension');
    assert.match(line.at, /^Sep 17 \d\d:\d\d:\d\d\.\d+$/);
  }
});

test('the real capture shows one full sequence per app state', () => {
  const count = (marker) =>
    lines.filter((line) => matches(marker, line.message)).length;
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
        tracked: true,
        accepted: true,
        sawLines: true,
        loggedIds: [id],
        freshIds: fresh,
      }),
      { verdict: 'pass' }
    );
  }
});

test('the extension running is read from the real capture, by process', () => {
  const { extensionRanIn } = require('../../dist/verify/areas/push/on_device/sdk_lines');
  assert.strictEqual(extensionRanIn(lines, 'NotificationServiceExtension'), true);
  // Defence against the parser regression above: with every process name lost, the line
  // only the extension writes still shows it ran.
  const unattributed = lines.map((line) => ({ ...line, process: '' }));
  assert.strictEqual(extensionRanIn(unattributed), true);
});

test('the fixture carries no device token and no personal address', () => {
  const text = fixture.join('\n');
  assert.ok(!/\b[0-9a-f]{40,}\b/.test(text), 'a token-shaped string is in the fixture');
  assert.ok(!/@(?!example\.com)[\w-]+\.[\w.]+/.test(text), 'an address is in the fixture');
});

test('two streams of one phone give each line once, and a repeat within one stream twice', () => {
  const { createLineSink } = require('../../dist/verify/platform/ios/logs');
  const sink = createLineSink();
  const line = (at, message = '[Push] Clicked CIO push message') => ({ at: `Oct 14 17:01:${at}`, process: 'APN UIKit', message });
  // One stream alone is never thinned: a line logged twice is two lines.
  sink.add(line('46.563720'));
  sink.add(line('46.563720'));
  assert.strictEqual(sink.lines.length, 2);

  // Once a pid is followed, the two streams stamp the same line some microseconds apart.
  sink.dedupe();
  const mark = sink.mark();
  sink.add(line('47.000000'), 'followed');
  sink.add(line('47.000042'), 'main');
  // The app logging the same sentence again is a second line, in both streams.
  sink.add(line('47.000300'), 'followed');
  sink.add(line('47.000342'), 'main');
  // Further apart than any two copies have been is a different line.
  sink.add(line('47.010000'), 'main');
  sink.add({ at: '', process: '', message: '\tMain bundle   : [<null>]' }, 'followed');
  sink.add({ at: '', process: '', message: '\tMain bundle   : [<null>]' }, 'main');
  assert.deepStrictEqual(
    sink.since(mark).map((kept) => kept.at.slice(-9)),
    ['47.000000', '47.000300', '47.010000', '', '']
  );
});

test('a run can tell which stream dropped a line, and leaves the last second out', () => {
  const { createLineSink } = require('../../dist/verify/platform/ios/logs');
  const sink = createLineSink();
  const at = (s) => `Oct 14 17:30:${s}`;
  const app = (s, message) => ({ at: at(s), process: 'APN UIKit', message });
  // Before a pid is followed, nothing is compared.
  sink.add(app('01.000000', 'before the hold'));
  sink.dedupe();
  sink.add(app('02.000000', 'both'), 'followed');
  sink.add(app('02.000051', 'both'), 'main');
  sink.add(app('02.100000', 'dropped by the whole log'), 'followed');
  sink.add(app('02.200000', 'dropped by the held stream'), 'main');
  sink.add({ at: at('02.300000'), process: 'NotificationServiceExtension', message: 'another process' }, 'main');
  // Within a second of the newest line: possibly still on its way through the other stream.
  sink.add(app('04.500000', 'only just arrived'), 'followed');
  assert.deepStrictEqual(sink.compare('APN UIKit'), { both: 1, onlyFollowed: 1, onlyMain: 1 });
});

test("idevicesyslog's connect and disconnect banners are not log lines", () => {
  // As a line, the banner was all a silent stream delivered, and it read as the app talking.
  assert.deepStrictEqual(parseSyslog('[connected:00008120-0014694A3E32601E]'), []);
  assert.deepStrictEqual(parseSyslog('[disconnected:00008120-0014694A3E32601E]'), []);
  assert.strictEqual(parseSyslog('\tMain bundle   : [<null>]').length, 1);
});
