const test = require('node:test');
const assert = require('node:assert');

const { explainUnseenTap } = require('../../dist/verify/areas/push/on_device/opened');

const unseen = () => ({
  state: 'killed',
  verdict: 'fail',
  cause: 'runtime.tap_not_seen',
  evidence: [],
});

test('on a phone, a stream that went quiet after the tap is blamed rather than the tap', () => {
  const cell = explainUnseenTap(unseen(), {
    linesAfterTap: 0,
    lastLineAt: '10:00:00',
    phone: true,
  });
  assert.strictEqual(cell.cause, 'runtime.capture_silent');
});

test('on a simulator, a quiet filtered stream says nothing about the stream, so the tap stays unseen', () => {
  const cell = explainUnseenTap(unseen(), {
    linesAfterTap: 0,
    lastLineAt: '10:00:00',
    phone: false,
  });
  assert.strictEqual(cell.cause, 'runtime.tap_not_seen');
});
