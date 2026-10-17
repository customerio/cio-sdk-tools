const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseLogcat, sdkLine } = require('../../dist/verify/platform/android/logcat');
const {
  buildVariants,
  loadAndroidProject,
  sdkModulesFrom,
} = require('../../dist/verify/platform/android/project');

/** Lays out a project in a temporary folder: `{ 'relative/path': 'contents' }`. */
function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cio-verify-'));
  for (const [relative, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  }
  return root;
}

test("React Native's forwarded SDK lines are the SDK's own, read as the native SDK writes them", () => {
  const forwarded = parseLogcat(
    '10-17 18:02:11.420 D/ReactNativeJS( 4242): [CIO] [Push] Received new message with deliveryId: dgS_abc'
  );
  assert.deepStrictEqual(sdkLine(forwarded), {
    at: '10-17 18:02:11.420',
    process: 'ReactNativeJS',
    message: '[Push] Received new message with deliveryId: dgS_abc',
  });

  const native = parseLogcat('10-17 18:02:11.420 D/[CIO]( 4242): [Push] Received new message with deliveryId: dgS_abc');
  assert.strictEqual(sdkLine(native), native);

  // The app's own JavaScript logging is not the SDK's.
  assert.strictEqual(sdkLine(parseLogcat('10-17 18:02:11.420 I/ReactNativeJS( 4242): Running "main"')), undefined);
});

test('a module the build only compiles against is not shipped with the app', () => {
  const gradle = [
    'api "io.customer.android:messaging-push-fcm:$cioAndroidSDKVersion"',
    '    compileOnly "io.customer.android:location:$cioAndroidSDKVersion"',
  ].join('\n');
  assert.deepStrictEqual(sdkModulesFrom(gradle), ['messaging-push-fcm']);
});

test("a React Native app's SDK modules and permission come from the package's own build", async () => {
  const root = project({
    'package.json': JSON.stringify({ dependencies: { 'react-native': '0.83.6', 'customerio-reactnative': '6.13.1' } }),
    'node_modules/customerio-reactnative/package.json': JSON.stringify({ version: '6.13.1' }),
    'node_modules/customerio-reactnative/android/build.gradle': "apply from: 'cio-core.gradle'",
    'node_modules/customerio-reactnative/android/cio-core.gradle': [
      'dependencies {',
      '    api "io.customer.android:datapipelines:$cioAndroidSDKVersion"',
      '    api "io.customer.android:messaging-push-fcm:$cioAndroidSDKVersion"',
      '        compileOnly "io.customer.android:geofence:$cioAndroidSDKVersion"',
      '}',
    ].join('\n'),
    'node_modules/customerio-reactnative/android/src/main/AndroidManifest.xml':
      '<manifest><uses-permission android:name="android.permission.POST_NOTIFICATIONS" /></manifest>',
    'android/settings.gradle': "include ':app'",
    'android/app/build.gradle': "apply plugin: 'com.android.application'\nandroid { namespace 'io.customer.sample' }",
    'android/app/src/main/AndroidManifest.xml': '<manifest><application android:name=".MainApplication" /></manifest>',
  });

  const model = await loadAndroidProject(path.join(root, 'android', 'app'));
  assert.deepStrictEqual(model.sdkModules, []);
  assert.strictEqual(model.wrapper.name, 'customerio-reactnative');
  assert.deepStrictEqual(model.wrapper.sdkModules.sort(), ['datapipelines', 'messaging-push-fcm']);
  assert.match(model.wrapper.manifest, /POST_NOTIFICATIONS/);
  assert.strictEqual(model.wrapper.version, '6.13.1');
});

test("Flutter's build is found in the project's own build folder", async () => {
  const root = project({
    'pubspec.yaml': 'name: sample\n',
    'android/settings.gradle': '',
    'android/app/build.gradle': "apply plugin: 'com.android.application'",
    'build/app/outputs/apk/debug/output-metadata.json': JSON.stringify({
      applicationId: 'io.customer.flutter.sample',
      variantName: 'debug',
    }),
  });
  const variants = await buildVariants(path.join(root, 'android', 'app'));
  assert.deepStrictEqual(
    variants.map((variant) => [variant.applicationId, variant.variantName]),
    [['io.customer.flutter.sample', 'debug']]
  );
});
