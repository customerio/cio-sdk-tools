const test = require('node:test');
const assert = require('node:assert');

const { openPidWindow, parsePidList } = require('../../dist/verify/platform/ios/pid_window');

const phone = { kind: 'device', udid: '00008120-TEST', name: 'iPhone' };

/**
 * A phone played by a script: the process list it answers with, read by read, and the pid
 * streams the window opens. Time is a counter, so "connected before the read" is exact.
 */
function fakePhone(lists) {
  let clock = 0;
  let reads = 0;
  const streams = new Map();
  const capture = {
    available: true,
    followProcess: (pid, only) => {
      const connectedAt = ++clock;
      const stream = {
        pid,
        how: `idevicesyslog -p ${pid}`,
        only,
        connected: Promise.resolve({ connected: true, how: `idevicesyslog -p ${pid}` }),
        connectedAt: () => connectedAt,
        foreign: () => false,
        ours: () => false,
        stopped: false,
        stop() { this.stopped = true; },
      };
      streams.set(pid, stream);
      return stream;
    },
  };
  const deps = {
    now: () => ++clock,
    refreshMs: 60_000,
    pidList: async () => {
      const list = lists[Math.min(reads, lists.length - 1)];
      reads += 1;
      return list && new Map(list);
    },
  };
  return { capture, deps, streams, reads: () => reads };
}

const base = [[1, 'launchd'], [1182, 'SpringBoard']];

test('the next eight pids are watched, and a launch into one of them is read from its first line', async () => {
  const phoneState = fakePhone([
    base,                       // first read: the window is 1183..1190
    base,                       // after the streams connect: the app is not there yet
    [...base, [1183, 'APN UIKit'], [1184, 'LiveActivityExtension']], // after the tap
  ]);
  const { window } = await openPidWindow(phone, phoneState.capture, 'APN UIKit', phoneState.deps);
  assert.deepStrictEqual([...phoneState.streams.keys()], [1183, 1184, 1185, 1186, 1187, 1188, 1189, 1190]);
  assert.deepStrictEqual(phoneState.streams.get(1183).only, ['APN UIKit']);

  const outcome = await window.stop();
  assert.deepStrictEqual(outcome.caught, {
    pid: 1183,
    slot: 1,
    fromFirstLine: true,
    how: 'idevicesyslog -p 1183',
  });
  // Every other pid's stream is closed; the app's stays open for the rest of the run.
  for (const [pid, stream] of phoneState.streams) {
    assert.strictEqual(stream.stopped, pid !== 1183, `pid ${pid}`);
  }
});

test('pids other processes take are let go, and the window moves along', async () => {
  const busy = [...base, [1183, 'mobileassetd'], [1184, 'cfprefsd'], [1185, 'searchd']];
  const phoneState = fakePhone([base, base, busy, [...busy, [1186, 'APN UIKit']]]);
  phoneState.deps.refreshMs = 1;
  const { window } = await openPidWindow(phone, phoneState.capture, 'APN UIKit', phoneState.deps);
  // Let the window refresh until it has read the list in which the app appears.
  while (phoneState.reads() < 4) await new Promise((resolve) => setTimeout(resolve, 1));
  const outcome = await window.stop();
  // The pids taken by others were let go, and new ones past them opened.
  for (const pid of [1183, 1184, 1185]) assert.strictEqual(phoneState.streams.get(pid).stopped, true);
  assert.ok(phoneState.streams.has(1193));
  assert.deepStrictEqual(outcome.caught, { pid: 1186, slot: 1, fromFirstLine: true, how: 'idevicesyslog -p 1186' });
});

test('an app that lands past the watched pids is a miss, said with the range', async () => {
  const phoneState = fakePhone([base, base, [...base, [1199, 'APN UIKit']]]);
  const { window } = await openPidWindow(phone, phoneState.capture, 'APN UIKit', phoneState.deps);
  const outcome = await window.stop();
  assert.deepStrictEqual(outcome.missed, { pid: 1199, from: 1183, to: 1190 });
});

test('an app already running before the window is not a launch from the tap', async () => {
  const running = [...base, [900, 'APN UIKit']];
  const phoneState = fakePhone([running, running, running]);
  const { window } = await openPidWindow(phone, phoneState.capture, 'APN UIKit', phoneState.deps);
  const outcome = await window.stop();
  assert.strictEqual(outcome.caught, undefined);
  assert.strictEqual(outcome.missed, undefined);
});

test('a phone whose process list cannot be read is never watched', async () => {
  const phoneState = fakePhone([undefined]);
  const result = await openPidWindow(phone, phoneState.capture, 'APN UIKit', phoneState.deps);
  assert.match(result.unavailableReason, /idevicesyslog pidlist/);
  assert.strictEqual(phoneState.streams.size, 0);
});

test('the process list parses, and a long name cut short still matches', async () => {
  const pids = parsePidList('1 launchd\n32 logd\n1183 APN UIKit\n1184 UserNotificationsUIThumbnailPro\n');
  assert.strictEqual(pids.get(1183), 'APN UIKit');
  assert.strictEqual(pids.size, 4);
  assert.strictEqual(parsePidList(''), undefined);
});
