const test = require('node:test');
const assert = require('node:assert');

const { createReporter, visibleLength } = require('../../dist/verify/core/report/render');
const { PUSH_VOICE } = require('../../dist/verify/areas/push/voice');
const { run, setTracer } = require('../../dist/verify/core/exec');

const sink = () => {
  const written = [];
  return {
    written,
    stream: { write: (chunk) => written.push(String(chunk)), isTTY: false },
    text: () => written.join(''),
  };
};

const reporterOn = (level, out) =>
  createReporter({ voice: PUSH_VOICE, level, out: out.stream, err: out.stream, spinners: false });

const rung = (title, checks, extra = {}) => ({
  id: 'project_wiring',
  title,
  checks,
  ...extra,
});

/** A report as the ladder builds it: rungs, then sections of cells, in one ordered list. */
const report = ({ rungs = [], matrices = [], ...overrides } = {}) => ({
  schema: 1,
  provenance: 'read',
  tool: { name: 'cio-sdk-tools', version: '1.8.0' },
  command: 'verify push',
  area: 'push',
  startedAt: '2026-09-17T00:00:00.000Z',
  finishedAt: '2026-09-17T00:00:05.300Z',
  project: { path: '/p', framework: 'iOS' },
  sections: [
    ...rungs.map((rung) => ({ kind: 'checks', ...rung })),
    ...matrices.map((section) => ({ kind: 'cells', ...section })),
  ],
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
  assert.ok(
    !text.includes('Device ready'),
    'a rung line printed in quiet mode'
  );
  assert.match(text, /The profile has devices, but not this one\./);
  assert.match(text, /Re-identify after the token was issued\./);
  assert.match(text, /Stopped at rung 1 — Profile linked\./);
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

test('the closing facts carry the time, the evidence path and, when watched, that', () => {
  for (const [provenance, watched] of [
    ['read', false],
    ['observed', true],
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
    assert.match(text, /took\s+5\.3s/);
    assert.match(text, /evidence\s+\/tmp\/ev\.log/);
    assert.strictEqual(/watched\s+the install/.test(text), watched);
    assert.match(
      text,
      /✔ Push works on the device: each push arrived and the app handled it\./
    );
    assert.match(
      text,
      /Customer\.io's record of them wasn't checked: --depth end-to-end reads it\./
    );
  }
});

test('the closing line names the tap when opened ran too, and claims nothing was recorded', () => {
  const out = sink();
  reporterOn('human', out).summary(
    report({
      matrices: [
        { metric: 'delivered', cells: [] },
        { metric: 'opened', cells: [] },
      ],
    })
  );
  assert.match(
    out.text(),
    /Push works on the device: each push arrived and each tap reached the SDK\./
  );
  // Only what the device showed: no claim that Customer.io accepted or counted anything.
  assert.doesNotMatch(out.text(), /counted|accepted|reported/);
  assert.match(out.text(), /wasn't checked: --depth end-to-end reads it/);
});

test('an end-to-end run that passed claims the record too, and nothing more', () => {
  const out = sink();
  reporterOn('human', out).summary(
    report({
      matrices: [
        { metric: 'delivered', cells: [] },
        { metric: 'opened', cells: [] },
        { metric: 'recorded', cells: [] },
      ],
    })
  );
  assert.match(
    out.text(),
    /✔ Push works end to end: each push arrived, each tap reached the SDK, and Customer\.io recorded both\./
  );
  assert.doesNotMatch(out.text(), /wasn't checked/);
});

test('a registration run that passed says what it proved, and that nothing was sent', () => {
  const out = sink();
  reporterOn('human', out).summary(report());
  assert.match(out.text(), /✔ The device is registered for push\./);
  assert.match(out.text(), /Nothing was sent, so delivery is not proven: --depth on-device sends real pushes\./);
});

test('a failed run says a push was tried, not that a metric went uncounted', () => {
  const out = sink();
  reporterOn('human', out).summary(report({ verdict: 'fail' }));
  assert.match(out.text(), /✖ A real push was tried and did not pass\./);
  assert.doesNotMatch(out.text(), /counted/);
});

test('a cell says "received" or "opened" without its evidence, and expands when it did not', () => {
  const out = sink();
  const reporter = reporterOn('human', out);
  reporter.matrix('simctl', 'delivered');
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
    cause: 'runtime.nse_did_not_run',
    evidence: ['log: 120 lines'],
    durationMs: 45_000,
  });
  reporter.matrix('simctl', 'opened');
  reporter.cell('killed').done({
    state: 'killed',
    verdict: 'pass',
    evidence: [],
    durationMs: 20_100,
  });

  const text = out.text();
  assert.match(text, /killed\s+received\s+12\.4s/);
  assert.match(text, /killed\s+opened · tapped\s+20\.1s/);
  assert.ok(!text.includes('79 lines'), 'a passing cell printed its evidence');
  assert.match(text, /background\s+runtime\.nse_did_not_run\s+45\.0s/);
  assert.match(text, /log: 120 lines/);
});

test('every cell says Customer.io\u2019s record was not checked', () => {
  const ladder = new (require('../../dist/verify/core/report/ladder').Ladder)();
  ladder.addMatrix({
    metric: 'delivered',
    cells: [{ state: 'killed', verdict: 'pass', evidence: [] }],
  });
  assert.strictEqual(ladder.matrices[0].cells[0].recorded, 'not_checked');
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
  assert.match(text, /- delivered: no push was sent — pass --send/);
  assert.match(text, /- opened: opened needs a real tap/);
});

test('sections skipped for the same reason share one line', () => {
  const out = sink();
  const declined = 'the send was not confirmed, so nothing was sent';
  reporterOn('human', out).summary(
    report({
      verdict: 'skip',
      exitCode: 21,
      matrices: [
        { metric: 'delivered', cells: [], skipped: declined },
        { metric: 'opened', cells: [], skipped: declined },
      ],
    })
  );
  const text = out.text();
  assert.match(text, /- delivered, opened: the send was not confirmed/);
  assert.strictEqual(text.split(declined).length, 2, 'the reason was said twice');
});

test('a prompt gets the terminal to itself', () => {
  const out = sink();
  // Spinners on: the pause/resume pair is what a question relies on, so it has to work
  // when there is actually something painting.
  const reporter = createReporter({ voice: PUSH_VOICE,
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
