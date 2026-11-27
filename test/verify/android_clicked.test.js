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
  linkFellBack: false,
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
    {
      verdict: 'fail',
      cause: 'runtime.opened_not_tracked',
      linkOutcome: { verdict: 'fail', cause: 'runtime.deep_link_not_handled' },
    }
  );
});

test("a tap whose only line is the SDK's fallback to the app's main screen is a click", () => {
  const { androidClicked } = require('../../dist/verify/areas/push/on_device/android_opened');
  const none = {
    tracked: false, emptyId: false, failed: false,
    linkAttempted: false, linkHandled: false, linkUnhandled: false, linkFellBack: false,
  };
  assert.strictEqual(androidClicked(none), false);
  assert.strictEqual(androidClicked({ ...none, linkFellBack: true }), true);
});

test('the spinner comes back when the Android tap prompt throws', async () => {
  const { tapAndroidPush } = require('../../dist/verify/areas/push/on_device/android_opened');
  let resumed = 0;
  const reporter = { pause() {}, resume() { resumed += 1; } };
  const capture = { available: false, unavailableReason: 'test', mark: () => 0, since: () => [], lines: [] };
  await assert.rejects(
    tapAndroidPush(
      'background',
      { title: 'cio verify · background', mark: 0, arrivalSeen: true },
      {
        serial: 'NO-SUCH-SERIAL',
        tap: { states: ['background'], asker: { askTap: async () => { throw new Error('stdin closed'); } } },
        reporter,
      },
      capture
    ),
    /stdin closed/
  );
  assert.strictEqual(resumed, 1);
});
