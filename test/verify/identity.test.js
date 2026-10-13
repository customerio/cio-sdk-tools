const test = require('node:test');
const assert = require('node:assert');

const {
  pushTag,
  deliveredTitle,
  tapTitle,
  androidIdForTitle,
  androidOpenedIdentity,
} = require('../../dist/verify/matrix/identity');

test('every push gets its own tag, in an alphabet nobody misreads off a banner', () => {
  const tags = new Set(Array.from({ length: 200 }, () => pushTag()));
  assert.ok(tags.size > 190, 'tags repeat far too often');
  for (const tag of tags) assert.match(tag, /^[2-9A-HJKMNP-TV-Z]{5}$/);
});

test('the tap test title changes every run, so an old banner cannot pass for a new one', () => {
  // It used to be `cio verify · tap me · killed` on every run.
  assert.notStrictEqual(
    tapTitle('killed', pushTag(() => 0)),
    tapTitle('killed', pushTag(() => 0.99))
  );
  assert.strictEqual(
    tapTitle('background', 'AB2CD'),
    'cio verify · tap me · background · AB2CD'
  );
  assert.strictEqual(deliveredTitle('killed', 'AB2CD'), 'cio verify · killed · AB2CD');
});

// Real lines from an S24 capture, token replaced.
const received =
  '[Push] handleNotificationTrigger: true - Received notification for message: {CIO-Delivery-Token=<token>, body=Sent by cio-sdk-tools verify push., image=https://customer.io/docs/images/push-image-control.jpg, title=cio verify · killed · 7KQ2M, CIO-Delivery-ID=dgS_ugcABQAAAaEyhT0GCp-CCoec8TzQ6Q==}';
const shown =
  '[Push] Showing notification for message: {CIO-Delivery-Token=<token>, body=Sent by cio-sdk-tools verify push., image=https://customer.io/docs/images/push-image-control.jpg, title=cio verify · background · 9DG62, CIO-Delivery-ID=dgS_ugcABQAAAaEyhYL2dD9bknhs3yrwUg==}';

test('on Android the line that carries both gives the push its delivery id', () => {
  assert.strictEqual(
    androidIdForTitle([shown, received], 'cio verify · killed · 7KQ2M'),
    'dgS_ugcABQAAAaEyhT0GCp-CCoec8TzQ6Q=='
  );
  assert.strictEqual(
    androidIdForTitle([shown, received], 'cio verify · background · 9DG62'),
    'dgS_ugcABQAAAaEyhYL2dD9bknhs3yrwUg=='
  );
});

test('a title is matched whole, never as a prefix of another push', () => {
  assert.strictEqual(
    androidIdForTitle([received], 'cio verify · killed · 7KQ2'),
    undefined
  );
  assert.strictEqual(androidIdForTitle([received], 'cio verify · killed'), undefined);
});

test('the Android opened line names the tapped push by id and by title', () => {
  const opened =
    'Tracking push message opened with payload: CustomerIOParsedPushPayload(extras=Bundle[{title=cio verify · tap me · killed · 7KQ2M}], deepLink=java-sample://dashboard, cioDeliveryId=dgS_ugcABQAAAaEyhT0GCp-CCoec8TzQ6Q==, cioDeliveryToken=<token>, title=cio verify · tap me · killed · 7KQ2M, body=Tap this notification to verify the opened metric., activityId=null)';
  assert.deepStrictEqual(androidOpenedIdentity(opened), {
    deliveryId: 'dgS_ugcABQAAAaEyhT0GCp-CCoec8TzQ6Q==',
    title: 'cio verify · tap me · killed · 7KQ2M',
  });
  assert.deepStrictEqual(androidOpenedIdentity('Tracking push message opened'), {
    deliveryId: undefined,
    title: undefined,
  });
});
