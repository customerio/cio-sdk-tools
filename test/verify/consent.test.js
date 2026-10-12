const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');

const { createAsker } = require('../../dist/verify/prompt');
const {
  consentToSend,
  refusalWithoutConsent,
} = require('../../dist/verify/consent');
const { Ladder } = require('../../dist/verify/ladder');
const { createReporter } = require('../../dist/verify/report');

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
  createReporter({ level, out: out.stream, err: out.stream, spinners: false });

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
      confirm: async () => false,
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

test('the question names the target, app, workspace, login, token prefix and count', async () => {
  const { asker: fake, asked } = scripted(true);
  const consent = await consentToSend({
    plan: plan(),
    yes: false,
    opened: false,
    asker: fake,
    reporter: reporterOn(sink()),
    ladder: new Ladder(),
  });

  assert.deepStrictEqual(consent, { granted: true, by: 'prompt', pushes: 3 });
  assert.strictEqual(asked.length, 1, 'one question per run');
  const { question, context } = asked[0];
  assert.strictEqual(question, 'Send 3 real pushes?');
  for (const expected of [
    /Ready to send real pushes/,
    /target\s+cio-verify-poc \(simulator iOS 18\.4, booted\) · 6F1C2A9E/,
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

test('--opened adds its pushes to the count, and one push reads in the singular', async () => {
  const opened = scripted(true);
  await consentToSend({
    plan: plan({ opened: ['killed', 'background'] }),
    yes: false,
    opened: true,
    asker: opened.asker,
    reporter: reporterOn(sink()),
    ladder: new Ladder(),
  });
  assert.strictEqual(opened.asked[0].question, 'Send 5 real pushes?');
  assert.match(
    opened.asked[0].context,
    /opened\s+2 · killed, background · one tap each/
  );

  const single = scripted(true);
  await consentToSend({
    plan: plan({ delivered: ['killed'], retries: false }),
    yes: false,
    opened: false,
    asker: single.asker,
    reporter: reporterOn(sink()),
    ladder: new Ladder(),
  });
  assert.strictEqual(single.asked[0].question, 'Send 1 real push?');
  assert.doesNotMatch(single.asked[0].context, /retries/);
});

// --- --yes -----------------------------------------------------------------

test('--yes skips the question but still prints where the pushes go', async () => {
  const { asker: fake, asked } = scripted(false);
  const out = sink();
  const consent = await consentToSend({
    plan: plan(),
    yes: true,
    opened: false,
    asker: fake,
    reporter: reporterOn(out),
    ladder: new Ladder(),
  });

  assert.deepStrictEqual(consent, { granted: true, by: '--yes', pushes: 3 });
  assert.strictEqual(asked.length, 0, 'it asked anyway');
  assert.match(out.text(), /Sending real pushes/);
  assert.match(
    out.text(),
    /workspace\s+Mobile: Native iOS & Android \(122175\)/
  );
  assert.match(out.text(), /consent\s+--yes/);
  assert.ok(!out.text().includes(TOKEN), 'the whole token was printed');
});

test('--yes under --json prints nothing on stdout', async () => {
  const out = sink();
  await consentToSend({
    plan: plan(),
    yes: true,
    opened: false,
    asker: scripted(false).asker,
    reporter: reporterOn(out, 'json'),
    ladder: new Ladder(),
  });
  assert.strictEqual(out.text(), '');
});

// --- a run that cannot ask -------------------------------------------------

test('a run that cannot ask is refused a real send unless --yes is passed', () => {
  const base = {
    send: true,
    opened: false,
    dryRun: false,
    yes: false,
    interactive: false,
  };
  assert.match(refusalWithoutConsent(base), /^--send .* pass --yes$/);
  assert.match(
    refusalWithoutConsent({ ...base, opened: true }),
    /^--opened .* pass --yes$/
  );
  assert.strictEqual(refusalWithoutConsent({ ...base, yes: true }), undefined);
  assert.strictEqual(
    refusalWithoutConsent({ ...base, dryRun: true }),
    undefined,
    'a dry run sends nothing, so it needs no consent'
  );
  assert.strictEqual(
    refusalWithoutConsent({ ...base, send: false }),
    undefined
  );
  assert.strictEqual(
    refusalWithoutConsent({ ...base, interactive: true }),
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
    yes: false,
    opened: true,
    asker: asker([''], out),
    reporter: reporterOn(sink()),
    ladder,
  });

  assert.deepStrictEqual(consent, { granted: false, by: 'prompt', pushes: 5 });
  const built = ladder.toReport({
    schema: 1,
    provenance: 'read',
    consent,
    tool: { name: 'cio-sdk-tools', version: '0.0.0' },
    command: 'verify push',
    startedAt: '2026-09-17T00:00:00.000Z',
    finishedAt: '2026-09-17T00:00:01.000Z',
    project: { path: '/p', framework: 'iOS' },
  });
  assert.deepStrictEqual(
    built.matrices.map((section) => [section.metric, section.skipped]),
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
  assert.match(summary.text(), /nothing was proven/);
});
