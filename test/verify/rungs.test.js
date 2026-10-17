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
  // push_enabled is Customer.io's lagging copy: recorded, never judged.
  assert.match(checks[0].evidence.join(' '), /push_enabled false in Customer\.io/);
  assert.deepStrictEqual(checks.slice(1).map((c) => c.cause), [
    'profile.app_identifier_mismatch',
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

test('a workspace with no APNs credential is named as missing, not as a lookup that failed', async () => {
  const { pushCredential } = require('../../dist/verify/areas/push/credentials');
  // The API's answer for workspace 100585, which has no APNs key.
  const missing = await pushCredential('100585', 'apns', async () => ({ ok: false, error: 'API error 404: not found' }));
  assert.deepStrictEqual(missing, { ok: true });
  const rung = workspaceReady(
    {
      cio: authed,
      provider: 'apns',
      resolution: { how: 'flag', workspace: { id: '100585', name: 'Mobile: xReact Native FCM' }, candidates: [] },
      credential: missing.credential,
    },
    'development'
  );
  assert.deepStrictEqual(causes(rung), ['workspace.apns_credential_missing']);

  // Any other failure still says the credential could not be read.
  const denied = await pushCredential('100585', 'apns', async () => ({ ok: false, error: 'API error 403: forbidden' }));
  assert.strictEqual(denied.ok, false);
});

test('--device by name takes the running simulator, and refuses two running under one name', () => {
  const { selectTarget } = require('../../dist/verify/platform/ios/device');
  const sim = (udid, state) => ({ kind: 'simulator', name: 'iPhone 16', udid, state });
  const off = [sim('1688FDB0', 'shutdown'), sim('008B1517', 'shutdown')];

  const picked = selectTarget([...off, sim('2B0C8B8F', 'booted')], 'iPhone 16');
  assert.strictEqual(picked.target.udid, '2B0C8B8F', 'a shut-down simulator of the same name was taken first');

  const two = selectTarget([...off, sim('2B0C8B8F', 'booted'), sim('AAAA0000', 'booted')], 'iPhone 16');
  assert.strictEqual(two.target, undefined);
  assert.strictEqual(two.ambiguous.length, 2);

  // Only shut-down matches: nothing usable, and the device rung says why.
  const none = selectTarget(off, 'iPhone 16');
  assert.strictEqual(none.target, undefined);
  const rung = deviceReady(
    { usable: [], ambiguous: none.ambiguous, matched: none.matched, selector: 'iPhone 16', installed: false },
    'io.example.app'
  );
  assert.deepStrictEqual(causes(rung), ['device.not_available']);
  assert.ok(rung.checks[0].evidence.includes('named, but shutdown: iPhone 16 (1688FDB0)'));
});

test('an iOS app on Firebase needs a workspace that sends iOS through Firebase', () => {
  const facts = (platform, config) => ({
    cio: authed,
    platform,
    provider: 'fcm',
    resolution: { how: 'explicit', candidates: [], workspace: { id: '122348' } },
    credential: { config },
  });
  const ios = workspaceReady(facts('ios', ''));
  assert.deepStrictEqual(causes(ios), ['workspace.fcm_ios_not_enabled']);
  assert.match(check(ios, 'push_credential').evidence.join(' '), /config is empty, not "allow_ios"/);

  assert.strictEqual(Ladder.verdictOf(workspaceReady(facts('ios', 'allow_ios'))), 'pass');
  // Android has no such setting: its FCM credential sends to Android either way.
  assert.strictEqual(Ladder.verdictOf(workspaceReady(facts('android', ''))), 'pass');
});

test("the keys the app and its extension run with are checked against the workspace's", () => {
  const facts = (keys) => ({
    cio: authed,
    platform: 'ios',
    provider: 'apns',
    resolution: { how: 'explicit', candidates: [], workspace: { id: '94996', name: 'Mobile: Expo' } },
    credential: { config: 'sandbox' },
    keys: {
      workspaceKeys: [{ key: '79ea5300000000000000', source: 'Expo Testbed' }],
      ...keys,
    },
  });

  const held = workspaceReady(facts({ sdkKey: '79ea5300000000000000' }), 'development');
  assert.strictEqual(check(held, 'sdk_key').verdict, 'pass');
  assert.match(check(held, 'sdk_key').label, /App reports to Mobile: Expo/);
  // A real key is never printed whole.
  assert.match(check(held, 'sdk_key').evidence[0], /79ea53…, from source "Expo Testbed"/);

  // A key from another workspace and a dead one read the same here: nothing this workspace issued.
  const foreign = workspaceReady(facts({ sdkKey: 'localsmoke_cdp_key' }), 'development');
  assert.deepStrictEqual(causes(foreign), ['workspace.sdk_key_foreign']);
  assert.match(check(foreign, 'sdk_key').detail, /localsmoke_cdp_key, which no source in this workspace issued/);

  const extension = workspaceReady(
    facts({ extensionKey: { value: 'test-cdp-api-key', site: 'NotificationService/Env.swift:5' } }),
    'development'
  );
  assert.deepStrictEqual(causes(extension), ['workspace.extension_key_foreign']);
  assert.match(check(extension, 'extension_key').evidence.join(' '), /Env\.swift:5 runs with key test-cdp-api-key/);

  // Keys that could not be listed prove nothing either way.
  const unread = workspaceReady(facts({ sdkKey: 'abc', error: 'API error 403' }), 'development');
  assert.strictEqual(check(unread, 'sdk_key').verdict, 'skip');
});

const { androidDeviceReady } = require('../../dist/verify/areas/push/registration/android_device');

test('an answer from Firebase is enough, whatever 8.8.8.8 does', () => {
  const facts = (network) => ({
    target: { serial: 'emulator-5554', kind: 'emulator', model: 'sdk' },
    usable: [],
    installed: true,
    permissionGranted: true,
    network,
    sdk: { deviceToken: 'a'.repeat(140), userId: 'ami@customer.io', sources: [] },
  });
  const network = (rung) => check(rung, 'network_reachable');
  assert.strictEqual(network(androidDeviceReady(facts({ ip: false, dns: true }), 'io.app')).verdict, 'pass');
  assert.strictEqual(network(androidDeviceReady(facts({ ip: false, dns: false }), 'io.app')).cause, 'device.no_network');
  assert.strictEqual(network(androidDeviceReady(facts({ ip: true, dns: false }), 'io.app')).cause, 'device.dns_unresolved');
});

test('a build that is not debuggable is said to be unreadable, not to have no token', () => {
  const rung = androidDeviceReady(
    {
      target: { serial: 'emulator-5554', kind: 'emulator', model: 'sdk' },
      usable: [],
      installed: true,
      permissionGranted: true,
      network: { ip: true, dns: true },
      sdk: {
        sources: [],
        notDebuggable: true,
        error: 'run-as: package not debuggable: io.customer.testbed.expo',
      },
    },
    'io.customer.testbed.expo'
  );
  assert.deepStrictEqual(causes(rung), ['device.build_not_debuggable']);
  assert.strictEqual(check(rung, 'token_registered'), undefined);
  assert.strictEqual(check(rung, 'identity_read'), undefined);
});

test('the shared wiring causes no longer send an Android app to the iOS docs', () => {
  const { resolveCause } = require('../../dist/verify/core/report/causes');
  require('../../dist/verify/areas/push/causes');
  for (const code of ['wiring.sdk_absent', 'wiring.init_absent', 'wiring.init_not_at_launch']) {
    const cause = resolveCause(code);
    assert.doesNotMatch(cause.docs ?? '', /\/ios\//, code);
  }
  assert.match(resolveCause('wiring.init_absent').remedy, /Application\.onCreate on Android/);
});
