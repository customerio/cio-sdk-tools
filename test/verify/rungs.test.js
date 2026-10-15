const test = require('node:test');
const assert = require('node:assert');

const { workspaceReady } = require('../../dist/verify/areas/push/registration/workspace_ready');
const { deviceReady } = require('../../dist/verify/areas/push/registration/device_ready');
const {
  profileLinked,
  deviceLinkChecks,
} = require('../../dist/verify/areas/push/registration/profile_linked');
const { Ladder } = require('../../dist/verify/core/report/ladder');

const authed = { available: true, authenticated: true, accountId: '1' };
const causes = (rung) => rung.checks.filter((c) => c.cause).map((c) => c.cause);
const check = (rung, id) => rung.checks.find((c) => c.id === id);

test('without the cio CLI the workspace rung skips and says how to get it', () => {
  const rung = workspaceReady({
    cio: {
      available: false,
      authenticated: false,
      reason: 'the cio CLI is not installed — install it with `npm install -g @customerio/cli`',
    },
  });
  assert.strictEqual(Ladder.verdictOf(rung), 'skip');
  assert.match(rung.skipped, /@customerio\/cli/);
});

test('an unresolved workspace skips with the reason, rather than guessing one', () => {
  // Ambiguity is settled by the picker before the climb starts, so what reaches this rung
  // is a workspace or an explanation — never a guess.
  const rung = workspaceReady({
    cio: authed,
    resolution: {
      how: 'unresolved',
      candidates: [{ id: '1', name: 'One' }],
      unresolvedReason: 'workspace 999 is not one this login can read',
    },
  });
  assert.strictEqual(Ladder.verdictOf(rung), 'skip');
  assert.match(rung.skipped, /999 is not one this login can read/);
});

test('a missing APNs credential fails the workspace rung', () => {
  const rung = workspaceReady({
    cio: authed,
    resolution: { how: 'explicit', candidates: [], workspace: { id: '122175' } },
  });
  assert.strictEqual(Ladder.verdictOf(rung), 'fail');
  assert.deepStrictEqual(causes(rung), ['workspace.apns_credential_missing']);
});

test('a sandbox credential under a production build is the silent mismatch', () => {
  const rung = workspaceReady(
    {
      cio: authed,
      resolution: { how: 'explicit', candidates: [], workspace: { id: '122175' } },
      credential: { config: 'sandbox', username: 'AuthKey.p8' },
    },
    'production'
  );
  assert.strictEqual(Ladder.verdictOf(rung), 'fail');
  assert.deepStrictEqual(causes(rung), ['workspace.env_mismatch']);
  assert.match(check(rung, 'credential_environment').evidence.join(' '), /needs a production credential/);
});

test('development against sandbox passes', () => {
  const rung = workspaceReady(
    {
      cio: authed,
      resolution: {
        how: 'chosen',
        candidates: [{ id: '122175' }, { id: '94996' }],
        workspace: { id: '122175' },
      },
      credential: { config: 'sandbox' },
    },
    'development'
  );
  assert.strictEqual(Ladder.verdictOf(rung), 'pass');
  assert.match(
    check(rung, 'workspace_selected').evidence.join(' '),
    /chosen from 2 workspaces/
  );
});

test('a credential with no recorded environment warns instead of quietly skipping', () => {
  const rung = workspaceReady(
    {
      cio: authed,
      resolution: { how: 'explicit', candidates: [], workspace: { id: '94996' } },
      credential: { config: '', username: 'AuthKey.p8' },
    },
    'development'
  );
  assert.strictEqual(Ladder.verdictOf(rung), 'warn');
  assert.deepStrictEqual(causes(rung), ['workspace.credential_config_unknown']);
});

test('a named target that is not there fails; nothing named and nothing there skips', () => {
  const missing = deviceReady(
    { usable: [], ambiguous: [], selector: 'nope', installed: false },
    'io.example.app'
  );
  assert.strictEqual(Ladder.verdictOf(missing), 'fail');
  assert.deepStrictEqual(causes(missing), ['device.not_available']);

  const none = deviceReady({ usable: [], ambiguous: [], installed: false }, 'io.example.app');
  assert.strictEqual(Ladder.verdictOf(none), 'skip');
  assert.match(none.skipped, /no booted simulator/);
});

test('several usable devices skip rather than picking one', () => {
  const rung = deviceReady(
    {
      usable: [
        { kind: 'simulator', name: 'A', udid: '1', state: 'booted' },
        { kind: 'device', name: 'B', udid: '2', state: 'connected' },
      ],
      ambiguous: [],
      installed: false,
    },
    'io.example.app'
  );
  assert.strictEqual(Ladder.verdictOf(rung), 'skip');
  assert.match(rung.skipped, /--device/);
});

test('an app that was never installed fails before the token is looked for', () => {
  const rung = deviceReady(
    {
      target: { kind: 'simulator', name: 'A', udid: '1', state: 'booted' },
      usable: [],
      ambiguous: [],
      installed: false,
    },
    'io.example.app'
  );
  assert.deepStrictEqual(causes(rung), ['device.app_not_installed']);
  assert.strictEqual(check(rung, 'token_registered'), undefined);
});

test('no stored token fails, and so does an anonymous device: push goes only to identified profiles', () => {
  const target = { kind: 'simulator', name: 'A', udid: '1', state: 'booted' };
  const noToken = deviceReady(
    {
      target,
      usable: [],
      ambiguous: [],
      installed: true,
      preferences: '/tmp/prefs',
      sdk: { sources: ['io.customer.sdk.io.example.app.shared.plist'] },
    },
    'io.example.app'
  );
  assert.strictEqual(Ladder.verdictOf(noToken), 'fail');
  assert.deepStrictEqual(causes(noToken).sort(), [
    'device.identity_anonymous',
    'device.token_unregistered',
  ]);

  const anonymous = deviceReady(
    {
      target,
      usable: [],
      ambiguous: [],
      installed: true,
      preferences: '/tmp/prefs',
      sdk: { pushDeviceToken: 'a'.repeat(64), anonymousId: 'anon-1', sources: [] },
    },
    'io.example.app'
  );
  assert.strictEqual(Ladder.verdictOf(anonymous), 'fail', 'an anonymous device must stop the climb before any send');
  assert.deepStrictEqual(causes(anonymous), ['device.identity_anonymous']);
  const identity = anonymous.checks.find((check) => check.id === 'identity_read');
  assert.deepStrictEqual(identity.evidence, ['anonymous id only: anon-1']);
});

test('the token is never printed in full', () => {
  const token = 'b11ee5e4da66e72ef250' + 'c'.repeat(44);
  const rung = deviceReady(
    {
      target: { kind: 'simulator', name: 'A', udid: '1', state: 'booted' },
      usable: [],
      ambiguous: [],
      installed: true,
      preferences: '/tmp/prefs',
      sdk: { pushDeviceToken: token, userId: 'someone@example.com', sources: [] },
    },
    'io.example.app'
  );
  const printed = JSON.stringify(rung);
  assert.ok(!printed.includes(token), 'the full token leaked into the report');
  assert.match(printed, /b11ee5e4da66…/);
});

test('a profile with no devices at all is a different failure from a profile with the wrong one', () => {
  const input = { token: 't'.repeat(64), bundleId: 'io.example.app' };

  const empty = deviceLinkChecks({ cioId: 'c1', identifiers: {}, devices: [] }, input);
  assert.deepStrictEqual(
    empty.map((c) => c.cause),
    ['profile.no_device_linked']
  );

  const stale = deviceLinkChecks(
    {
      cioId: 'c1',
      identifiers: {},
      devices: [{ id: 'x'.repeat(64), platform: 'ios', sdkVersion: '4.8.0' }],
    },
    input
  );
  assert.deepStrictEqual(
    stale.map((c) => c.cause),
    ['profile.token_not_linked']
  );
});

test('a linked device passes, and its smells are warnings alongside the pass', () => {
  const token = 't'.repeat(64);
  const checks = deviceLinkChecks(
    {
      cioId: 'c1',
      identifiers: {},
      devices: [
        {
          id: token,
          platform: 'ios',
          sdkVersion: '4.8.0',
          appIdentifier: 'io.example.other',
          pushEnabled: 'false',
        },
      ],
    },
    { token, bundleId: 'io.example.app' }
  );
  assert.strictEqual(checks[0].verdict, 'pass');
  assert.deepStrictEqual(checks.slice(1).map((c) => c.cause), [
    'profile.app_identifier_mismatch',
    'profile.push_disabled',
  ]);
});

test('the profile rung skips, never fails, when its inputs are missing', async () => {
  const cases = [
    [{ cio: { available: true, authenticated: false, reason: 'not authenticated' } }, /not authenticated/],
    [{ cio: authed }, /no workspace/],
    [{ cio: authed, environmentId: '1' }, /no identified user/],
    // An anonymous id is never looked up: push goes only to identified profiles.
    [{ cio: authed, environmentId: '1', anonymousId: 'anon-1', token: 't' }, /no identified user/],
    [{ cio: authed, environmentId: '1', userId: 'a@b.c' }, /no push token/],
  ];
  for (const [input, expected] of cases) {
    const rung = await profileLinked(input);
    assert.strictEqual(Ladder.verdictOf(rung), 'skip');
    assert.match(rung.skipped, expected);
  }
});

test('the push transport comes from the linked SDK product, not an assumption', () => {
  const { providerFrom } = require('../../dist/verify/areas/push/registration/project_wiring');
  // An iOS app delivering push over Firebase needs an FCM credential; assuming APNs
  // convicted a correctly wired app with workspace.apns_credential_missing.
  assert.strictEqual(providerFrom(['CioDataPipelines', 'CioMessagingPushFCM']), 'fcm');
  assert.strictEqual(providerFrom(['CioMessagingPushAPN']), 'apns');
  assert.strictEqual(providerFrom(['CioMessagingPushAPN', 'CioMessagingPushFCM']), 'apns');
  assert.strictEqual(providerFrom([]), 'apns');
});
