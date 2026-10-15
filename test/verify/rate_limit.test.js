const test = require('node:test');
const assert = require('node:assert');

const cli = require('../../dist/verify/platform/cio/cli');
const {
  RATE_LIMITED_CAUSE,
  eachState,
  isRateLimited,
  rejectedCell,
  sendVerifyPush,
} = require('../../dist/verify/areas/push/on_device/send');
const { CAUSES } = require('../../dist/verify/areas/push/causes');
const { Ladder } = require('../../dist/verify/core/report/ladder');
const { createReporter } = require('../../dist/verify/core/report/render');
const { PUSH_VOICE } = require('../../dist/verify/areas/push/voice');

const APPLE_429 = 'API error 400: 429 TooManyProviderTokenUpdates';

const sink = () => {
  const written = [];
  return {
    stream: { write: (c) => written.push(String(c)), isTTY: false },
    text: () => written.join(''),
  };
};

const request = {
  environmentId: '122175',
  token: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  sandbox: true,
  title: 't',
  body: 'b',
};

// `cioApi` is read off the module object at call time, so replacing it here is enough.
const withSendResponse = async (response, body) => {
  const original = cli.cioApi;
  cli.cioApi = async () => response;
  try {
    return await body();
  } finally {
    cli.cioApi = original;
  }
};

test("Apple's 429 is recognised whether it arrives as an API error or in the errors list", async () => {
  const asError = await withSendResponse({ ok: false, error: APPLE_429 }, () =>
    sendVerifyPush(request)
  );
  assert.strictEqual(asError.accepted, false);
  assert.strictEqual(asError.rateLimited, true);

  const asList = await withSendResponse(
    { ok: true, data: { errors: ['apns: 429 TooManyProviderTokenUpdates'] } },
    () => sendVerifyPush(request)
  );
  assert.strictEqual(asList.rateLimited, true);

  const other = await withSendResponse(
    { ok: false, error: 'API error 400: BadDeviceToken' },
    () => sendVerifyPush(request)
  );
  assert.strictEqual(other.rateLimited, false);
});

test('a 429 is matched as a number, never inside a token or an id', () => {
  assert.strictEqual(isRateLimited('API error 429: slow down'), true);
  assert.strictEqual(isRateLimited('toomanyprovidertokenupdates'), true);
  assert.strictEqual(isRateLimited('BadDeviceToken for 80f429ab'), false);
  assert.strictEqual(isRateLimited(undefined), false);
});

test('a rate-limited send is inconclusive with its own cause; any other refusal still fails', () => {
  const limited = rejectedCell(
    'killed',
    { accepted: false, error: APPLE_429, rateLimited: true },
    ['state via simctl']
  );
  assert.strictEqual(limited.verdict, 'skip');
  assert.strictEqual(limited.cause, RATE_LIMITED_CAUSE);
  assert.deepStrictEqual(limited.evidence, [
    'state via simctl',
    `send rejected: ${APPLE_429}`,
  ]);

  const refused = rejectedCell(
    'killed',
    { accepted: false, error: 'BadDeviceToken' },
    []
  );
  assert.strictEqual(refused.verdict, 'fail');
  assert.strictEqual(refused.cause, 'send.provider_rejected');
});

test('after the first 429 nothing more is sent, and the rest are skipped rather than failed', async () => {
  const sent = [];
  const out = sink();
  const cells = await eachState(
    ['killed', 'background', 'foreground'],
    async (state) => {
      sent.push(state);
      return rejectedCell(
        state,
        { accepted: false, error: APPLE_429, rateLimited: true },
        []
      );
    },
    // A pause this long would time the test out: none is taken after a refusal.
    {
      pauseMs: 60_000,
      reporter: createReporter({ voice: PUSH_VOICE,
        level: 'human',
        out: out.stream,
        err: out.stream,
        spinners: false,
      }),
    }
  );

  assert.deepStrictEqual(sent, ['killed'], 'it kept sending');
  assert.deepStrictEqual(
    cells.map((cell) => [cell.state, cell.verdict, cell.cause]),
    [
      ['killed', 'skip', RATE_LIMITED_CAUSE],
      ['background', 'skip', undefined],
      ['foreground', 'skip', undefined],
    ]
  );
  assert.match(
    out.text(),
    /background\s+not sent — the provider is refusing sends/
  );
  assert.match(
    out.text(),
    /foreground\s+not sent — the provider is refusing sends/
  );
});

test('a 429 mid-run keeps the cells before it', async () => {
  const cells = await eachState(
    ['killed', 'background', 'foreground'],
    async (state) =>
      state === 'killed'
        ? { state, verdict: 'pass', evidence: [] }
        : rejectedCell(
            state,
            { accepted: false, error: APPLE_429, rateLimited: true },
            []
          ),
    { pauseMs: 0 }
  );
  assert.deepStrictEqual(
    cells.map((cell) => cell.verdict),
    ['pass', 'skip', 'skip']
  );
});

test('a rate-limited run is inconclusive, and the report carries the cause with its fix once', () => {
  const ladder = new Ladder();
  ladder.addMatrix({
    metric: 'delivered',
    cells: [
      rejectedCell(
        'killed',
        { accepted: false, error: APPLE_429, rateLimited: true },
        []
      ),
      {
        state: 'background',
        verdict: 'skip',
        summary: 'not sent — the provider is refusing sends',
        evidence: [],
      },
    ],
  });

  assert.strictEqual(ladder.verdict, 'skip');
  assert.strictEqual(ladder.exitCode, 21);
  assert.strictEqual(ladder.matrixHasCause(RATE_LIMITED_CAUSE), true);
  const causes = ladder.causes();
  assert.deepStrictEqual(
    causes.map((cause) => cause.code),
    [RATE_LIMITED_CAUSE]
  );
  assert.match(causes[0].remedy, /20 minutes/);
  assert.match(causes[0].remedy, /--app-states killed/);
});

test('the catalog holds the rate-limit cause', () => {
  assert.strictEqual(Object.keys(CAUSES).length, 74);
  assert.strictEqual(CAUSES[RATE_LIMITED_CAUSE].stage, 'delivered_matrix');
});

const { whyNoSend } = require('../../dist/verify/areas/push/on_device/send');

test('a send that cannot happen names what is missing, and why the workspace is', () => {
  assert.strictEqual(
    whyNoSend({
      target: { udid: 'x' },
      app: 'io.example',
      workspaceReason:
        'the cio CLI is not installed — install it with `npm install -g @customerio/cli`, then run `cio auth login`',
      token: 'abc',
    }),
    'no push was sent: no workspace (the cio CLI is not installed — install it with `npm install -g @customerio/cli`, then run `cio auth login`)'
  );
  assert.strictEqual(
    whyNoSend({ app: 'io.example', workspaceId: '122175' }),
    'no push was sent: no target; no push token registered on the target'
  );
  assert.strictEqual(
    whyNoSend({ target: 'x', app: 'a', workspaceId: '1', token: 't' }),
    undefined
  );
});

const { markLateArrivals } = require('../../dist/verify/areas/push/on_device/send');
const { postedTitlesFrom } = require('../../dist/verify/areas/push/on_device/android');

test('a push that missed its window but is on the target at the end is late, not lost', async () => {
  // The resumed emulator of 2026-10-13: killed and background "never arrived", and both
  // notifications were on the device minutes later, delivered together with foreground.
  const cells = [
    {
      state: 'killed',
      verdict: 'fail',
      cause: 'runtime.push_never_arrived',
      title: 'cio verify · killed · 23:25:36',
      evidence: [],
    },
    {
      state: 'background',
      verdict: 'skip',
      cause: 'runtime.no_evidence',
      title: 'cio verify · background · 23:27:23',
      evidence: [],
    },
    {
      state: 'foreground',
      verdict: 'pass',
      title: 'cio verify · foreground · 23:29:07',
      evidence: [],
    },
  ];
  const posted = postedTitlesFrom(
    [
      '      android.title=String (cio verify · killed · 23:25:36)',
      '      android.text=String (Sent by cio-sdk-tools verify push.)',
      '      android.title=String (cio verify · background · 23:27:23)',
      '      android.title=String (cio verify · foreground · 23:29:07)',
    ].join('\n')
  );
  assert.strictEqual(posted.length, 3);

  const asked = [];
  const judged = await markLateArrivals(cells, async (title) => {
    asked.push(title);
    return posted.includes(title);
  });
  assert.deepStrictEqual(
    judged.map((cell) => [cell.state, cell.verdict, cell.cause]),
    [
      ['killed', 'warn', 'runtime.push_arrived_late'],
      ['background', 'warn', 'runtime.push_arrived_late'],
      ['foreground', 'pass', undefined],
    ]
  );
  assert.strictEqual(
    asked.length,
    2,
    'a passing cell was checked for lateness'
  );
  assert.match(judged[0].evidence.at(-1), /was: runtime\.push_never_arrived/);

  const ladder = new Ladder();
  ladder.addMatrix({ metric: 'delivered', cells: judged });
  assert.strictEqual(ladder.verdict, 'warn', 'slow delivery still works');
  assert.match(ladder.causes()[0].remedy, /resumed from a snapshot/);
});

test('a push still missing at the end stays never-arrived', async () => {
  const cells = [
    {
      state: 'killed',
      verdict: 'fail',
      cause: 'runtime.push_never_arrived',
      title: 't',
      evidence: [],
    },
    {
      state: 'background',
      verdict: 'fail',
      cause: 'runtime.nse_did_not_run',
      title: 'u',
      evidence: [],
    },
  ];
  const judged = await markLateArrivals(cells, async () => false);
  assert.deepStrictEqual(judged, cells);
});
