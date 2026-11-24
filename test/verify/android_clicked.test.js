const test = require('node:test');
const assert = require('node:assert');

const { androidClicked } = require('../../dist/verify/areas/push/on_device/android_opened');
const { judgeOpened } = require('../../dist/verify/areas/push/on_device/opened');

const nothing = {
  tracked: false,
  emptyId: false,
  failed: false,
  linkAttempted: false,
  linkHandled: false,
  linkUnhandled: false,
};

test('what the SDK says about the deep link is evidence that the click reached it', () => {
  assert.strictEqual(androidClicked(nothing), false);
  for (const key of Object.keys(nothing)) {
    assert.strictEqual(androidClicked({ ...nothing, [key]: true }), true, key);
  }
});

test('deep-link lines with no opened line are a tap the SDK saw, not one it did not', () => {
  const judged = (clicked) =>
    judgeOpened({
      available: true,
      clicked,
      tracked: false,
      foreign: false,
      emptyId: false,
      linkAttempted: true,
      linkHandled: false,
      linkUnhandled: true,
      linkSent: true,
    });
  assert.strictEqual(judged(false).cause, 'runtime.tap_not_seen');
  assert.deepStrictEqual(
    judged(androidClicked({ ...nothing, linkAttempted: true, linkUnhandled: true })),
    { verdict: 'fail', cause: 'runtime.opened_not_tracked' }
  );
});
