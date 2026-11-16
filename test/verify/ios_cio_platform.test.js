const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * `xcrun` and `cio` are played by scripts on PATH that answer from the environment, so each
 * test picks what the tool says and the suite runs without a Mac or a login.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-tools-'));
fs.writeFileSync(
  path.join(dir, 'xcrun'),
  `#!/bin/sh
case "$FAKE_TERMINATE" in
  ok) exit 0 ;;
  nothing) echo 'The request to terminate "x" failed. found nothing to terminate' >&2; exit 3 ;;
  *) printf 'An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\\nUnable to lookup in current state: Shutdown\\n' >&2; exit 405 ;;
esac
`,
  { mode: 0o755 }
);
fs.writeFileSync(
  path.join(dir, 'cio'),
  `#!/bin/sh
if [ "$FAKE_CIO" = error ]; then
  echo '{"error":"auth","message":"API error 401: {\\"errors\\":[{\\"detail\\":\\"not allowed\\"}]}"}'
  exit 1
fi
echo '{"customers":[]}'
`,
  { mode: 0o755 }
);
process.env.PATH = `${dir}:${process.env.PATH}`;

const { setAppState } = require('../../dist/verify/platform/ios/app_state');
const { listsBundle } = require('../../dist/verify/platform/ios/device');
const { selectCredentials } = require('../../dist/verify/platform/cio/cli');
const { findProfile } = require('../../dist/verify/platform/cio/profile');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const simulator = { kind: 'simulator', udid: 'UDID' };

test('an app that is not running counts as killed', async () => {
  process.env.FAKE_TERMINATE = 'ok';
  assert.strictEqual((await setAppState(simulator, 'a.b', 'killed')).ok, true);
  process.env.FAKE_TERMINATE = 'nothing';
  const result = await setAppState(simulator, 'a.b', 'killed');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.error, undefined);
});

test('any other terminate failure leaves the app state unknown', async () => {
  process.env.FAKE_TERMINATE = 'shutdown';
  const result = await setAppState(simulator, 'a.b', 'killed');
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /Shutdown/);
});

test('a phone holds an app only when the bundle id matches exactly', () => {
  const listing = JSON.stringify({
    result: { apps: [{ bundleIdentifier: 'com.foo.application' }] },
  });
  assert.strictEqual(listsBundle(listing, 'com.foo.app'), false);
  assert.strictEqual(listsBundle(listing, 'com.foo.application'), true);
  // Not JSON: the quoted key still has to name the whole id.
  assert.strictEqual(
    listsBundle('"bundleIdentifier" : "com.foo.application"', 'com.foo.app'),
    false
  );
  assert.strictEqual(
    listsBundle('"bundleIdentifier" : "com.foo.app"', 'com.foo.app'),
    true
  );
});

test('an account id stored as a number is kept', () => {
  const stored = { profiles: { work: { account_id: 4242, region: 'us' } } };
  assert.deepStrictEqual(selectCredentials(stored, 'work'), {
    profile: 'work',
    account_id: '4242',
    region: 'us',
  });
  assert.strictEqual(
    selectCredentials({ profiles: { w: { account_id: 'a1' } } }, 'w')
      .account_id,
    'a1'
  );
});

test('a failed lookup is an error, and an empty answer is no profile', async () => {
  process.env.FAKE_CIO = 'error';
  await assert.rejects(
    findProfile('1', 'me@example.com'),
    /customer lookup failed.*not allowed/
  );
  process.env.FAKE_CIO = 'ok';
  assert.strictEqual(await findProfile('1', 'me@example.com'), null);
});
