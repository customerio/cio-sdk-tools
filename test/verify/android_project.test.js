const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseLogcat, sdkLine } = require('../../dist/verify/platform/android/logcat');
const {
  androidSdkVersion,
  buildVariants,
  gradleSdkVersion,
  loadAndroidProject,
  sdkModulesFrom,
  wrapperNativeVersion,
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

test("WorkManager's lines about the SDK's workers are kept, and its other lines are not", () => {
  const worker = parseLogcat(
    '10-17 23:17:50.248 I/WM-WorkerWrapper( 7267): Worker result SUCCESS for Work [ id=d371dd2c, tags={ io.customer.messagingpush.processor.PushDeliveryMetricsWorker,cio-requests,cio-push-delivery } ]'
  );
  assert.strictEqual(sdkLine(worker), worker);
  const other = parseLogcat(
    '10-17 23:17:50.248 I/WM-WorkerWrapper( 7267): Worker result SUCCESS for Work [ id=1, tags={ com.example.SyncWorker } ]'
  );
  assert.strictEqual(sdkLine(other), undefined);
});

test('a module the build only compiles against is not shipped with the app', () => {
  // As cio-core.gradle declares it: shipped only when a Gradle property turns it on.
  const gradle = [
    'api "io.customer.android:messaging-push-fcm:$cioAndroidSDKVersion"',
    'if (project.cioLocationEnabled) {',
    '    api "io.customer.android:location:$cioAndroidSDKVersion"',
    '} else {',
    '    compileOnly "io.customer.android:location:$cioAndroidSDKVersion"',
    '}',
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

test("the CDP store read is the one for the SDK's configured key, not a stale one", () => {
  const { analyticsStore } = require('../../dist/verify/platform/android/device');
  const listing = 'analytics-android-localsmoke_key.xml\nanalytics-android-5f660a.xml\nio.customer.sdk.app.xml\n';
  assert.strictEqual(analyticsStore(listing, '5f660a'), 'analytics-android-5f660a.xml');
  // With no configured key to go by, the only store there is.
  assert.strictEqual(analyticsStore('analytics-android-abc.xml\n'), 'analytics-android-abc.xml');
  assert.strictEqual(analyticsStore('io.customer.sdk.app.xml\n', 'abc'), undefined);
});

test('the native SDK version is read written out, from a variable, or from a version catalog', () => {
  assert.strictEqual(gradleSdkVersion('implementation "io.customer.android:messaging-push-fcm:4.23.2"'), '4.23.2');
  assert.strictEqual(
    gradleSdkVersion('def cio = "4.9.0"\nimplementation "io.customer.android:datapipelines:${cio}"'),
    '4.9.0'
  );
  assert.strictEqual(
    gradleSdkVersion(
      '[versions]\ncustomerio-sdk = "4.10.1"\n[libraries]\ncio-push = { module = "io.customer.android:messaging-push-fcm", version.ref = "customerio-sdk" }'
    ),
    '4.10.1'
  );
  assert.strictEqual(gradleSdkVersion('implementation project(":messagingpush")'), undefined);
});

test("a wrapper's native version is the package's pin, unless the app overrides it", async () => {
  assert.strictEqual(wrapperNativeVersion('customerio.reactnative.cioSDKVersionAndroid=4.23.2'), '4.23.2');
  assert.strictEqual(
    wrapperNativeVersion('def cioVersion = rootProject.findProperty("cioVersion") ?: "4.23.2"'),
    '4.23.2'
  );

  const files = {
    'package.json': JSON.stringify({ dependencies: { 'react-native': '0.83.6', 'customerio-reactnative': '6.13.1' } }),
    'node_modules/customerio-reactnative/package.json': JSON.stringify({ version: '6.13.1' }),
    'node_modules/customerio-reactnative/android/cio-core.gradle':
      'dependencies {\n    api "io.customer.android:messaging-push-fcm:$cioAndroidSDKVersion"\n}',
    'node_modules/customerio-reactnative/android/gradle.properties': 'customerio.reactnative.cioSDKVersionAndroid=4.23.2',
    'android/settings.gradle': "include ':app'",
    'android/app/build.gradle': "apply plugin: 'com.android.application'",
  };
  const pinned = await loadAndroidProject(path.join(project(files), 'android', 'app'));
  assert.strictEqual(pinned.wrapper.sdkModulesRead, true);
  assert.deepStrictEqual(await androidSdkVersion(pinned), {
    version: '4.23.2',
    source: "customerio-reactnative's Gradle files",
  });

  const overridden = await loadAndroidProject(
    path.join(project({ ...files, 'android/gradle.properties': 'customerio.reactnative.cioSDKVersionAndroid=4.24.0' }), 'android', 'app')
  );
  assert.strictEqual((await androidSdkVersion(overridden)).version, '4.24.0');
});

test("a wrapper whose Gradle files never name the SDK is unread, not empty", async () => {
  const root = project({
    'package.json': JSON.stringify({ dependencies: { 'react-native': '0.83.6', 'customerio-reactnative': '7.0.0' } }),
    'node_modules/customerio-reactnative/package.json': JSON.stringify({ version: '7.0.0' }),
    'node_modules/customerio-reactnative/android/build.gradle': 'dependencies { api(libs.cio.push) }',
    'android/settings.gradle': "include ':app'",
    'android/app/build.gradle': "apply plugin: 'com.android.application'",
  });
  const model = await loadAndroidProject(path.join(root, 'android', 'app'));
  assert.deepStrictEqual(model.wrapper.sdkModules, []);
  assert.strictEqual(model.wrapper.sdkModulesRead, false);
});

test("an app's own :core module is not the SDK", () => {
  assert.deepStrictEqual(sdkModulesFrom('implementation project(":core")'), []);
  assert.deepStrictEqual(sdkModulesFrom('implementation(project(":messagingpush"))'), ['messagingpush']);
});
