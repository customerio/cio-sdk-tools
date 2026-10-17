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
