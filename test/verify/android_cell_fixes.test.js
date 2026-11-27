const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** `adb` is played by a script that records each call and answers from the environment. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-adb-cell-'));
const log = path.join(dir, 'calls.log');
fs.writeFileSync(
  path.join(dir, 'adb'),
  `#!/bin/sh
echo "$@" >> "${log}"
case "$*" in
  *" pull "*)
    [ "$FAKE_PULL" = fail ] && exit 1
    printf '\\211PNG' > "$5"; exit 0 ;;
esac
exit 0
`,
  { mode: 0o755 }
);
process.env.PATH = `${dir}:${process.env.PATH}`;

const {
  sdkReceived,
} = require('../../dist/verify/areas/push/on_device/android');
const {
  screenshot,
} = require('../../dist/verify/areas/push/on_device/android_opened');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const worker =
  'Worker result SUCCESS for Work [ id=d371dd2c, tags={ io.customer.messagingpush.processor.PushDeliveryMetricsWorker,cio-requests,cio-push-delivery } ]';

test('a worker left over from the last cell is not receipt of a push that never arrived', () => {
  const title = 'cio verify Q3S95 · killed';
  assert.deepStrictEqual(sdkReceived([worker], title, false), {
    received: false,
    byWorker: false,
  });
  assert.deepStrictEqual(sdkReceived([worker], title, true), {
    received: true,
    byWorker: true,
  });
  // The SDK's line naming this push's title proves receipt by itself.
  assert.strictEqual(
    sdkReceived(
      [
        'Received notification for message: {title=cio verify Q3S95 · killed, CIO-Delivery-ID=dgS_abc12345}',
      ],
      title,
      false
    ).received,
    true
  );
});

test('the screenshot is pulled as a file, so no bytes pass through text', async () => {
  fs.writeFileSync(log, '');
  process.env.FAKE_PULL = 'ok';
  const evidence = fs.mkdtempSync(path.join(dir, 'evidence-'));
  const file = await screenshot('emulator-5554', evidence, 'killed');
  assert.strictEqual(file, path.join(evidence, 'opened-killed.png'));
  assert.deepStrictEqual([...fs.readFileSync(file)], [0x89, 0x50, 0x4e, 0x47]);
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.ok(
    !calls.some((call) => call.includes('exec-out')),
    'exec-out is not used'
  );
  assert.ok(
    calls.some((call) => call.includes('rm -f')),
    'the device copy is removed'
  );
});

test('a failed pull gives no screenshot', async () => {
  process.env.FAKE_PULL = 'fail';
  const evidence = fs.mkdtempSync(path.join(dir, 'evidence-'));
  assert.strictEqual(
    await screenshot('emulator-5554', evidence, 'killed'),
    undefined
  );
  assert.strictEqual(
    await screenshot('emulator-5554', undefined, 'killed'),
    undefined
  );
});

test('a receipt line that names no push counts only once the push arrived, and another push never counts', () => {
  const title = 'cio verify Q3S95 · killed';
  const untitled = 'Received new message with deliveryId: dgS_abc';
  // No push on the device: a stray line from the last cell or another app is not this push.
  assert.strictEqual(sdkReceived([untitled], title, false).received, false);
  assert.strictEqual(sdkReceived([untitled], title, true).received, true);
  // A tail that names a different push is never evidence for this one, and the same line
  // naming this push counts.
  const tailed = (named) =>
    `[Push] Received new message with deliveryId: dgS_abc || ev=push.received id=dgS_abc title=${encodeURIComponent(named)}`;
  assert.strictEqual(sdkReceived([tailed('cio verify OTHER · killed')], title, true).received, false);
  assert.strictEqual(sdkReceived([tailed(title)], title, true).received, true);
});
