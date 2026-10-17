const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectFramework, loadWrapper } = require('../../dist/verify/platform/framework');
const { shortKey, workspaceKeys } = require('../../dist/verify/platform/cio/keys');

/** Lays out a project in a temporary folder: `{ 'relative/path': 'contents' }`. */
function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cio-verify-'));
  for (const [relative, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  }
  return root;
}

test('a React Native app gets its SDK through the package, and initializes from TypeScript', async () => {
  const root = project({
    'package.json': JSON.stringify({ dependencies: { 'react-native': '0.83.6', 'customerio-reactnative': '6.13.1' } }),
    'node_modules/customerio-reactnative/package.json': JSON.stringify({ version: '6.13.1' }),
    'src/App.tsx': "import { CustomerIO } from 'customerio-reactnative';\n\nCustomerIO.initialize(config);\n",
    // Another platform's code, and installed packages, are not the app's.
    'ios/AppDelegate.swift': 'CustomerIO.initialize(withConfig: config)',
    'node_modules/other/index.js': 'CustomerIO.initialize(x)',
    'android/app/build.gradle': "apply plugin: 'com.android.application'",
  });

  const wrapper = await loadWrapper(path.join(root, 'android', 'app'));
  assert.strictEqual(wrapper.framework, 'react-native');
  assert.strictEqual(wrapper.name, 'customerio-reactnative');
  assert.strictEqual(wrapper.declared, true);
  assert.strictEqual(wrapper.version, '6.13.1');
  assert.strictEqual(wrapper.directory, path.join(root, 'node_modules', 'customerio-reactnative'));
  assert.deepStrictEqual(wrapper.initSites, [{ file: path.join('src', 'App.tsx'), line: 3 }]);
  assert.strictEqual(await detectFramework(path.join(root, 'android', 'app')), 'react-native');
});

test('a Flutter app is found through pubspec.yaml and its package config', async () => {
  const root = project({
    'pubspec.yaml': 'name: sample\ndependencies:\n  flutter:\n    sdk: flutter\n  customer_io: ^4.7.2\n',
    '.dart_tool/package_config.json': JSON.stringify({
      packages: [{ name: 'customer_io', rootUri: '../plugin/', packageUri: 'lib/' }],
    }),
    'plugin/pubspec.yaml': 'name: customer_io\nversion: 4.7.2\n',
    'lib/src/customer_io.dart': 'void start() async {\n  await CustomerIO.initialize(\n    config: config,\n  );\n}\n',
  });

  const wrapper = await loadWrapper(path.join(root, 'ios', 'Runner.xcodeproj'));
  assert.strictEqual(wrapper.framework, 'flutter');
  assert.strictEqual(wrapper.declared, true);
  assert.strictEqual(wrapper.directory, path.join(root, 'plugin'));
  assert.strictEqual(wrapper.version, '4.7.2');
  assert.deepStrictEqual(wrapper.initSites, [{ file: path.join('lib', 'src', 'customer_io.dart'), line: 2 }]);
});

test('a native app has no wrapper, and an uninstalled package is declared but not found', async () => {
  const native = project({ 'app/build.gradle': "apply plugin: 'com.android.application'" });
  assert.strictEqual(await loadWrapper(path.join(native, 'app')), undefined);

  const uninstalled = project({
    'package.json': JSON.stringify({ dependencies: { expo: '55.0.0', 'customerio-reactnative': '6.13.1' } }),
  });
  const wrapper = await loadWrapper(path.join(uninstalled, 'android', 'app'));
  assert.strictEqual(wrapper.framework, 'expo');
  assert.strictEqual(wrapper.declared, true);
  assert.strictEqual(wrapper.directory, undefined);
  assert.deepStrictEqual(wrapper.initSites, []);
});

/** A `cio api` stand-in answering from a table of paths, with params substituted. */
function fakeApi(table) {
  const calls = [];
  const api = async (apiPath, params = {}) => {
    const resolved = apiPath.replace(/\{(\w+)\}/g, (_, name) => params[name]);
    calls.push(resolved);
    return resolved in table ? { ok: true, data: table[resolved] } : { ok: false, error: 'API error 404' };
  };
  return { api, calls };
}

test("a workspace's keys are read from each of its sources", async () => {
  const { api } = fakeApi({
    '/cdp/api/workspaces/1/sources': { sources: [{ id: 10, name: 'iOS app' }, { id: 11, name: 'Android app' }] },
    '/cdp/api/workspaces/1/sources/10/api_keys': { api_keys: [{ api_key: 'aaa' }] },
    '/cdp/api/workspaces/1/sources/11/api_keys': { api_keys: [{ api_key: 'bbb' }, { api_key: 'ccc' }] },
  });
  assert.deepStrictEqual(await workspaceKeys('1', api), {
    keys: [
      { key: 'aaa', source: 'iOS app' },
      { key: 'bbb', source: 'Android app' },
      { key: 'ccc', source: 'Android app' },
    ],
  });

  const failing = fakeApi({});
  assert.strictEqual((await workspaceKeys('1', failing.api)).keys.length, 0);
  assert.match((await workspaceKeys('1', failing.api)).error, /404/);
});

test('a real key is shortened, and a placeholder is printed as it is', () => {
  assert.strictEqual(shortKey('57b6553d60e40fefffd6'), '57b655…');
  assert.strictEqual(shortKey('test-cdp-api-key'), 'test-cdp-api-key');
});
