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

test('POST_NOTIFICATIONS missing below Android 13 warns with a warning cause that says so', () => {
  const { notificationPermissionCheck } = require('../../dist/verify/areas/push/registration/android_wiring');
  const model = (targetSdk) => ({ manifest: '<manifest/>', gradle: targetSdk ? `targetSdk ${targetSdk}` : '', sdkModules: [] });
  const below = notificationPermissionCheck(model(31));
  assert.deepStrictEqual([below.verdict, below.cause], ['warn', 'wiring.post_notifications_not_yet_required']);
  assert.strictEqual(resolveCause(below.cause).severity, 'warning');
  assert.strictEqual(notificationPermissionCheck(model(undefined)).cause, 'wiring.post_notifications_not_yet_required');
  const required = notificationPermissionCheck(model(34));
  assert.deepStrictEqual([required.verdict, required.cause], ['fail', 'wiring.post_notifications_undeclared']);
});

test('a simulator build with no entitlements section to read is a warning with a cause, not a silent pass', () => {
  const { installedBuildCheck } = require('../../dist/verify/areas/push/registration/device_ready');
  const check = installedBuildCheck({ appPath: '/tmp/App.app', entitlements: undefined });
  assert.deepStrictEqual([check.verdict, check.cause], ['warn', 'device.entitlements_unread']);
  assert.strictEqual(Ladder.verdictOf({ id: 'device_ready', checks: [check] }), 'warn');
});

test("an extension whose own sources cannot be found is not judged on the app's code", async () => {
  const { nseSourcesFor } = require('../../dist/verify/areas/push/registration/project_wiring');
  const model = { projectPath: '/p/App.xcodeproj' };
  const app = { absolutePath: '/p/App/AppDelegate.swift', path: 'App/AppDelegate.swift', text: 'didReceive' };
  const ext = { absolutePath: '/p/NSE/NotificationService.swift', path: 'NSE/NotificationService.swift', text: '' };
  assert.strictEqual(await nseSourcesFor(model, { settings: {} }, [app, ext]), undefined);
  assert.strictEqual(await nseSourcesFor(model, { settings: { INFOPLIST_FILE: 'Other/Info.plist' } }, [app, ext]), undefined);
  assert.deepStrictEqual(await nseSourcesFor(model, { settings: { INFOPLIST_FILE: 'NSE/Info.plist' } }, [app, ext]), [ext]);
});

test('an identity found here and elsewhere, without this device, does not say it lives elsewhere', () => {
  const { elsewhereCheck } = require('../../dist/verify/areas/push/registration/profile_linked');
  const other = { workspace: { id: '9', name: 'Staging' }, hasToken: false };
  const check = elsewhereCheck(false, [other]);
  assert.deepStrictEqual([check.verdict, check.cause], ['warn', 'profile.identity_also_elsewhere']);
  assert.strictEqual(resolveCause(check.cause).severity, 'warning');
  // The device itself elsewhere is still the explanation, and still a failure.
  assert.strictEqual(elsewhereCheck(false, [{ ...other, hasToken: true }]).cause, 'profile.device_in_other_workspace');
  assert.strictEqual(elsewhereCheck(true, [other]), undefined);
});

test("an unreadable container does not hide the SDK's own word that it holds no token", () => {
  const { deviceReady } = require('../../dist/verify/areas/push/registration/device_ready');
  const facts = {
    target: { kind: 'simulator', name: 'iPhone 16', udid: 'U1', state: 'booted' },
    usable: [],
    ambiguous: [],
    installed: true,
    containerError: 'container copy failed',
    stateLine: { noToken: true },
  };
  const rung = deviceReady(facts, 'io.example.app');
  assert.ok(causes(rung).includes('device.token_unregistered'), causes(rung).join());
  assert.strictEqual(Ladder.verdictOf(rung), 'fail');
  // With nothing said either way, the unreadable container stays a warning.
  const silent = deviceReady({ ...facts, stateLine: undefined }, 'io.example.app');
  assert.deepStrictEqual(causes(silent), ['device.container_unreadable']);
});

test('a device found in another workspace is the one cause, not beside a stale-token blocker', () => {
  const { linkFindings, elsewhereCheck } = require('../../dist/verify/areas/push/registration/profile_linked');
  const notLinked = { id: 'device_linked', verdict: 'fail', label: 'x', cause: 'profile.token_not_linked', evidence: [] };
  const other = { id: 'other', verdict: 'pass', label: 'y', evidence: [] };
  const holder = elsewhereCheck(false, [{ workspace: { id: '9', name: 'Staging' }, hasToken: true }]);
  assert.deepStrictEqual(
    linkFindings([notLinked, other], holder).map((c) => c.cause ?? c.id),
    ['other', 'profile.device_in_other_workspace']
  );
  // An identity elsewhere without this device explains nothing, so the link failure stays.
  const identity = elsewhereCheck(false, [{ workspace: { id: '9' }, hasToken: false }]);
  assert.deepStrictEqual(
    linkFindings([notLinked], identity).map((c) => c.cause),
    ['profile.token_not_linked', 'profile.identity_also_elsewhere']
  );
  assert.deepStrictEqual(linkFindings([notLinked], undefined), [notLinked]);
});

test('an init at launch passes, and a leftover call elsewhere is a warning beside it', () => {
  const { initializationChecks } = require('../../dist/verify/areas/push/registration/project_wiring');
  const site = (runsAtLaunch, scope) => ({ file: 'App.swift', line: 3, scope, runsAtLaunch });
  const both = initializationChecks({ files: 2, initSites: [site(true, 'AppDelegate'), site(false, 'ContentView.body')] });
  assert.deepStrictEqual(
    both.map((check) => [check.id, check.verdict, check.cause]),
    [
      ['init_at_launch', 'pass', undefined],
      ['init_outside_launch', 'warn', 'wiring.init_also_outside_launch'],
    ]
  );
  // Only outside launch is still the blocker.
  const only = initializationChecks({ files: 1, initSites: [site(false, 'ContentView.body')] });
  assert.deepStrictEqual(only.map((check) => check.cause), ['wiring.init_not_at_launch']);
});

test('a token given over an unreadable container goes on, and says the stores were not read', () => {
  const { deviceReady } = require('../../dist/verify/areas/push/registration/device_ready');
  const facts = {
    target: { kind: 'simulator', name: 'iPhone 16', udid: 'U1', state: 'booted' },
    usable: [],
    ambiguous: [],
    installed: true,
    containerError: 'container copy failed',
    sdk: {
      pushDeviceToken: 'a'.repeat(64),
      userId: 'person@example.com',
      sources: ['--token', '--user'],
      stores: { sdk: false, context: false, cdp: false },
    },
  };
  const rung = deviceReady(facts, 'io.example.app');
  assert.deepStrictEqual(causes(rung), ['device.container_unreadable_token_known']);
  assert.strictEqual(Ladder.verdictOf(rung), 'warn');
  assert.ok(rung.checks.some((check) => check.id === 'token_registered' && check.verdict === 'pass'));
});

test('a key found among the sources that loaded passes, though another source failed', () => {
  const rung = workspaceReady({
    cio: authed,
    resolution: { how: 'explicit', candidates: [], workspace: { id: '1', name: 'W' } },
    credential: { kind: 'apns' },
    keys: {
      sdkKey: 'abc',
      sdkKeyChecked: true,
      extensionKey: { value: 'zzz', site: 'NotificationService.swift:10' },
      workspaceKeys: [{ key: 'abc', source: 'iOS app' }],
      error: 'API error 429',
    },
  });
  const checks = rung.checks.filter((c) => c.id.endsWith('_key'));
  assert.deepStrictEqual(
    checks.map((c) => [c.id, c.verdict, c.cause]),
    [
      ['sdk_key', 'pass', undefined],
      // Not among the loaded keys, and possibly in the source that failed.
      ['extension_key', 'skip', 'workspace.lookup_failed'],
    ]
  );
});

test('a wait that read "no profile" and then failed still says the profile is missing', async () => {
  let reads = 0;
  const rung = await profileLinked(
    profileInput(async () => {
      reads += 1;
      if (reads <= 2) return null;
      throw new Error('customer lookup failed: network');
    })
  );
  assert.deepStrictEqual(causes(rung), ['profile.not_found']);
  assert.strictEqual(Ladder.verdictOf(rung), 'fail');
});

test("POST_NOTIFICATIONS merged in from Firebase Messaging counts, and an unread wrapper is unproven", () => {
  const { notificationPermissionCheck } = require('../../dist/verify/areas/push/registration/android_wiring');
  const base = { manifest: '<manifest/>', gradle: 'targetSdk 36' };
  const fcm = notificationPermissionCheck({ ...base, sdkModules: ['datapipelines', 'messaging-push-fcm'] });
  assert.strictEqual(fcm.verdict, 'pass');
  assert.match(fcm.evidence.join(' '), /Firebase Messaging/);
  const unread = notificationPermissionCheck({
    ...base,
    sdkModules: [],
    wrapper: { name: 'customerio-reactnative', declared: true, sdkModules: [] },
  });
  assert.deepStrictEqual([unread.verdict, unread.cause], ['skip', 'wiring.wrapper_not_installed']);
});

test("google-services.json in a variant's source set, for the installed variant's package, passes", async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { loadAndroidProject } = require('../../dist/verify/platform/android/project');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cio-verify-'));
  const write = (relative, text) => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  };
  const services = (name) => JSON.stringify({ client: [{ client_info: { android_client_info: { package_name: name } } }] });
  write('settings.gradle', "include ':app'");
  write('app/build.gradle', "apply plugin: 'com.android.application'\nandroid { defaultConfig { applicationId 'com.example.app' } }");
  write('app/src/debug/google-services.json', services('com.example.app.debug'));
  write('app/src/free/release/google-services.json', services('com.example.app.free'));
  const model = await loadAndroidProject(path.join(root, 'app'));
  assert.strictEqual(googleServicesCheck(model, 'com.example.app.debug').verdict, 'pass');
  assert.strictEqual(googleServicesCheck(model, 'com.example.app.free').verdict, 'pass');
  // Against the base id that no file lists, it is still a mismatch, never "missing".
  assert.strictEqual(googleServicesCheck(model).cause, 'wiring.google_services_package_mismatch');
});

test("POST_NOTIFICATIONS under an installed wrapper whose Gradle can't be read is a warning", () => {
  const { notificationPermissionCheck } = require('../../dist/verify/areas/push/registration/android_wiring');
  const check = notificationPermissionCheck({
    manifest: '<manifest/>',
    gradle: 'targetSdk 35',
    sdkModules: [],
    wrapper: { name: 'customerio-reactnative', declared: true, directory: '/x', sdkModules: [], sdkModulesRead: false },
  });
  assert.deepStrictEqual([check.verdict, check.cause], ['warn', 'wiring.wrapper_build_unread']);
});

test('an init the tool could not follow, beside a leftover call, is unproven rather than not at launch', () => {
  const { initializationChecks } = require('../../dist/verify/areas/push/registration/project_wiring');
  const site = (runsAtLaunch, scope) => ({ file: 'App.swift', line: 3, scope, runsAtLaunch });
  const checks = initializationChecks({ files: 2, initSites: [site('unknown', 'AppSetup.start'), site(false, 'ContentView.body')] });
  assert.deepStrictEqual(
    checks.map((check) => [check.id, check.verdict, check.cause]),
    [
      ['init_at_launch', 'warn', 'wiring.init_launch_unproven'],
      ['init_outside_launch', 'warn', 'wiring.init_also_outside_launch'],
    ]
  );
});
