const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Sending an app to the background on a simulator means opening another app over it. These
 * tests play `xcrun` with a script on PATH that decides whether that other app opens.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-xcrun-bg-'));
fs.writeFileSync(
  path.join(dir, 'xcrun'),
  `#!/bin/sh
case "$*" in
  *com.apple.Preferences*)
    if [ "$FAKE_FOIL" = fail ]; then
      echo 'The operation couldn’t be completed. (FBSOpenApplicationServiceErrorDomain error 1.)' >&2
      exit 1
    fi
    exit 0 ;;
esac
exit 0
`,
  { mode: 0o755 }
);
process.env.PATH = `${dir}:${process.env.PATH}`;

const { setAppState } = require('../../dist/verify/platform/ios/app_state');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const simulator = { kind: 'simulator', udid: 'UDID' };

test('a background setup is proven only when the other app opened over it', async () => {
  process.env.FAKE_FOIL = 'ok';
  const opened = await setAppState(simulator, 'a.b', 'background');
  assert.strictEqual(opened.ok, true);
});

test('a failed launch of the other app leaves the background setup unproven', async () => {
  process.env.FAKE_FOIL = 'fail';
  const result = await setAppState(simulator, 'a.b', 'background');
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /FBSOpenApplicationServiceErrorDomain|exit 1/);
});
