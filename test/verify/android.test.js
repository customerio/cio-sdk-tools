const test = require('node:test');
const assert = require('node:assert');

const { judgeAndroid } = require('../../dist/verify/areas/push/on_device/android');
const { parseLogcat } = require('../../dist/verify/platform/android/logcat');
const { ANDROID_MARKERS, androidDeliveryIds } = require('../../dist/verify/areas/push/on_device/sdk_lines');
const { prefString, decodeXmlEntities } = require('../../dist/verify/platform/android/adb');
const {
  applicationIdFrom,
  sdkModulesFrom,
  resolveInitAtLaunch,
  PUSH_MODULE_NAMES,
} = require('../../dist/verify/platform/android/project');
const { androidDeviceReady } = require('../../dist/verify/areas/push/registration/android_device');
const { Ladder } = require('../../dist/verify/core/report/ladder');

const base = {
  available: true,
  sawLines: true,
  stopped: false,
  posted: true,
  received: true,
  loggedIds: ['abc12345'],
  freshIds: ['abc12345'],
};
const causes = (rung) => rung.checks.filter((c) => c.cause).map((c) => c.cause);
const emulator = { serial: 'emulator-5554', isEmulator: true, state: 'device', apiLevel: 35 };

test('a stopped app is a precondition, not a failed integration', () => {
  // `am force-stop` leaves an app undeliverable-to by design. Calling that a broken
  // integration is the misdiagnosis the whole check exists to prevent.
  assert.deepStrictEqual(
    judgeAndroid({ ...base, stopped: true, posted: false, received: false }),
    { verdict: 'skip', cause: 'runtime.app_force_stopped' }
  );
});

test('nothing received on a running app is a real failure', () => {
  assert.deepStrictEqual(
    judgeAndroid({ ...base, posted: false, received: false }),
    { verdict: 'fail', cause: 'runtime.push_never_arrived' }
  );
});

test('on the device and never received by the SDK is a real failure', () => {
  // FCM displays a notification message by itself while the app is in the background, so
  // the notification is there and the SDK never saw the push.
  assert.deepStrictEqual(judgeAndroid({ ...base, received: false }), {
    verdict: 'fail',
    cause: 'runtime.push_not_handled',
  });
});

test('received by the SDK is the pass, whether or not the list showed it', () => {
  assert.deepStrictEqual(judgeAndroid(base), { verdict: 'pass' });
  // The SDK receiving it proves it reached the device; the list is the OS's second word.
  assert.deepStrictEqual(judgeAndroid({ ...base, posted: false }), {
    verdict: 'pass',
  });
});

test('the id from the line naming this push decides which delivery it is', () => {
  assert.deepStrictEqual(
    judgeAndroid({ ...base, expectedId: 'abc12345', freshIds: [] }),
    { verdict: 'pass' }
  );
  assert.deepStrictEqual(
    judgeAndroid({ ...base, expectedId: 'zzz99999' }),
    { verdict: 'warn', cause: 'runtime.delivery_id_mismatch' }
  );
});

test('a cell that counted an earlier cell’s delivery only warns', () => {
  assert.deepStrictEqual(judgeAndroid({ ...base, freshIds: [] }), {
    verdict: 'warn',
    cause: 'runtime.delivery_id_mismatch',
  });
});

test('silence from an attached logcat proves nothing', () => {
  assert.deepStrictEqual(judgeAndroid({ ...base, sawLines: false }), {
    verdict: 'skip',
    cause: 'runtime.no_evidence',
  });
});

test('logcat lines parse into tag and message, dividers excluded', () => {
  const line = parseLogcat(
    "09-17 03:41:50.906 D/[CIO](12345): [Push] Tracking push message delivered with deliveryId: dgS_abc123"
  );
  assert.strictEqual(line.process, '[CIO]');
  assert.match(line.at, /^09-17 03:41:50\.906$/);
  assert.ok(ANDROID_MARKERS.tracked.test(line.message));
  assert.deepStrictEqual(androidDeliveryIds([line]), ['dgS_abc123']);
  assert.strictEqual(parseLogcat('--------- beginning of main'), undefined);
});

test('the markers are the SDK’s own sentences, not loose words', () => {
  assert.ok(!ANDROID_MARKERS.received.test('Received something unrelated'));
  assert.ok(ANDROID_MARKERS.received.test('Received new message with deliveryId: x'));
  assert.ok(ANDROID_MARKERS.duplicate.test('Received duplicate message with deliveryId: x'));
});

test('shared preferences are XML with escaped values', () => {
  const xml = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="segment.userId">someone@example.com</string>
    <string name="segment.settings">{&quot;integrations&quot;:{&quot;Customer.io In-App Plugin&quot;:{&quot;siteId&quot;:&quot;abc123&quot;}}}</string>
</map>`;
  assert.strictEqual(prefString(xml, 'segment.userId'), 'someone@example.com');
  const settings = JSON.parse(prefString(xml, 'segment.settings'));
  assert.strictEqual(
    settings.integrations['Customer.io In-App Plugin'].siteId,
    'abc123'
  );
  assert.strictEqual(decodeXmlEntities('a &amp;quot; b'), 'a &quot; b');
});

test('both dependency spellings count, and a plugin id does not', () => {
  const published = 'implementation "io.customer.android:messaging-push-fcm:$cioSDKVersion"';
  const composite = 'implementation(project(":messagingpush"))';
  const pluginOnly = "id 'io.customer.android.publish-root'";
  const ownModule = 'implementation(project(":my-feature"))';

  assert.deepStrictEqual(sdkModulesFrom(published), ['messaging-push-fcm']);
  assert.deepStrictEqual(sdkModulesFrom(composite), ['messagingpush']);
  assert.deepStrictEqual(sdkModulesFrom(pluginOnly), []);
  assert.deepStrictEqual(sdkModulesFrom(ownModule), []);
  assert.ok(PUSH_MODULE_NAMES.includes('messaging-push-fcm'));
});

test('applicationId wins over namespace, and namespace is the fallback', () => {
  assert.strictEqual(
    applicationIdFrom('namespace "io.example.lib"\napplicationId "io.example.app"'),
    'io.example.app'
  );
  assert.strictEqual(applicationIdFrom('namespace = "io.example.lib"'), 'io.example.lib');
});

test('initialization behind a helper called from Application still counts', () => {
  // The SDK's own sample app is written this way; judging the enclosing class alone
  // reports it as broken.
  const model = {
    applicationClass: '.SampleApplication',
    initSites: [{ file: 'sdk/Repo.java', line: 10, scope: 'class Repo' }],
    sources: [
      { path: 'SampleApplication.java', absolutePath: '/SampleApplication.java', text: 'class SampleApplication extends Application { void onCreate() { new Repo().setup(); } }' },
      { path: 'sdk/Repo.java', absolutePath: '/sdk/Repo.java', text: 'class Repo { void setup() { CustomerIOBuilder(); } }' },
    ],
  };
  assert.strictEqual(resolveInitAtLaunch(model).verdict, true);
});

test('initialization only in an Activity is a real failure on Android', () => {
  // A push starts the process, not an Activity, so this loses every delivery that
  // arrives while the app is closed.
  const model = {
    applicationClass: '.App',
    initSites: [
      { file: 'MainActivity.kt', line: 20, scope: 'class MainActivity : AppCompatActivity()' },
    ],
    sources: [
      { path: 'App.kt', absolutePath: '/App.kt', text: 'class App : Application() { }' },
      { path: 'MainActivity.kt', absolutePath: '/MainActivity.kt', text: 'class MainActivity : AppCompatActivity() { CustomerIOBuilder() }' },
    ],
  };
  const resolution = resolveInitAtLaunch(model);
  assert.strictEqual(resolution.verdict, false);
  assert.match(resolution.evidence.join(' '), /Activity/);
});

test('a target that cannot resolve DNS fails before anything is sent', () => {
  // The emulator answers pings in this state and receives nothing, so every cell would
  // otherwise report the integration as broken.
  const rung = androidDeviceReady(
    {
      target: emulator,
      usable: [emulator],
      installed: true,
      network: { ip: true, dns: false },
      permissionGranted: true,
      sdk: { deviceToken: 'x'.repeat(142), userId: 'a@b.c', sources: [] },
    },
    'io.example.app'
  );
  assert.strictEqual(Ladder.verdictOf(rung), 'fail');
  assert.deepStrictEqual(causes(rung), ['device.dns_unresolved']);
  // Nothing downstream is claimed once the network is out.
  assert.strictEqual(rung.checks.find((c) => c.id === 'token_registered'), undefined);
});

test('a missing token and a denied permission are separate failures', () => {
  const denied = androidDeviceReady(
    {
      target: emulator,
      usable: [emulator],
      installed: true,
      network: { ip: true, dns: true },
      permissionGranted: false,
      sdk: { deviceToken: 'x'.repeat(142), userId: 'a@b.c', sources: [] },
    },
    'io.example.app'
  );
  assert.deepStrictEqual(causes(denied), ['device.notification_permission_denied']);
  // The fix is this device's and this app's command, not a template to fill in.
  assert.strictEqual(
    denied.checks.find((c) => c.id === 'notification_permission').detail,
    'grant it: adb -s emulator-5554 shell pm grant io.example.app android.permission.POST_NOTIFICATIONS'
  );

  const noToken = androidDeviceReady(
    {
      target: emulator,
      usable: [emulator],
      installed: true,
      network: { ip: true, dns: true },
      permissionGranted: true,
      sdk: { sources: ['io.customer.sdk.io.example.app.xml'] },
    },
    'io.example.app'
  );
  assert.ok(causes(noToken).includes('device.token_unregistered'));
});

test('a physical Android device is a valid target, and so is an emulator', () => {
  const { selectAndroidTarget } = require('../../dist/verify/platform/android/device');
  const phone = {
    serial: 'RFCXB0LZRLD',
    model: 'SM-S921B',
    isEmulator: false,
    state: 'device',
  };
  const emulator = {
    serial: 'emulator-5554',
    isEmulator: true,
    state: 'device',
  };
  const offline = { serial: 'R58M1234', isEmulator: false, state: 'offline' };

  // Both are offered; the target prompt is what stops a run picking whichever phone
  // happens to be plugged in, and a phone is where Doze and OEM process-killing live.
  const both = selectAndroidTarget([phone, emulator, offline]);
  assert.deepStrictEqual(
    both.usable.map((t) => t.serial),
    ['RFCXB0LZRLD', 'emulator-5554']
  );
  assert.strictEqual(both.target, undefined, 'it chose one of two without being asked');
  assert.strictEqual(
    selectAndroidTarget([phone, emulator], 'RFCXB0LZRLD').target?.serial,
    'RFCXB0LZRLD'
  );
  // An unreachable device is never a target.
  assert.deepStrictEqual(selectAndroidTarget([offline]).usable, []);
});

test('nothing connected says exactly that', () => {
  const rung = androidDeviceReady({ usable: [], installed: false }, 'io.example.app');
  assert.strictEqual(Ladder.verdictOf(rung), 'skip');
  assert.match(rung.skipped, /no connected device and no running emulator/);
});

test('the handoff worker is evidence, never the verdict', () => {
  // Observed on API 35: tracked lands in ~30ms, the notification ~6s later, the worker up
  // to ~40s after that. What it reports is Customer.io's to confirm.
  assert.deepStrictEqual(judgeAndroid({ ...base, reported: true }), {
    verdict: 'pass',
  });
  assert.deepStrictEqual(judgeAndroid({ ...base, reported: false }), {
    verdict: 'pass',
  });
});

test('the handoff markers match the SDK’s two success phrasings', () => {
  const success = '[CIO-Push-Handoff] worker success, removed key=dgS_abc==';
  const already = '[CIO-Push-Handoff] worker skipped, already delivered key=dgS_abc==';
  const queued = '[CIO-Push-Handoff] enqueued WM key=dgS_abc==';
  assert.ok(ANDROID_MARKERS.handoffDelivered.test(success));
  assert.ok(ANDROID_MARKERS.handoffAlreadyDelivered.test(already));
  assert.ok(ANDROID_MARKERS.handoffQueued.test(queued));
  // "already delivered" must not read as the plain success line, and vice versa.
  assert.ok(!ANDROID_MARKERS.handoffDelivered.test(already));
  assert.ok(!ANDROID_MARKERS.handoffAlreadyDelivered.test(success));
});

test('a mark survives the retention window dropping lines', () => {
  const { parseLogcat } = require('../../dist/verify/platform/android/logcat');
  // The bug this pins: a cell saved `lines.length`, the window later dropped the oldest
  // 10,000 lines, and every saved index silently pointed somewhere else. On an S24 that
  // made a cell read the wrong slice and report a tap it had actually recorded.
  const lines = [];
  let dropped = 0;
  const capture = {
    lines,
    mark: () => dropped + lines.length,
    since: (mark) => lines.slice(Math.max(0, mark - dropped)),
  };
  const push = (message) => {
    lines.push({ at: '00:00', process: '[CIO]', message });
    if (lines.length > 5) {
      lines.splice(0, 3);
      dropped += 3;
    }
  };

  push('before the cell');
  const mark = capture.mark();
  for (let i = 0; i < 8; i += 1) push(`in the cell ${i}`);

  const seen = capture.since(mark).map((line) => line.message);
  assert.ok(!seen.includes('before the cell'), 'it read earlier lines');
  assert.ok(seen.includes('in the cell 7'), 'it lost the newest line');
  // The window has dropped twice by now, so a raw `slice(mark)` would be wrong.
  assert.ok(dropped > 0, 'the window never rolled, so this proves nothing');
  assert.notDeepStrictEqual(seen, lines.slice(mark).map((l) => l.message));

  // The parser still keys the tag the in-memory filter relies on. Note the input is
  // logcat's own `-v time` shape, not the evidence file's — the file is re-rendered as
  // "<at> <tag>: <message>", which is what made this assertion wrong the first time.
  const parsed = parseLogcat(
    '09-18 22:45:46.368 D/[CIO]( 1234): [Push] Tracking push message opened'
  );
  assert.strictEqual(parsed.process, '[CIO]');
  assert.ok(parsed.process.includes('CIO'));
});
