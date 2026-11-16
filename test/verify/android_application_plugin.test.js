const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  appliesApplicationPlugin,
} = require('../../dist/verify/platform/android/application_plugin');
const {
  loadAndroidProject,
} = require('../../dist/verify/platform/android/project');

/** Lays out a project in a temporary folder: `{ 'relative/path': 'contents' }`. */
function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cio-verify-alias-'));
  for (const [relative, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  }
  return root;
}

const CATALOG = [
  '[versions]',
  'agp = "8.5.0"',
  '[plugins]',
  'android-application = { id = "com.android.application", version.ref = "agp" }',
  'kotlin-android = { id = "org.jetbrains.kotlin.android", version = "2.0.0" }',
  'androidLibrary = { id = "com.android.library", version.ref = "agp" }',
].join('\n');

test('an alias to the application plugin makes a module an app module', async () => {
  const root = project({
    'gradle/libs.versions.toml': CATALOG,
    'app/build.gradle.kts': '',
  });
  const module = path.join(root, 'app');
  const aliased = 'plugins { alias(libs.plugins.android.application) }';
  assert.strictEqual(await appliesApplicationPlugin(module, aliased), true);
  // Not the application plugin, and unknown aliases.
  assert.strictEqual(
    await appliesApplicationPlugin(
      module,
      'plugins { alias(libs.plugins.kotlin.android) }'
    ),
    false
  );
  assert.strictEqual(
    await appliesApplicationPlugin(
      module,
      'plugins { alias(libs.plugins.androidLibrary) }'
    ),
    false
  );
  assert.strictEqual(
    await appliesApplicationPlugin(
      module,
      'plugins { alias(libs.plugins.nope) }'
    ),
    false
  );
});

test('the root build file that only declares the plugin is not an app module', async () => {
  const root = project({ 'gradle/libs.versions.toml': CATALOG });
  assert.strictEqual(
    await appliesApplicationPlugin(
      root,
      'plugins { alias(libs.plugins.android.application) apply false }'
    ),
    false
  );
});

test('the literal id and an alias without a catalog behave as before', async () => {
  const root = project({ 'app/build.gradle': '' });
  assert.strictEqual(
    await appliesApplicationPlugin(
      root,
      "apply plugin: 'com.android.application'"
    ),
    true
  );
  assert.strictEqual(
    await appliesApplicationPlugin(
      root,
      'plugins { id("com.android.application") }'
    ),
    true
  );
  assert.strictEqual(
    await appliesApplicationPlugin(
      root,
      'plugins { alias(libs.plugins.android.application) }'
    ),
    false
  );
});

test('an app that applies the plugin through the catalog is loaded', async () => {
  const root = project({
    'settings.gradle.kts': 'include(":app")',
    'build.gradle.kts':
      'plugins { alias(libs.plugins.android.application) apply false }',
    'gradle/libs.versions.toml': CATALOG,
    'app/build.gradle.kts': [
      'plugins { alias(libs.plugins.android.application) }',
      'android { namespace = "io.customer.sample"',
      '  defaultConfig { applicationId = "io.customer.sample" } }',
    ].join('\n'),
    'app/src/main/AndroidManifest.xml': '<manifest><application /></manifest>',
  });
  const model = await loadAndroidProject(path.join(root, 'app'));
  assert.ok(model, 'the project is found');
  assert.strictEqual(model.applicationId, 'io.customer.sample');
});

test('a literal declaration that ends in apply false is not an app module either', async () => {
  const root = project({ 'app/build.gradle': '' });
  assert.strictEqual(
    await appliesApplicationPlugin(
      root,
      'plugins { id("com.android.application") version "8.5.0" apply false }'
    ),
    false
  );
  assert.strictEqual(
    await appliesApplicationPlugin(
      root,
      "plugins {\n  id 'com.android.application' version '8.5.0' apply false\n}"
    ),
    false
  );
  // The module itself applies it, even with a declaration above it that does not.
  assert.strictEqual(
    await appliesApplicationPlugin(
      root,
      'plugins { id("com.android.application") version "8.5.0" apply false }\napply plugin: \'com.android.application\''
    ),
    true
  );
});

test('loaded from the project root, the app module is chosen and not the root', async () => {
  const root = project({
    'settings.gradle.kts': 'include(":app")',
    'build.gradle.kts':
      'plugins { id("com.android.application") version "8.5.0" apply false }',
    'app/build.gradle.kts': [
      'plugins { id("com.android.application") }',
      'android { namespace = "io.customer.sample"',
      '  defaultConfig { applicationId = "io.customer.sample" } }',
    ].join('\n'),
    'app/src/main/AndroidManifest.xml': '<manifest><application /></manifest>',
  });
  const model = await loadAndroidProject(root);
  assert.ok(model, 'the project is found');
  assert.strictEqual(model.applicationId, 'io.customer.sample');
  assert.strictEqual(model.appModuleName, 'app');
});
