const test = require('node:test');
const assert = require('node:assert');

const { watchFor, freshness } = require('../../dist/verify/observe');
const { installTimesFrom } = require('../../dist/verify/android/device');
const { createAsker } = require('../../dist/verify/prompt');

const asker = createAsker({ interactive: false });
const opts = (extra = {}) => ({ asker, intervalMs: 5, timeoutMs: 400, ...extra });

test('a fact that is already true is not waited for, and no instruction is printed', async () => {
  const instructions = [];
  const seen = await watchFor(
    {
      label: 'push token',
      instruction: 'Launch the app.',
      probe: async () => 'TOKEN',
    },
    opts({ onInstruction: (text) => instructions.push(text) })
  );
  assert.strictEqual(seen.value, 'TOKEN');
  // `at` is what separates watching from reading: nothing was watched here.
  assert.strictEqual(seen.at, undefined);
  assert.deepStrictEqual(instructions, []);
});

test('a fact that appears later is timestamped, and the instruction is printed once', async () => {
  const instructions = [];
  const phases = [];
  let ticks = 0;
  const seen = await watchFor(
    {
      label: 'push token',
      instruction: 'Launch the app so the SDK registers a token.',
      probe: async () => (++ticks >= 3 ? 'TOKEN' : undefined),
    },
    opts({
      onInstruction: (text) => instructions.push(text),
      onPhase: (text) => phases.push(text),
    })
  );
  assert.strictEqual(seen.value, 'TOKEN');
  assert.ok(seen.at instanceof Date, 'the moment it appeared was not recorded');
  assert.strictEqual(seen.timedOut, false);
  assert.strictEqual(instructions.length, 1);
  assert.ok(phases.length >= 1, 'a wait with no progress line looks like a hang');
});

test('a fact that never appears times out instead of blocking the run', async () => {
  const seen = await watchFor(
    { label: 'login', instruction: 'Log in.', probe: async () => undefined },
    opts()
  );
  assert.strictEqual(seen.timedOut, true);
  assert.strictEqual(seen.value, undefined);
  assert.ok(seen.waitedMs >= 400);
});

test('freshness is advice, and it knows the difference between old and unwatched', () => {
  const now = new Date('2026-09-17T12:00:00Z');
  assert.strictEqual(freshness({ observed: true }).verdict, 'observed');
  assert.strictEqual(freshness({}).verdict, 'unknown');
  assert.strictEqual(
    freshness({ installedAt: new Date('2026-09-17T11:30:00Z'), now }).verdict,
    'fresh'
  );

  const stale = freshness({
    installedAt: new Date('2026-09-16T15:00:00Z'),
    now,
  });
  assert.strictEqual(stale.verdict, 'stale');
  assert.match(stale.note, /installed 21 hours ago/);

  const older = freshness({
    installedAt: new Date('2026-09-10T12:00:00Z'),
    now,
  });
  assert.match(older.note, /installed 7 days ago/);
});

test('install time comes out of the dump we already read, newest first', () => {
  const dump = `
    Package [io.customer.sample] (abc):
      userId=10123
      firstInstallTime=2026-09-07 21:06:29
      lastUpdateTime=2026-09-16 23:40:40
  `;
  const times = installTimesFrom(dump);
  assert.strictEqual(times.firstInstall.getFullYear(), 2026);
  // lastUpdateTime is the one that answers "when did this build go on".
  assert.strictEqual(times.lastUpdate.getDate(), 16);
  assert.deepStrictEqual(installTimesFrom('nothing here'), {
    firstInstall: undefined,
    lastUpdate: undefined,
  });
});
