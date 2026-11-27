const test = require('node:test');
const assert = require('node:assert');

const {
  expandBuildVariables,
  hasUnresolvedVariable,
  needsResolution,
  productFilename,
  trimQuotes,
} = require('../../dist/verify/platform/ios/xcode');

test('build variables in an App Group are expanded before comparison', () => {
  // Comparing the literal is how a correctly-wired project gets reported as a mismatch.
  const settings = { BUNDLE_ID_PREFIX: 'io.customer.sample' };
  assert.strictEqual(
    expandBuildVariables('group.$(BUNDLE_ID_PREFIX).app', settings),
    'group.io.customer.sample.app'
  );
  assert.strictEqual(
    expandBuildVariables('group.${BUNDLE_ID_PREFIX}.app', settings),
    'group.io.customer.sample.app'
  );
});

test('an unknown variable is left alone and reported as unresolved', () => {
  assert.strictEqual(
    expandBuildVariables('group.$(NOPE).app', {}),
    'group.$(NOPE).app'
  );
  assert.strictEqual(hasUnresolvedVariable('group.$(NOPE).app'), true);
  assert.strictEqual(hasUnresolvedVariable('group.io.customer.app'), false);
});

test('a variable written with a modifier is unresolved, so xcodebuild evaluates it', () => {
  // The React Native template's bundle id.
  const rn = 'org.reactjs.native.example.$(PRODUCT_NAME:rfc1034identifier)';
  assert.strictEqual(hasUnresolvedVariable(rn), true);
  assert.strictEqual(hasUnresolvedVariable('${PRODUCT_NAME:identifier}'), true);
  // Expansion leaves the modifier form alone rather than guessing its value.
  assert.strictEqual(expandBuildVariables(rn, { PRODUCT_NAME: 'App' }), rn);
  // A modifier on a variable that is not in the value changes nothing.
  assert.strictEqual(hasUnresolvedVariable('org.example.app'), false);
});

test('the embedded product name falls back to the target name', () => {
  assert.strictEqual(
    productFilename({
      name: 'MyNSE',
      settings: {},
      embeds: [],
      dependencies: [],
    }),
    'MyNSE.appex'
  );
  assert.strictEqual(
    productFilename({
      name: 'MyNSE',
      settings: { PRODUCT_NAME: 'RichPush' },
      embeds: [],
      dependencies: [],
    }),
    'RichPush.appex'
  );
});

test('pbxproj values arrive quoted', () => {
  assert.strictEqual(
    trimQuotes('"com.apple.product-type.app-extension"'),
    'com.apple.product-type.app-extension'
  );
  assert.strictEqual(trimQuotes('plain'), 'plain');
});

test('an app or extension with no bundle id in the pbxproj is resolved with xcodebuild', () => {
  // React Native's template sets PRODUCT_BUNDLE_IDENTIFIER only in .xcconfig files, so the
  // pbxproj has no value at all rather than one holding a variable.
  const target = (productType, settings) => ({
    name: 'T',
    productType,
    settings,
    embeds: [],
    dependencies: [],
  });
  assert.strictEqual(
    needsResolution(target('com.apple.product-type.application', {})),
    true
  );
  assert.strictEqual(
    needsResolution(target('com.apple.product-type.app-extension', {})),
    true
  );
  assert.strictEqual(
    needsResolution(
      target('com.apple.product-type.application', {
        PRODUCT_BUNDLE_IDENTIFIER: 'io.customer.app',
        CODE_SIGN_ENTITLEMENTS: 'App/App.entitlements',
      })
    ),
    false
  );
  // A test bundle never needs one.
  assert.strictEqual(
    needsResolution(target('com.apple.product-type.bundle.unit-test', {})),
    false
  );
});

test('entitlements or an extension Info.plist set only in an .xcconfig are resolved with xcodebuild', () => {
  const target = (productType, settings) => ({ name: 'T', productType, settings, embeds: [], dependencies: [] });
  const app = { PRODUCT_BUNDLE_IDENTIFIER: 'io.customer.app' };
  assert.strictEqual(needsResolution(target('com.apple.product-type.application', app)), true);
  const extension = { PRODUCT_BUNDLE_IDENTIFIER: 'io.customer.app.nse' };
  assert.strictEqual(needsResolution(target('com.apple.product-type.app-extension', extension)), true);
  assert.strictEqual(
    needsResolution(target('com.apple.product-type.app-extension', { ...extension, INFOPLIST_FILE: 'NSE/Info.plist' })),
    false
  );
  // A generated Info.plist has no file to name.
  assert.strictEqual(
    needsResolution(target('com.apple.product-type.app-extension', { ...extension, GENERATE_INFOPLIST_FILE: 'YES' })),
    false
  );
});
