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

test('a lookup that fails is a warning, not a missing profile, and is not waited out', async () => {
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
  assert.strictEqual(Ladder.verdictOf(rung), 'warn');
  assert.match(rung.checks[0].evidence.join(' '), /API error 401/);
  assert.strictEqual(reads, 1);
  assert.deepStrictEqual(opened, []);
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
});
