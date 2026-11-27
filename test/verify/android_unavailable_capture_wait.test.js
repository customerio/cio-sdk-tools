const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * `adb` and `cio` are played by scripts on PATH. The logcat never attaches, so the cell can
 * only be judged a skip, and waiting out its timeout for lines that cannot arrive is time
 * the person spends for nothing.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-adb-wait-'));
fs.writeFileSync(
  path.join(dir, 'adb'),
  `#!/bin/sh
case "$*" in
  *logcat*) echo 'error: device offline' >&2; exit 1 ;;
  *"shell date"*) printf '11-24_10:00:00.000\\n'; exit 0 ;;
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
  `#!/bin/sh\nprintf '{"delivery_id":"dgS_test"}'\nexit 0\n`,
  { mode: 0o755 }
);
process.env.PATH = `${dir}:${process.env.PATH}`;

const { runAndroidDeliveredMatrix } = require('../../dist/verify/areas/push/on_device/android');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a cell with no log capture does not wait out its timeout for lines that cannot arrive', async () => {
  const matrices = await runAndroidDeliveredMatrix({
    serial: 'SER',
    packageName: 'com.example.app',
    environmentId: '1',
    token: 'tok',
    states: ['foreground'],
    cellTimeoutMs: 30_000,
  });
  const [cell] = matrices.delivered.cells;
  assert.strictEqual(cell.verdict, 'skip');
  // Staging the app takes about 8s on its own; the 30s timeout is the part that must go.
  assert.ok(cell.durationMs < 15_000, `the cell took ${cell.durationMs}ms`);
});
