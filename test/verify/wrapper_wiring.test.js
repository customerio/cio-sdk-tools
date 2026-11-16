const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { androidWiring } = require('../../dist/verify/areas/push/registration/android_wiring');
const { projectWiring } = require('../../dist/verify/areas/push/registration/project_wiring');

/** Lays out a project in a temporary folder: `{ 'relative/path': 'contents' }`. */
function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cio-verify-'));
  for (const [relative, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  }
  return root;
}

const check = (rung, id) => rung.checks.find((c) => c.id === id);

/** A React Native app the way the sample is laid out, with or without its initialize call. */
function reactNativeApp({ initialize = true } = {}) {
  return project({
    'package.json': JSON.stringify({ dependencies: { 'react-native': '0.83.6', 'customerio-reactnative': '6.13.1' } }),
    'node_modules/customerio-reactnative/package.json': JSON.stringify({ version: '6.13.1' }),
    'node_modules/customerio-reactnative/android/cio-core.gradle': [
      'dependencies {',
      '    api "io.customer.android:datapipelines:$cioAndroidSDKVersion"',
      '    api "io.customer.android:messaging-push-fcm:$cioAndroidSDKVersion"',
      '}',
    ].join('\n'),
    'node_modules/customerio-reactnative/android/src/main/AndroidManifest.xml':
      '<manifest><uses-permission android:name="android.permission.POST_NOTIFICATIONS" /></manifest>',
    'src/App.tsx': initialize ? 'CustomerIO.initialize(config);\n' : 'export default App;\n',
    'android/settings.gradle': "include ':app'",
    'android/build.gradle': 'ext { targetSdkVersion = 36 }',
    'android/app/build.gradle': "apply plugin: 'com.android.application'\nandroid { namespace 'io.customer.rn_sample.fcm' }",
    'android/app/src/main/AndroidManifest.xml': '<manifest><application android:name=".MainApplication" /></manifest>',
    'android/app/google-services.json': JSON.stringify({
      client: [{ client_info: { android_client_info: { package_name: 'io.customer.rn_sample.fcm' } } }],
    }),
    'ios/Sample/AppDelegate.swift': 'import CioMessagingPushAPN\nclass AppDelegate {}\n',
  });
}

test('a React Native app on Android is wired through its package', async () => {
  const root = reactNativeApp();
  const { rung } = await androidWiring({ projectPath: path.join(root, 'android', 'app') });

  assert.strictEqual(check(rung, 'sdk_present').verdict, 'pass');
  assert.match(check(rung, 'sdk_present').evidence[0], /through customerio-reactnative 6\.13\.1/);
  assert.strictEqual(check(rung, 'push_module').verdict, 'pass');
  assert.strictEqual(check(rung, 'init_present').verdict, 'pass');
  assert.deepStrictEqual(check(rung, 'init_present').evidence, [path.join('src', 'App.tsx') + ':1']);
  assert.strictEqual(check(rung, 'post_notifications').verdict, 'pass');
  assert.match(check(rung, 'post_notifications').evidence[0], /customerio-reactnative's manifest/);
  // The rule for native apps is not the wrapper's to follow.
  assert.strictEqual(check(rung, 'init_at_launch'), undefined);
});

test('a React Native app that never calls initialize still fails, on both platforms', async () => {
  const root = reactNativeApp({ initialize: false });
  const android = await androidWiring({ projectPath: path.join(root, 'android', 'app') });
  assert.strictEqual(check(android.rung, 'init_present').cause, 'wiring.init_absent');

  const xcodeproj = path.join(root, 'ios', 'Sample.xcodeproj');
  const ios = await projectWiring({
    projectPath: xcodeproj,
    scanRoot: path.join(root, 'ios'),
    model: {
      projectPath: xcodeproj,
      projectName: 'Sample',
      configuration: 'Debug',
      resolvedByXcodebuild: false,
      format: 'pbxproj',
      targets: [
        {
          name: 'Sample',
          productType: 'com.apple.product-type.application',
          settings: { PRODUCT_BUNDLE_IDENTIFIER: 'io.customer.ami' },
          embeds: [],
          dependencies: [],
        },
      ],
    },
  });
  assert.strictEqual(check(ios.rung, 'init_present').cause, 'wiring.init_absent');
  assert.match(check(ios.rung, 'init_present').evidence.join(' '), /JavaScript and TypeScript files/);
});

test('a React Native app on iOS initializes from TypeScript', async () => {
  const root = reactNativeApp();
  const xcodeproj = path.join(root, 'ios', 'Sample.xcodeproj');
  const { rung } = await projectWiring({
    projectPath: xcodeproj,
    scanRoot: path.join(root, 'ios'),
    model: {
      projectPath: xcodeproj,
      projectName: 'Sample',
      configuration: 'Debug',
      resolvedByXcodebuild: false,
      format: 'pbxproj',
      targets: [
        {
          name: 'Sample',
          productType: 'com.apple.product-type.application',
          settings: { PRODUCT_BUNDLE_IDENTIFIER: 'io.customer.ami' },
          embeds: [],
          dependencies: [],
        },
      ],
    },
  });
  assert.strictEqual(check(rung, 'init_present').verdict, 'pass');
  assert.deepStrictEqual(check(rung, 'init_present').evidence, [path.join('src', 'App.tsx') + ':1']);
});

/** A native iOS app and its extension, sharing the App Groups given, on the SDK version given. */
async function nativeIosWiring({ sdkVersion, groups, inCode }) {
  const plist = (body) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${body}</dict></plist>`;
  const groupList = plist(
    `<key>com.apple.security.application-groups</key><array>${groups.map((g) => `<string>${g}</string>`).join('')}</array>`
  );
  const root = project({
    'ios/Podfile.lock': sdkVersion ? `PODS:\n  - CustomerIO/MessagingPushAPN (${sdkVersion}):\n` : 'PODS:\n',
    'ios/Sample/AppDelegate.swift': 'import CioMessagingPushAPN\nCustomerIO.initialize(withConfig: config)\n',
    'ios/Sample/Sample.entitlements': groupList,
    'ios/NSE/NSE.entitlements': groupList,
    'ios/NSE/Info.plist': plist(
      '<key>NSExtension</key><dict><key>NSExtensionPointIdentifier</key><string>com.apple.usernotifications.service</string></dict>'
    ),
    'ios/NSE/NotificationService.swift': `import CioMessagingPushAPN\n${
      inCode ? `MessagingPushConfigBuilder(cdpApiKey: "k").appGroupId("${inCode}")\n` : ''
    }MessagingPushAPN.shared.didReceive(request, withContentHandler: contentHandler)\n`,
  });
  const xcodeproj = path.join(root, 'ios', 'Sample.xcodeproj');
  const { rung, sdkVersion: read } = await projectWiring({
    projectPath: xcodeproj,
    scanRoot: path.join(root, 'ios'),
    model: {
      projectPath: xcodeproj,
      projectName: 'Sample',
      configuration: 'Debug',
      resolvedByXcodebuild: false,
      format: 'pbxproj',
      targets: [
        {
          name: 'Sample',
          productType: 'com.apple.product-type.application',
          settings: { PRODUCT_BUNDLE_IDENTIFIER: 'io.customer.ami', CODE_SIGN_ENTITLEMENTS: 'Sample/Sample.entitlements' },
          embeds: ['NSE.appex'],
          dependencies: ['NSE'],
        },
        {
          name: 'NSE',
          productType: 'com.apple.product-type.app-extension',
          settings: {
            PRODUCT_BUNDLE_IDENTIFIER: 'io.customer.ami.NSE',
            CODE_SIGN_ENTITLEMENTS: 'NSE/NSE.entitlements',
            INFOPLIST_FILE: 'NSE/Info.plist',
          },
          embeds: [],
          dependencies: [],
        },
      ],
    },
  });
  return { check: check(rung, 'app_group_agreement'), sdkVersion: read };
}

// The extension is found through its Info.plist, read with plutil: it runs only on macOS.
const MACOS_ONLY = { skip: process.platform !== 'darwin' && 'plutil is macOS-only' };

test("from 4.4 the SDK reads its own App Group, so a different shared group doesn't count", MACOS_ONLY, async () => {
  const other = await nativeIosWiring({ sdkVersion: '4.9.0', groups: ['group.shared.other'] });
  assert.strictEqual(other.sdkVersion.version, '4.9.0');
  assert.strictEqual(other.check.cause, 'wiring.app_group_mismatch');
  assert.match(other.check.evidence.join(' '), /SDK default: group\.io\.customer\.ami\.cio/);

  const own = await nativeIosWiring({ sdkVersion: '4.9.0', groups: ['group.io.customer.ami.cio'] });
  assert.strictEqual(own.check.verdict, 'pass');

  // appGroupId() in code names the group itself.
  const named = await nativeIosWiring({ sdkVersion: '4.9.0', groups: ['group.shared.other'], inCode: 'group.shared.other' });
  assert.strictEqual(named.check.verdict, 'pass');

  // Before 4.4 nothing is shared through a group, so there is nothing to agree on.
  const older = await nativeIosWiring({ sdkVersion: '4.3.0', groups: [] });
  assert.strictEqual(older.check.verdict, 'skip');

  // An unknown version keeps the old reading: any group both targets share.
  const unknown = await nativeIosWiring({ groups: ['group.shared.other'] });
  assert.strictEqual(unknown.check.verdict, 'pass');
});

test("a wrapper whose Gradle files the tool can't read is a warning, not a missing module", async () => {
  const root = project({
    'package.json': JSON.stringify({ dependencies: { 'react-native': '0.83.6', 'customerio-reactnative': '7.0.0' } }),
    'node_modules/customerio-reactnative/package.json': JSON.stringify({ version: '7.0.0' }),
    'node_modules/customerio-reactnative/android/build.gradle': 'dependencies { api(libs.cio.push) }',
    'src/App.tsx': 'CustomerIO.initialize(config);\n',
    'android/settings.gradle': "include ':app'",
    'android/app/build.gradle': "apply plugin: 'com.android.application'",
  });
  const { rung } = await androidWiring({ projectPath: path.join(root, 'android', 'app') });
  assert.strictEqual(check(rung, 'push_module').verdict, 'warn');
  assert.strictEqual(check(rung, 'push_module').cause, 'wiring.wrapper_build_unread');
});
