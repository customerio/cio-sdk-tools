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

test('an Android target older than 13 has no notification permission to read, and is not told it is denied', () => {
  const { androidDeviceReady } = require('../../dist/verify/areas/push/registration/android_device');
  const facts = (apiLevel) => ({
    target: { serial: 'S', model: 'Pixel', kind: 'emulator', apiLevel },
    usable: [],
    installed: true,
    sdk: { userId: 'u', deviceToken: 't', sources: [], stores: { sdk: true, cdp: true } },
    permissionGranted: undefined,
    network: { ip: true, dns: true },
    stopped: false,
  });
  const check = (apiLevel) =>
    androidDeviceReady(facts(apiLevel), 'com.example.app', false).checks.find(
      (c) => c.id === 'notification_permission'
    );

  assert.strictEqual(check(31).verdict, 'pass');
  assert.strictEqual(check(31).cause, undefined);
  // From Android 13 an entry is expected, so its absence is unknown rather than denied.
  assert.deepStrictEqual(
    [check(34).verdict, check(34).cause],
    ['warn', 'device.notification_permission_unread']
  );
  assert.strictEqual(check(undefined).cause, 'device.notification_permission_unread');
});

test('a wrapper that is declared and not installed leaves the push module unproven, with a cause', () => {
  const { pushModuleCheck } = require('../../dist/verify/areas/push/registration/android_wiring');
  const check = pushModuleCheck({
    sdkModules: [],
    wrapper: { name: 'customerio-reactnative', declared: true, sdkModules: [] },
  });
  assert.deepStrictEqual([check.verdict, check.cause], ['skip', 'wiring.wrapper_not_installed']);
  const rung = { id: 'project_wiring', checks: [check] };
  assert.strictEqual(Ladder.verdictOf(rung), 'skip');
});

test('a non-debuggable Android build goes on with a token the person gave, and stops without one', () => {
  const { androidDeviceReady } = require('../../dist/verify/areas/push/registration/android_device');
  const facts = (token) => ({
    target: { serial: 'S', model: 'Pixel', kind: 'emulator', apiLevel: 34 },
    usable: [],
    installed: true,
    sdk: { error: 'run-as: package not debuggable', notDebuggable: true, deviceToken: token, sources: token ? ['--token'] : [], stores: { sdk: false, cdp: false } },
    permissionGranted: true,
    network: { ip: true, dns: true },
    stopped: false,
  });
  const given = androidDeviceReady(facts('tok'), 'com.example.app', false);
  const readable = given.checks.find((c) => c.id === 'sdk_state_readable');
  assert.deepStrictEqual([readable.verdict, readable.cause], ['warn', 'device.build_not_debuggable_token_given']);
  assert.ok(given.checks.some((c) => c.id === 'token_registered'), 'the token is still judged');
  const without = androidDeviceReady(facts(undefined), 'com.example.app', false);
  assert.strictEqual(without.checks.find((c) => c.id === 'sdk_state_readable').cause, 'device.build_not_debuggable');
  assert.ok(!without.checks.some((c) => c.id === 'token_registered'));
});

test('a --device model name that matches several Android targets is said to be ambiguous', () => {
  const { androidDeviceReady } = require('../../dist/verify/areas/push/registration/android_device');
  const emulator = (serial) => ({ serial, model: 'sdk_gphone', kind: 'emulator', state: 'device' });
  const rung = androidDeviceReady(
    { target: undefined, usable: [emulator('emulator-5554'), emulator('emulator-5556')], ambiguous: [emulator('emulator-5554'), emulator('emulator-5556')], selector: 'sdk_gphone', installed: false },
    'com.example.app',
    false
  );
  assert.match(rung.checks[0].evidence[0], /--device sdk_gphone names 2 running targets; pass one's serial/);
  const none = androidDeviceReady(
    { target: undefined, usable: [], ambiguous: [], selector: 'nothing', installed: false },
    'com.example.app',
    false
  );
  assert.match(none.checks[0].evidence[0], /matched no connected device/);
});
