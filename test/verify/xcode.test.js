const test = require('node:test');
const assert = require('node:assert');

const {
  expandBuildVariables,
  hasUnresolvedVariable,
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
  assert.strictEqual(expandBuildVariables('group.$(NOPE).app', {}), 'group.$(NOPE).app');
  assert.strictEqual(hasUnresolvedVariable('group.$(NOPE).app'), true);
  assert.strictEqual(hasUnresolvedVariable('group.io.customer.app'), false);
});

test('the embedded product name falls back to the target name', () => {
  assert.strictEqual(
    productFilename({ name: 'MyNSE', settings: {}, embeds: [], dependencies: [] }),
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
  assert.strictEqual(trimQuotes('"com.apple.product-type.app-extension"'), 'com.apple.product-type.app-extension');
  assert.strictEqual(trimQuotes('plain'), 'plain');
});
