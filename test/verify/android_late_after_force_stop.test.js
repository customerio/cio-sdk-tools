const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * A push that turns up after its cell stopped waiting, then is cleared by the next cell's
 * `am force-stop`, which cancels the app's notifications. `adb` and `cio` are scripts on
 * PATH: the first push is posted two and a half seconds after it is sent, and force-stop
 * clears it.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-adb-late-'));
const titles = path.join(dir, 'titles.log');
const posted = path.join(dir, 'posted.flag');
const cleared = path.join(dir, 'cleared.flag');
fs.writeFileSync(
  path.join(dir, 'adb'),
  `#!/bin/sh
case "$*" in
  *logcat*) exec sleep 60 ;;
  *"shell date"*) printf '11-24_10:00:00.000\\n'; exit 0 ;;
  *"am force-stop"*) [ -f "${posted}" ] && touch "${cleared}"; exit 0 ;;
  *"dumpsys notification"*)
    if [ -f "${posted}" ] && [ ! -f "${cleared}" ]; then
      printf '      android.title=String (%s)\\n' "$(head -1 "${titles}")"
    fi
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
( sleep 2.5; touch "${posted}" ) >/dev/null 2>&1 &
printf '{"delivery_id":"dgS_test"}'
exit 0
`,
  { mode: 0o755 }
);
process.env.PATH = `${dir}:${process.env.PATH}`;

const { runAndroidDeliveredMatrix } = require('../../dist/verify/areas/push/on_device/android');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a push the next cell clears is still found late, from a list read before that cell starts', async () => {
  const matrices = await runAndroidDeliveredMatrix({
    serial: 'SER',
    packageName: 'com.example.app',
    environmentId: '1',
    token: 'tok',
    states: ['foreground', 'background'],
    cellTimeoutMs: 1_200,
  });
  const [first] = matrices.delivered.cells;
  assert.strictEqual(first.cause, 'runtime.push_arrived_late', `was ${first.cause}`);
});
