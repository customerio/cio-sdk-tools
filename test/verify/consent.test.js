const test = require('node:test');

// The prompts' timers are unref'd so a real run can exit, and a terminal's stdin keeps a real
// run alive while it waits. These tests' streams hold nothing open, and Node 20's runner
// cancels a file whose event loop empties, so the file holds it open until its tests finish.
const keepAlive = setInterval(() => {}, 1_000);
test.after(() => clearInterval(keepAlive));
const assert = require('node:assert');
const { PassThrough } = require('node:stream');

const { createAsker } = require('../../dist/verify/core/prompt');
const {
  consentToSend,
  openedStatesToSend,
} = require('../../dist/verify/areas/push/consent');
const { refusalUnattended } = require('../../dist/verify/core/consent');
const { Ladder } = require('../../dist/verify/core/report/ladder');
const { createReporter } = require('../../dist/verify/core/report/render');
const { PUSH_VOICE } = require('../../dist/verify/areas/push/voice');

const TOKEN =
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const sink = () => {
  const written = [];
  return {
    written,
    stream: { write: (c) => written.push(String(c)), isTTY: false },
    text: () => written.join(''),
  };
};

const asker = (lines, out, timeoutMs = 1_000) => {
  const input = new PassThrough();
  for (const line of lines) input.write(`${line}\n`);
  return createAsker({
    interactive: true,
    input,
    output: out.stream,
    timeoutMs,
  });
};

const reporterOn = (out, level = 'human') =>
  createReporter({ voice: PUSH_VOICE, level, out: out.stream, err: out.stream, spinners: false });

const plan = (overrides = {}) => ({
  target: 'cio-verify-poc (simulator iOS 18.4, booted) · 6F1C2A9E',
  app: 'io.customer.ios-sample.apn-spm.APN-UIKit',
  workspace: 'Mobile: Native iOS & Android (122175)',
  login: 'default',
  token: TOKEN,
  delivered: ['killed', 'background', 'foreground'],
  opened: [],
  retries: true,
  ...overrides,
});

/** An asker that records what it was asked and answers from a script. */
const scripted = (answer) => {
  const asked = [];
  return {
    asked,
    asker: {
      interactive: true,
      agree: async (question, context) => {
        asked.push({ question, context });
        return answer;
      },
      askTap: async () => 'no_answer',
      select: async () => {
        throw new Error('not expected');
      },
    },
  };
};

// --- the yes/no question ---------------------------------------------------

test('only an explicit yes agrees; Enter takes the default, which is no', async () => {
  const out = sink();
  assert.strictEqual(await asker(['y'], out).agree('Send?'), true);
  assert.strictEqual(await asker(['YES'], out).agree('Send?'), true);
  assert.strictEqual(await asker([''], out).agree('Send?'), false);
  assert.strictEqual(await asker(['n'], out).agree('Send?'), false);
  assert.match(out.text(), /Send\? .*\(y\/N\)/);
});

test('an answer that is neither is re-asked rather than guessed at', async () => {
  const out = sink();
  assert.strictEqual(await asker(['sure', 'y'], out).agree('Send?'), true);
  assert.match(out.text(), /answer y or n/);
});

test('silence and a closed stdin both read as no', async () => {
  const quiet = createAsker({
    interactive: true,
    input: new PassThrough(),
    output: sink().stream,
    timeoutMs: 30,
  });
  assert.strictEqual(await quiet.agree('Send?'), false);

  const input = new PassThrough();
  const closing = createAsker({
    interactive: true,
    input,
    output: sink().stream,
    timeoutMs: 30_000,
  });
  const pending = closing.agree('Send?');
  input.end();
  assert.strictEqual(await pending, false);
});

test('a run that cannot ask never prompts and never agrees', async () => {
  const out = sink();
  const machine = createAsker({ interactive: false, output: out.stream });
  assert.strictEqual(await machine.agree('Send?', 'context'), false);
  assert.strictEqual(out.written.length, 0, 'it wrote to the terminal anyway');
});

// --- what the question shows -----------------------------------------------

test('the question names the device, app, workspace, login, token prefix and count', async () => {
  const { asker: fake, asked } = scripted(true);
  const consent = await consentToSend({
    plan: plan(),
    named: false,
    opened: false,
    asker: fake,
    reporter: reporterOn(sink()),
    ladder: new Ladder(),
  });

  assert.deepStrictEqual(consent, {
    granted: true,
    by: 'prompt',
    writes: ['3 real pushes to cio-verify-poc (simulator iOS 18.4, booted) · 6F1C2A9E through Mobile: Native iOS & Android (122175)'],
  });
  assert.strictEqual(asked.length, 1, 'one question per run');
  const { question, context } = asked[0];
  assert.strictEqual(question, 'Send 3 real pushes?');
  for (const expected of [
    /Ready to send real pushes/,
    /device\s+cio-verify-poc \(simulator iOS 18\.4, booted\) · 6F1C2A9E/,
    /app\s+io\.customer\.ios-sample\.apn-spm\.APN-UIKit/,
    /workspace\s+Mobile: Native iOS & Android \(122175\)/,
    /cio login\s+default/,
    /token\s+a1b2c3d4e5f6…/,
    /delivered\s+3 · killed, background, foreground/,
    /retries\s+up to 1 more per delivered state/,
  ]) {
    assert.match(context, expected);
  }
  assert.ok(!context.includes(TOKEN), 'the whole token was printed');
  assert.doesNotMatch(context, /opened/);
});

test('--check-opens adds taps on the same pushes, not more pushes, and one push reads in the singular', async () => {
  const opened = scripted(true);
  await consentToSend({
    plan: plan({ opened: ['killed', 'background'] }),
    named: false,
    opened: true,
    asker: opened.asker,
    reporter: reporterOn(sink()),
    ladder: new Ladder(),
  });
  // One push per state: the two taps are on two of the three pushes.
  assert.strictEqual(opened.asked[0].question, 'Send 3 real pushes?');
  assert.match(
    opened.asked[0].context,
    /taps\s+2 · killed, background · on the same pushes, one tap each/
  );

  const single = scripted(true);
  await consentToSend({
    plan: plan({ delivered: ['killed'], retries: false }),
    named: false,
    opened: false,
    asker: single.asker,
    reporter: reporterOn(sink()),
    ladder: new Ladder(),
  });
  assert.strictEqual(single.asked[0].question, 'Send 1 real push?');
  assert.doesNotMatch(single.asked[0].context, /retries/);
});

// --- naming where the pushes go ---------------------------------------------

test('naming the depth, workspace and device skips the question but still prints where the pushes go', async () => {
  const { asker: fake, asked } = scripted(false);
  const out = sink();
  const consent = await consentToSend({
    plan: plan(),
    named: true,
    opened: false,
    asker: fake,
    reporter: reporterOn(out),
    ladder: new Ladder(),
  });

  assert.deepStrictEqual(consent, {
    granted: true,
    by: 'named',
    writes: ['3 real pushes to cio-verify-poc (simulator iOS 18.4, booted) · 6F1C2A9E through Mobile: Native iOS & Android (122175)'],
  });
  assert.strictEqual(asked.length, 0, 'it asked anyway');
  assert.match(out.text(), /Sending real pushes/);
  assert.match(
    out.text(),
    /workspace\s+Mobile: Native iOS & Android \(122175\)/
  );
  assert.match(out.text(), /go-ahead\s+named on the command line/);
  assert.ok(!out.text().includes(TOKEN), 'the whole token was printed');
});

test('a named send under --json prints nothing on stdout', async () => {
  const out = sink();
  await consentToSend({
    plan: plan(),
    named: true,
    opened: false,
    asker: scripted(false).asker,
    reporter: reporterOn(out, 'json'),
    ladder: new Ladder(),
  });
  assert.strictEqual(out.text(), '');
});

// --- a run that cannot ask -------------------------------------------------

test('a run that cannot ask sends only where the command line named', () => {
  const base = {
    sends: true,
    interactive: false,
    what: 'real pushes',
    destinations: [
      { flag: '--depth <level>', named: true },
      { flag: '--workspace <id>', named: false },
      { flag: '--device <id|name>', named: false },
    ],
  };
  const refused = refusalUnattended(base);
  assert.match(
    refused.message,
    /real pushes and nobody can be asked, .* pass --workspace <id> and --device <id\|name>$/
  );
  assert.deepStrictEqual(refused.flags, ['--workspace <id>', '--device <id|name>']);
  const named = base.destinations.map((d) => ({ ...d, named: true }));
  assert.strictEqual(refusalUnattended({ ...base, destinations: named }), undefined);
  assert.strictEqual(
    refusalUnattended({ ...base, sends: false }),
    undefined,
    'a level or a dry run that sends nothing needs no go-ahead'
  );
  assert.strictEqual(
    refusalUnattended({ ...base, interactive: true }),
    undefined,
    'a run that can ask asks later instead'
  );
});

// --- declining -------------------------------------------------------------

test('declining sends nothing and skips every section that would have sent', async () => {
  const ladder = new Ladder();
  const out = sink();
  const consent = await consentToSend({
    plan: plan({ opened: ['killed', 'background'] }),
    named: false,
    opened: true,
    asker: asker([''], out),
    reporter: reporterOn(sink()),
    ladder,
  });

  assert.deepStrictEqual(consent, {
    granted: false,
    by: 'prompt',
    writes: ['3 real pushes to cio-verify-poc (simulator iOS 18.4, booted) · 6F1C2A9E through Mobile: Native iOS & Android (122175)'],
  });
  const built = ladder.toReport({
    schema: 1,
    provenance: 'read',
    consent,
    tool: { name: 'cio-sdk-tools', version: '0.0.0' },
    command: 'verify push',
    area: 'push',
    startedAt: '2026-09-17T00:00:00.000Z',
    finishedAt: '2026-09-17T00:00:01.000Z',
    project: { path: '/p', platform: 'ios', framework: 'native' },
  });
  assert.deepStrictEqual(
    built.sections
      .filter((section) => section.kind === 'cells')
      .map((section) => [section.metric, section.skipped]),
    [
      ['delivered', 'the send was not confirmed, so nothing was sent'],
      ['opened', 'the send was not confirmed, so nothing was sent'],
    ]
  );
  assert.strictEqual(built.verdict, 'skip');
  assert.strictEqual(built.exitCode, 21);
  assert.deepStrictEqual(built.consent, consent);

  const summary = sink();
  reporterOn(summary).summary(built);
  assert.match(
    summary.text(),
    /the send was not confirmed, so nothing was sent/
  );
  assert.match(summary.text(), /Nothing was proven/);
});

test('taps are on the pushes sent while the app was killed or in the background', () => {
  const asked = { opened: true, interactive: true };
  assert.deepStrictEqual(openedStatesToSend(asked), ['killed', 'background']);
  assert.deepStrictEqual(
    openedStatesToSend({ ...asked, interactive: false }),
    [],
    'nobody can tap, so the opened section skips itself'
  );
  assert.deepStrictEqual(openedStatesToSend({ ...asked, opened: false }), []);
  // A tap is only ever on a push the run sends, and never on the foreground one, whatever
  // --app-states asked for.
  assert.deepStrictEqual(
    openedStatesToSend({ ...asked, delivered: ['killed', 'foreground'] }),
    ['killed']
  );
  assert.deepStrictEqual(
    openedStatesToSend({ ...asked, delivered: ['foreground'] }),
    []
  );
});
