const test = require('node:test');
const assert = require('node:assert');

const { createReporter, visibleLength } = require('../../dist/verify/report');
const { run, setTracer } = require('../../dist/verify/exec');

const sink = () => {
  const written = [];
  return {
    written,
    stream: { write: (chunk) => written.push(String(chunk)), isTTY: false },
    text: () => written.join(''),
  };
};

const reporterOn = (level, out) =>
  createReporter({ level, out: out.stream, err: out.stream, spinners: false });

const rung = (title, checks, extra = {}) => ({
  id: 'project_wiring',
  title,
  checks,
  ...extra,
});

const report = (overrides = {}) => ({
  schema: 1,
  provenance: 'read',
  tool: { name: 'cio-sdk-tools', version: '1.8.0' },
  command: 'verify push',
  startedAt: '2026-09-17T00:00:00.000Z',
  finishedAt: '2026-09-17T00:00:05.300Z',
  project: { path: '/p', framework: 'iOS' },
  rungs: [],
  verdict: 'pass',
  causes: [],
  exitCode: 0,
  ...overrides,
});

test('the roll-up shows one line per rung and hides the evidence behind a pass', () => {
  const out = sink();
  const reporter = reporterOn('human', out);
  const handle = reporter.rung('Device ready');
  handle.phase('reading the target');
  handle.done(
    rung(
      'Device ready',
      [
        { id: 'installed', verdict: 'pass', label: 'App is installed' },
        {
          id: 'token',
          verdict: 'pass',
          label: 'SDK holds a push token',
          evidence: ['806f516ee6e5… (160 chars)'],
        },
      ],
      { summary: 'cio-verify-poc · token 806f516e…', durationMs: 3_300 }
    )
  );

  const text = out.text();
  assert.match(text, /Device ready\s+cio-verify-poc · token 806f516e…\s+3\.3s/);
  assert.ok(!text.includes('App is installed'), 'a passing check was printed');
  assert.ok(!text.includes('160 chars'), 'passing evidence was printed');
});

test('a rung that did not pass expands in place, because that is the detail worth having', () => {
  const out = sink();
  const reporter = reporterOn('human', out);
  reporter.rung('Profile linked').done(
    rung('Profile linked', [
      { id: 'exists', verdict: 'pass', label: 'Profile exists' },
      {
        id: 'linked',
        verdict: 'fail',
        label: 'This device is linked to the profile',
        evidence: ['target token: 806f…'],
        cause: 'profile.token_not_linked',
      },
    ])
  );

  const text = out.text();
  assert.ok(!text.includes('Profile exists'), 'the passing check leaked');
  assert.match(text, /This device is linked to the profile/);
  assert.match(text, /target token: 806f…/);
  assert.match(text, /profile\.token_not_linked/);
});

test('verbose shows every check, and the command trace it installs', async () => {
  const out = sink();
  const reporter = reporterOn('verbose', out);
  reporter.rung('Device ready').done(
    rung('Device ready', [
      {
        id: 'installed',
        verdict: 'pass',
        label: 'App is installed',
        evidence: ['io.customer.sample'],
      },
    ])
  );
  await run('echo', ['traced']);
  setTracer(undefined);

  const text = out.text();
  assert.match(text, /App is installed/);
  assert.match(text, /io\.customer\.sample/);
  assert.match(text, /\$ echo traced\s+exit 0 · \d+/);
});

test('quiet prints the verdict and what to do about it, and nothing else', () => {
  const out = sink();
  const reporter = reporterOn('quiet', out);
  reporter.start('APN UIKit');
  reporter.rung('Device ready').done(rung('Device ready', []));
  reporter.summary(
    report({
      verdict: 'fail',
      exitCode: 20,
      rungs: [
        rung('Profile linked', [
          { id: 'linked', verdict: 'fail', label: 'linked', cause: 'x' },
        ]),
      ],
      causes: [
        {
          code: 'profile.token_not_linked',
          stage: 'profile_linked',
          severity: 'blocker',
          summary: 'The profile has devices, but not this one.',
          remedy: 'Re-identify after the token was issued.',
          evidence: [],
        },
      ],
    })
  );

  const text = out.text();
  assert.ok(!text.includes('APN UIKit'), 'the header printed in quiet mode');
  assert.ok(!text.includes('Device ready'), 'a rung line printed in quiet mode');
  assert.match(text, /The profile has devices, but not this one\./);
  assert.match(text, /Re-identify after the token was issued\./);
  assert.match(text, /stopped at rung 1 — Profile linked\./);
});

test('json mode writes nothing — stdout belongs to the report', () => {
  const out = sink();
  const reporter = reporterOn('json', out);
  reporter.start('APN UIKit');
  reporter.rung('Device ready').done(rung('Device ready', []));
  reporter.matrix('adb logcat');
  reporter.summary(report());
  assert.strictEqual(out.text(), '');
});

test('the closing line carries the total, the provenance and the evidence path', () => {
  for (const [provenance, expected] of [
    ['read', /5\.3s · read/],
    ['observed', /5\.3s · observed/],
  ]) {
    const out = sink();
    reporterOn('human', out).summary(
      report({
        provenance,
        matrices: [
          {
            metric: 'delivered',
            cells: [],
            logs: { evidencePath: '/tmp/ev.log' },
          },
        ],
      })
    );
    const text = out.text();
    assert.match(text, expected);
    assert.match(text, /evidence \/tmp\/ev\.log/);
    assert.match(text, /push works, and the delivery was counted\./);
  }
});

test('a cell reports counted without its evidence, and expands when it did not', () => {
  const out = sink();
  const reporter = reporterOn('human', out);
  const good = reporter.cell('killed');
  good.phase('sending');
  good.done({
    state: 'killed',
    verdict: 'pass',
    evidence: ['log: 79 lines'],
    durationMs: 12_400,
  });
  reporter.cell('background').done({
    state: 'background',
    verdict: 'fail',
    cause: 'runtime.nse_did_not_forward',
    evidence: ['log: 120 lines'],
    durationMs: 45_000,
  });

  const text = out.text();
  assert.match(text, /killed\s+counted\s+12\.4s/);
  assert.ok(!text.includes('79 lines'), 'a passing cell printed its evidence');
  assert.match(text, /background\s+runtime\.nse_did_not_forward\s+45\.0s/);
  assert.match(text, /log: 120 lines/);
});

test('a handle times what it wraps, but never overwrites a measured duration', async () => {
  const out = sink();
  const reporter = reporterOn('human', out);
  const measured = rung('Workspace ready', [], { durationMs: 9_040 });
  reporter.rung('Workspace ready').done(measured);
  assert.strictEqual(measured.durationMs, 9_040);

  const unmeasured = rung('Device ready', []);
  const handle = reporter.rung('Device ready');
  await new Promise((resolve) => setTimeout(resolve, 20));
  handle.done(unmeasured);
  assert.ok(
    unmeasured.durationMs >= 15,
    `expected a measured duration, got ${unmeasured.durationMs}`
  );
});

test('padding counts what a terminal draws, not what chalk adds', () => {
  assert.strictEqual(visibleLength('plain'), 5);
  assert.strictEqual(visibleLength('[32m✔[39m ok'), 4);
});

test('a matrix that never ran still says why', () => {
  const out = sink();
  reporterOn('human', out).summary(
    report({
      verdict: 'skip',
      exitCode: 21,
      matrices: [
        {
          metric: 'delivered',
          cells: [],
          skipped: 'no push was sent — pass --send',
        },
        {
          metric: 'opened',
          cells: [],
          skipped: 'opened needs a real tap, and this run cannot ask for one',
        },
      ],
    })
  );
  const text = out.text();
  // Streaming output only prints sections that ran, so a skipped one has to be reported
  // in the summary or its reason disappears.
  assert.match(text, /delivered matrix\n\s+no push was sent — pass --send/);
  assert.match(text, /opened matrix\n\s+opened needs a real tap/);
});

test('a prompt gets the terminal to itself', () => {
  const out = sink();
  // Spinners on: the pause/resume pair is what a question relies on, so it has to work
  // when there is actually something painting.
  const reporter = createReporter({
    level: 'human',
    out: out.stream,
    err: out.stream,
    spinners: false,
  });
  const cell = reporter.cell('killed');
  cell.phase('sending');
  reporter.pause();
  out.written.length = 0;
  // While paused, nothing repaints over whatever is being asked.
  cell.phase('still sending');
  assert.strictEqual(
    out.written.join(''),
    '',
    'the reporter wrote over a prompt'
  );
  reporter.resume();
  cell.done({ state: 'killed', verdict: 'pass', evidence: [] });
  assert.match(out.text(), /killed/);
});
