const test = require('node:test');
const assert = require('node:assert');

const {
  workspaceReady,
} = require('../../dist/verify/areas/push/registration/workspace_ready');
const {
  profileLinked,
} = require('../../dist/verify/areas/push/registration/profile_linked');
const {
  googleServicesCheck,
} = require('../../dist/verify/areas/push/registration/android_wiring');
const { resolveCause } = require('../../dist/verify/core/report/causes');
const { Ladder } = require('../../dist/verify/core/report/ladder');
const { EXIT } = require('../../dist/verify/core/report/types');
require('../../dist/verify/areas/push/causes');

const authed = { available: true, authenticated: true, accountId: '1' };
const causes = (rung) => rung.checks.filter((c) => c.cause).map((c) => c.cause);

test('a credential with an environment but a build with none names the build, not the credential', () => {
  const rung = workspaceReady({
    cio: authed,
    resolution: { how: 'explicit', candidates: [], workspace: { id: '1' } },
    credential: { config: 'sandbox', username: 'AuthKey.p8' },
  });
  assert.deepStrictEqual(causes(rung), ['workspace.build_environment_unknown']);
  assert.match(
    resolveCause('workspace.build_environment_unknown').summary,
    /build declares no aps-environment/
  );
  assert.doesNotMatch(
    resolveCause('workspace.build_environment_unknown').summary,
    /could not be read/
  );
});

test('google-services.json with no resolvable applicationId is its own finding', () => {
  const check = googleServicesCheck({
    googleServices: { packageNames: ['com.example.app'] },
    appModuleName: 'app',
  });
  assert.strictEqual(check.cause, 'wiring.google_services_unverified');
  assert.match(
    resolveCause(check.cause).summary,
    /applicationId could not be resolved/
  );
  assert.doesNotMatch(resolveCause(check.cause).summary, /launch/);
});

const profileInput = (find, extra = {}) => ({
  cio: authed,
  environmentId: '1',
  userId: 'me@example.com',
  token: 'token-1',
  candidates: [],
  settle: { maxMs: 100, pollMs: 10 },
  find,
  ...extra,
});

test('a lookup that fails is unproven, ends inconclusive with its cause, and is not waited out', async () => {
  let reads = 0;
  const opened = [];
  const rung = await profileLinked(
    profileInput(
      async () => {
        reads += 1;
        throw new Error('customer lookup failed: API error 401');
      },
      { foreground: async () => opened.push('opened') }
    )
  );
  assert.deepStrictEqual(causes(rung), ['profile.lookup_failed']);
  assert.strictEqual(Ladder.verdictOf(rung), 'skip');
  assert.match(rung.checks[0].evidence.join(' '), /API error 401/);
  assert.strictEqual(reads, 1);
  assert.deepStrictEqual(opened, []);

  // Through the ladder: exit 21, not 0, and the cause reaches the report.
  const ladder = new Ladder();
  ladder.adopt(rung);
  assert.strictEqual(ladder.exitCode, EXIT.inconclusive);
  assert.deepStrictEqual(
    ladder.causes().map((cause) => cause.code),
    ['profile.lookup_failed']
  );
});

test('a lookup that starts failing while waiting is still not "profile missing"', async () => {
  let reads = 0;
  const rung = await profileLinked(
    profileInput(async () => {
      reads += 1;
      if (reads === 1) return null;
      throw new Error('customer lookup failed: network');
    })
  );
  assert.deepStrictEqual(causes(rung), ['profile.lookup_failed']);
  assert.strictEqual(Ladder.verdictOf(rung), 'skip');
});

test('a failed final poll does not erase what earlier reads established', async () => {
  let reads = 0;
  const rung = await profileLinked(
    profileInput(async () => {
      reads += 1;
      if (reads <= 2) {
        return {
          cioId: 'c1',
          identifiers: {},
          devices: [{ id: 'another-token', platform: 'android' }],
        };
      }
      throw new Error('customer lookup failed: network');
    })
  );
  assert.ok(
    !causes(rung).includes('profile.lookup_failed'),
    causes(rung).join()
  );
  assert.strictEqual(Ladder.verdictOf(rung), 'fail');
});

test('a credential that could not be read is unproven, never a warning that exits 0', () => {
  const rung = workspaceReady({
    cio: authed,
    resolution: { how: 'explicit', candidates: [], workspace: { id: '1' } },
    credentialError: 'API error 500',
  });
  assert.deepStrictEqual(causes(rung), ['workspace.lookup_failed']);
  assert.strictEqual(Ladder.verdictOf(rung), 'skip');
  const ladder = new Ladder();
  ladder.adopt(rung);
  assert.strictEqual(ladder.exitCode, EXIT.inconclusive);
});

test('workspace keys that could not be read are unproven, never a skip that exits 0', () => {
  const rung = workspaceReady({
    cio: authed,
    resolution: {
      how: 'explicit',
      candidates: [],
      workspace: { id: '1', name: 'W' },
    },
    credential: { kind: 'apns' },
    keys: {
      sdkKey: 'abc',
      sdkKeyChecked: true,
      extensionKey: { value: 'abc', site: 'NotificationService.swift:10' },
      workspaceKeys: [],
      error: 'API error 403',
    },
  });
  const checks = rung.checks.filter((c) => c.id.endsWith('_key'));
  assert.deepStrictEqual(
    checks.map((c) => [c.verdict, c.cause]),
    [
      ['skip', 'workspace.lookup_failed'],
      ['skip', 'workspace.lookup_failed'],
    ]
  );
  assert.strictEqual(Ladder.verdictOf(rung), 'skip');
  const ladder = new Ladder();
  ladder.adopt(rung);
  assert.strictEqual(ladder.exitCode, EXIT.inconclusive);
});
