const test = require('node:test');
const assert = require('node:assert');

const {
  expectedDeliveryId,
} = require('../../dist/verify/areas/push/on_device');

test('the stored copy says which delivery arrived', () => {
  assert.strictEqual(
    expectedDeliveryId('first', { title: 'a', deliveryId: 'stored' }),
    'stored'
  );
});

test('after a re-send the retry is expected when its title is the one that arrived', () => {
  const retried = { title: 'retry', deliveryId: 'second' };
  assert.strictEqual(
    expectedDeliveryId('first', { title: 'retry' }, retried),
    'second'
  );
  // The first push turned up late: its own id is the one to find.
  assert.strictEqual(
    expectedDeliveryId('first', { title: 'original' }, retried),
    'first'
  );
});

test('with nothing stored the send decides', () => {
  assert.strictEqual(expectedDeliveryId('first', false), 'first');
  assert.strictEqual(expectedDeliveryId(undefined, undefined), undefined);
});
