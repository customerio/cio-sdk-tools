const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * A logcat that dies partway through a cell. `adb` and `cio` are scripts on PATH: the push is
 * listed by the OS, the log holds one SDK line from inside the cell and then the stream
 * exits, so the SDK's receipt line can never be read.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-adb-died-'));
const titles = path.join(dir, 'titles.log');
fs.writeFileSync(
  path.join(dir, 'adb'),
  `#!/bin/sh
case "$*" in
  *logcat*)
    sleep 13
    printf '11-24 10:00:13.000 I/CIO-SDK( 100): [Push] settings loaded\\n'
    exit 3 ;;
  *"shell date"*) printf '11-24_10:00:00.000\\n'; exit 0 ;;
  *"dumpsys notification"*)
    [ -f "${titles}" ] && printf '      android.title=String (%s)\\n' "$(head -1 "${titles}")"
    exit 0 ;;
  *pidof*) exit 1 ;;
  *resolve-activity*) printf 'com.example.app/.Main\\n'; exit 0 ;;
  *"am start"*) echo "Starting: Intent { cmp=com.example.app/.Main }"; exit 0 ;;
esac
exit 0
`,
  { mode: 0o755 }
);
fs.writeFileSync(
  path.join(dir, 'cio'),
  `#!/bin/sh
echo "$*" | sed -n 's/.*"title":"\\([^"]*\\)".*/\\1/p' >> "${titles}"
printf '{"delivery_id":"dgS_test"}'
exit 0
`,
  { mode: 0o755 }
);
process.env.PATH = `${dir}:${process.env.PATH}`;

const { runAndroidDeliveredMatrix } = require('../../dist/verify/areas/push/on_device/android');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a cell whose logcat died is the capture stopping, not the SDK failing to handle the push', async () => {
  const matrices = await runAndroidDeliveredMatrix({
    serial: 'SER',
    packageName: 'com.example.app',
    environmentId: '1',
    token: 'tok',
    states: ['foreground'],
    cellTimeoutMs: 6_000,
    sdkVersion: '4.10.0',
  });
  const [cell] = matrices.delivered.cells;
  assert.strictEqual(cell.cause, 'runtime.capture_stopped', `was ${cell.cause}: ${cell.evidence.join(' | ')}`);
  assert.strictEqual(cell.verdict, 'skip');
});
