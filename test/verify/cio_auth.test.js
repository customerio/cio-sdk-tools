const test = require('node:test');
const assert = require('node:assert');

const cli = require('../../dist/verify/cio/cli');
const { authStatusProblem, unknownProfile, shortError } = cli;
const { resolveWorkspace } = require('../../dist/verify/cio/workspace');
const { createAsker } = require('../../dist/verify/prompt');

// Captured from `cio` 0.0.10, so the shapes are the real ones.
const UNKNOWN_FLAG =
  '{"error":true,"code":"GENERAL_ERROR","message":"unknown flag: --profile"}';
const STALE_TOKEN = JSON.stringify({
  base_url: 'https://us.fly.customer.io',
  read_only: false,
  status: 'authenticated',
  token: 'bogu*******-123',
  token_source: 'config',
  verified: false,
  verify_error:
    'token exchange failed: API error 401: {"error":"invalid_client","error_description":"invalid client credentials"}',
});
const WORKING = JSON.stringify({
  account_id: '1',
  status: 'authenticated',
  verified: true,
});

test('a profile that is not in the config is named, with the ones that are', () => {
  const stored = {
    current_profile: 'default',
    profiles: { default: { account_id: '1' }, staging: { account_id: '2' } },
  };
  assert.match(
    unknownProfile(stored, 'stagin'),
    /no profile "stagin" — the profiles here are default, staging; pass one of them to --profile/
  );
  assert.strictEqual(unknownProfile(stored, 'staging'), undefined);
  assert.strictEqual(unknownProfile(stored, undefined), undefined);
});

test('a legacy single-credential config only has "default"', () => {
  const legacy = { account_id: '1', region: 'us' };
  assert.match(
    unknownProfile(legacy, 'staging'),
    /the profiles here are default;/
  );
  assert.strictEqual(unknownProfile(legacy, 'default'), undefined);
  assert.strictEqual(
    unknownProfile(undefined, 'staging'),
    undefined,
    'with no config at all, the login check speaks instead'
  );
});

test('a cio from before profiles says so, instead of "not authenticated"', () => {
  const problem = authStatusProblem({
    code: 1,
    stdout: UNKNOWN_FLAG,
    stderr: '',
  });
  assert.match(problem, /this cio CLI has no profiles/);
  assert.match(problem, /npm install -g @customerio\/cli/);
  assert.doesNotMatch(problem, /cio auth login/);
});

test('a stored token that no longer works is caught, though cio calls it authenticated', () => {
  const problem = authStatusProblem({
    code: 0,
    stdout: STALE_TOKEN,
    stderr: '',
  });
  assert.strictEqual(
    problem,
    'the cio login no longer works (token exchange failed: API error 401) — run `cio auth logout`, then `cio auth login`'
  );
  assert.ok(
    !problem.includes('invalid_client'),
    'the JSON body leaked through'
  );
});

test('a working login, a missing one, and an older text-only cio', () => {
  assert.strictEqual(
    authStatusProblem({ code: 0, stdout: WORKING, stderr: '' }),
    undefined
  );
  assert.match(
    authStatusProblem({ code: 1, stdout: '', stderr: 'Not authenticated' }),
    /not authenticated — run `cio auth login`/
  );
  assert.strictEqual(
    authStatusProblem({ code: 0, stdout: 'Logged in as someone', stderr: '' }),
    undefined
  );
});

test('a failed workspace listing says why, instead of "no workspaces"', async () => {
  const original = cli.cioApi;
  cli.cioApi = async () => ({
    ok: false,
    error: 'token exchange failed: API error 401: {"error":"invalid_client"}',
  });
  try {
    const resolution = await resolveWorkspace({
      accountId: '1',
      explicit: '122175',
      asker: createAsker({ interactive: false }),
    });
    assert.strictEqual(resolution.how, 'unresolved');
    assert.strictEqual(
      resolution.unresolvedReason,
      "could not list this login's workspaces (token exchange failed: API error 401) — check `cio auth status`"
    );
  } finally {
    cli.cioApi = original;
  }
});

test('an error is cut at the JSON body cio nests in it', () => {
  assert.strictEqual(
    shortError('API error 403: {"errors":[{"detail":"forbidden"}]}'),
    'API error 403'
  );
  assert.strictEqual(shortError('plain message'), 'plain message');
});

test('a bad CIO_TOKEN is named as the culprit, since logging in again would not help', () => {
  const fromEnv = JSON.stringify({
    ...JSON.parse(STALE_TOKEN),
    token_source: 'environment',
  });
  assert.strictEqual(
    authStatusProblem({ code: 0, stdout: fromEnv, stderr: '' }),
    'the CIO_TOKEN in the environment does not work (token exchange failed: API error 401) — fix or unset it'
  );
});
