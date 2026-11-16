const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * What iOS says about an app's notifications is read from the simulator's settings with
 * `plutil`, which only exists on a Mac. These tests play it with a script on PATH that
 * answers from the environment, so they run anywhere and each test picks what the
 * simulator holds.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-plutil-'));
const archive = `<?xml version="1.0"?><plist version="1.0"><dict><key>$objects</key><array><string>$null</string><dict><key>authorizationStatus</key><integer>2</integer></dict></array></dict></plist>`;
fs.writeFileSync(
  path.join(dir, 'plutil'),
  `#!/bin/sh
case "$*" in
  *section.plist*) printf '%s' '${archive}'; exit 0 ;;
esac
case "$FAKE_SETTINGS" in
  unreadable) exit 1 ;;
  no_sections) printf '%s' '<?xml version="1.0"?><plist version="1.0"><dict><key>other</key><string>x</string></dict></plist>' ;;
  entry) printf '%s' '<?xml version="1.0"?><plist version="1.0"><dict><key>sectionInfo</key><dict><key>com.example.app</key><data>YWJj</data></dict></dict></plist>' ;;
  *) printf '%s' '<?xml version="1.0"?><plist version="1.0"><dict><key>sectionInfo</key><dict><key>com.example.other</key><data>YWJj</data></dict></dict></plist>' ;;
esac
`,
  { mode: 0o755 }
);
process.env.PATH = `${dir}:${process.env.PATH}`;

const {
  simulatorNotificationStatus,
} = require('../../dist/verify/platform/ios/notification_settings');
const {
  judgeNotificationPermission,
} = require('../../dist/verify/areas/push/registration/profile_linked');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('an app with no entry in the settings has never asked for permission', async () => {
  process.env.FAKE_SETTINGS = 'other_apps_only';
  assert.strictEqual(
    await simulatorNotificationStatus('UDID', 'com.example.app'),
    'notDetermined'
  );
});

test('an app with an entry gets the status in it', async () => {
  process.env.FAKE_SETTINGS = 'entry';
  assert.strictEqual(
    await simulatorNotificationStatus('UDID', 'com.example.app'),
    'authorized'
  );
});

test('settings that cannot be read claim nothing', async () => {
  process.env.FAKE_SETTINGS = 'unreadable';
  assert.strictEqual(
    await simulatorNotificationStatus('UDID', 'com.example.app'),
    undefined
  );
  process.env.FAKE_SETTINGS = 'no_sections';
  assert.strictEqual(
    await simulatorNotificationStatus('UDID', 'com.example.app'),
    undefined
  );
});

test('a never-asked app is warned about, in words that hold with or without a settings entry', () => {
  const rungs = [{ id: 'device_ready', checks: [] }];
  judgeNotificationPermission(
    { rungs },
    {
      status: 'notDetermined',
      at: '10:00:00',
      source: 'simulator settings',
      allowed: false,
    }
  );
  const [check] = rungs[0].checks;
  assert.strictEqual(check.cause, 'device.notifications_not_allowed');
  assert.match(
    check.evidence[0],
    /iOS says notDetermined.*the app has not asked for permission/
  );
  // Wording that holds with or without a settings entry.
  assert.doesNotMatch(check.evidence[0], /no entry/);
});
