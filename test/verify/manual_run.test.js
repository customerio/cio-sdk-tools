const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * What the manual run on an iPhone 15, an S24 and two simulators found on 2026-10-15, each
 * pinned to the run that found it.
 */

const {
  explainSdkSilence,
  simulatorPredicate,
} = require('../../dist/verify/areas/push/on_device/sdk_lines');
const {
  observeOpened,
  judgeOpened,
  linkOutcome,
  schemeOf,
} = require('../../dist/verify/areas/push/on_device/opened');
const { PUSH_VOICE } = require('../../dist/verify/areas/push/voice');
const {
  profileLinked,
  recheckPushEnabled,
} = require('../../dist/verify/areas/push/registration/profile_linked');
const {
  androidDeviceReady,
  stoppedBeforeRun,
} = require('../../dist/verify/areas/push/registration/android_device');
const { localStamp } = require('../../dist/verify/areas/push/options');
const { urlSchemes } = require('../../dist/verify/platform/ios/xcode');
const { scratchDirectory } = require('../../dist/verify/core/cleanup');
const { CAUSES } = require('../../dist/verify/areas/push/causes');

test('an SDK at log level error leaves a cold tap unproven, not "set up too late"', () => {
  const printed = [];
  const reporter = { cell: (label) => ({ done: () => printed.push(label) }) };
  const [cell] = explainSdkSilence(
    [{ state: 'killed', verdict: 'fail', cause: 'runtime.cold_tap_not_handled', evidence: [] }],
    { appSpoke: true, sdkSpoke: false, how: "the app's processes logged" },
    reporter
  );
  assert.strictEqual(cell.verdict, 'skip');
  assert.strictEqual(cell.cause, 'runtime.sdk_logging_off');
  // Printed again under its own state: "background, SDK quiet" ran past the column.
  assert.deepStrictEqual(printed, ['killed']);
  assert.strictEqual(cell.summary, 'unproven: the SDK logged nothing');
});

const report = (sections, causes = []) => ({
  sections: sections.map((section) => ({ kind: 'cells', ...section })),
  causes: causes.map((code) => ({ code })),
});
const passed = { verdict: 'pass', evidence: [] };

test('pushes the OS saw arrive, with an SDK that logged nothing, prove arrival and no more', () => {
  const quiet = PUSH_VOICE.conclusion(
    report([{ metric: 'delivered', sdkQuiet: true, cells: [passed] }])
  );
  assert.strictEqual(quiet[0], 'each push arrived on the device.');
  assert.match(quiet[1], /the SDK logged nothing, so only arrival was proven/);
  assert.doesNotMatch(quiet.join(' '), /the app handled it/);

  const loud = PUSH_VOICE.conclusion(report([{ metric: 'delivered', cells: [passed] }]));
  assert.match(loud[0], /each push arrived and the app handled it/);
});

test('notifications still off after the pushes caveat a green run; a tapped push was seen', () => {
  const hidden = PUSH_VOICE.conclusion(
    report([{ metric: 'delivered', cells: [passed] }], ['profile.push_disabled'])
  );
  assert.match(hidden.join(' '), /may have arrived without showing/);

  const tapped = PUSH_VOICE.conclusion(
    report(
      [
        { metric: 'delivered', cells: [passed] },
        { metric: 'opened', cells: [passed] },
      ],
      ['profile.push_disabled']
    )
  );
  assert.doesNotMatch(tapped.join(' '), /without showing/);
  assert.match(CAUSES['profile.push_disabled'].remedy, /Allow notifications for the app/);
});

const profile = (pushEnabled) => ({
  cioId: 'c1',
  identifiers: {},
  devices: [{ id: 'tok', pushEnabled }],
});

test('push_enabled that flips after the pushes is no finding, and says why', async () => {
  const check = {
    id: 'device_push_enabled',
    verdict: 'warn',
    label: 'Linked device reports push enabled',
    cause: 'profile.push_disabled',
    evidence: ['push_enabled: false'],
  };
  const ladder = { rungs: [{ id: 'profile_linked', checks: [check] }] };
  const input = { environmentId: '1', userId: 'a@b.c', token: 'tok' };

  const note = await recheckPushEnabled(ladder, input, async () => profile('true'));
  assert.strictEqual(check.verdict, 'pass');
  assert.strictEqual(check.cause, undefined);
  assert.match(note, /lags a new Allow/);

  const still = { ...check, verdict: 'warn', cause: 'profile.push_disabled', evidence: [] };
  const noted = await recheckPushEnabled(
    { rungs: [{ id: 'profile_linked', checks: [still] }] },
    input,
    async () => profile('false')
  );
  assert.strictEqual(noted, undefined);
  assert.strictEqual(still.verdict, 'warn');
  assert.match(still.evidence[0], /still false after the pushes/);
});

test('a login seconds old is waited for before the profile is called missing', async () => {
  const cio = { available: true, authenticated: true, accountId: '1' };
  let reads = 0;
  const waits = [];
  const rung = await profileLinked({
    cio,
    environmentId: '1',
    userId: 'fresh@example.com',
    token: 'tok',
    candidates: [],
    find: async () => (++reads < 3 ? null : profile('true')),
    settle: { maxMs: 1_000, pollMs: 10 },
    onWait: (text) => waits.push(text),
  });
  assert.ok(rung.checks.every((check) => check.verdict === 'pass'));
  assert.match(rung.checks[0].evidence.join(' '), /there after \d+s/);
  assert.match(waits[0], /waiting for fresh@example.com to reach Customer.io/);

  const missing = await profileLinked({
    cio,
    environmentId: '1',
    userId: 'nobody@example.com',
    token: 'tok',
    candidates: [],
    find: async () => null,
    settle: { maxMs: 40, pollMs: 10 },
  });
  assert.strictEqual(missing.checks[0].cause, 'profile.not_found');
  assert.match(missing.checks[0].evidence.join(' '), /read again for \d+s/);
});

// The iPhone's own lines for `cio-nowhere://x`, which nothing on the phone can open.
const HANDED_TO_IOS = [
  '[Push] Clicked notification for message: x',
  '[Push] Tracking push message opened with deliveryId: dgS_abc',
  '[Push] Handling push notification deep link with url: cio-nowhere://x',
  '[Push] Deep link handled by system',
  'Failed to open URL <private>: Error Domain=NSOSStatusErrorDomain Code=-10814 "(null)" UserInfo={_LSLine=279, _LSFunction=-[_LSDOpenClient openURL:fileHandle:options:completionHandler:]}',
];

test('iOS failing to open a link the SDK handed it fails the tap, whatever the SDK said', () => {
  const { observed } = observeOpened(HANDED_TO_IOS);
  assert.strictEqual(observed.linkOpenFailed, true);
  assert.deepStrictEqual(judgeOpened({ available: true, linkSent: true, ...observed }), {
    verdict: 'fail',
    cause: 'runtime.deep_link_not_handled',
  });

  // A failure before the SDK handed the link over is about something else.
  const earlier = [HANDED_TO_IOS[4], ...HANDED_TO_IOS.slice(0, 4)];
  assert.strictEqual(observeOpened(earlier).observed.linkOpenFailed, false);
});

test("a link on the app's own scheme that came back through iOS is unproven, not handled", () => {
  const lines = HANDED_TO_IOS.slice(0, 4);
  const { observed } = observeOpened(lines);
  assert.deepStrictEqual(
    judgeOpened({ available: true, linkSent: true, linkToOwnApp: true, ...observed }),
    { verdict: 'warn', cause: 'runtime.deep_link_back_to_app' }
  );
  // Another app's scheme that iOS opened is the system handling it.
  assert.deepStrictEqual(
    judgeOpened({ available: true, linkSent: true, linkToOwnApp: false, ...observed }),
    { verdict: 'pass' }
  );
  // The app's own callback claiming it is the proof.
  const claimed = observeOpened([
    ...lines.slice(0, 3),
    '[Push] Deep link handled by host app callback implementation',
  ]).observed;
  assert.deepStrictEqual(
    judgeOpened({ available: true, linkSent: true, linkToOwnApp: true, ...claimed }),
    { verdict: 'pass' }
  );
  assert.strictEqual(linkOutcome(observed), 'handed to iOS');
  assert.strictEqual(linkOutcome(claimed), 'handled by the app');
  assert.strictEqual(
    linkOutcome(observeOpened(HANDED_TO_IOS).observed),
    'handed to iOS, which could not open it'
  );
  assert.strictEqual(schemeOf('APN-UIKit://settings'), 'apn-uikit');
  assert.strictEqual(schemeOf(undefined), undefined);
  assert.ok(CAUSES['runtime.deep_link_back_to_app']);
  assert.doesNotMatch(CAUSES['runtime.deep_link_not_handled'].remedy, /fails exactly this way/);
});

test("the simulator's log includes the app's own open failures", () => {
  assert.match(
    simulatorPredicate('NotificationServiceExtension', 'APN UIKit'),
    /OR \(process == "APN UIKit" AND eventMessage BEGINSWITH "Failed to open URL"\)$/
  );
  assert.doesNotMatch(simulatorPredicate(), /Failed to open URL/);
});

test("the app's URL schemes come from its Info.plist, lowercased", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cio-verify-test-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleURLTypes</key><array><dict>
<key>CFBundleURLSchemes</key><array><string>APN-UIKit</string><string>$(PRODUCT_NAME)-x</string></array>
</dict></array></dict></plist>`
    );
    const target = { settings: { INFOPLIST_FILE: 'Info.plist', PRODUCT_NAME: 'Demo' } };
    assert.deepStrictEqual(
      await urlSchemes(path.join(dir, 'App.xcodeproj'), target),
      ['apn-uikit', 'demo-x']
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const emulator = { serial: 'emulator-5554', model: 'sdk_gphone64_arm64', kind: 'emulator' };
const neverOpened = {
  target: emulator,
  usable: [emulator],
  installed: true,
  stopped: true,
  network: { ip: true, dns: true },
  permissionGranted: false,
  sdk: {
    sources: [],
    error:
      'cat: /data/data/io.example.app/shared_prefs/io.customer.sdk.io.example.app.xml: No such file or directory',
  },
};

test('a never-opened Android app is told to open it, not that it was force-stopped', () => {
  const rung = androidDeviceReady(neverOpened, 'io.example.app');
  const ids = rung.checks.map((check) => check.cause).filter(Boolean);
  assert.ok(!ids.includes('runtime.app_force_stopped'));
  const token = rung.checks.find((check) => check.id === 'token_registered');
  assert.strictEqual(token.evidence[0].includes('cat:'), false);
  assert.match(token.evidence[0], /never been opened/);
  assert.match(CAUSES['device.token_unregistered'].remedy, /^Open the app/);
  assert.strictEqual(CAUSES['device.token_unregistered'].docs, undefined);
  assert.strictEqual(stoppedBeforeRun(neverOpened), undefined);
});

test('a force-stopped app that the run itself opens is a note, not a warning about the pushes', () => {
  const stopped = {
    ...neverOpened,
    permissionGranted: true,
    sdk: { deviceToken: 'x'.repeat(142), userId: 'a@b.c', sources: ['io.customer.sdk.io.example.app.xml'] },
  };
  const registration = androidDeviceReady(stopped, 'io.example.app');
  assert.ok(registration.checks.some((check) => check.cause === 'runtime.app_force_stopped'));

  const sending = androidDeviceReady(stopped, 'io.example.app', true);
  assert.ok(!sending.checks.some((check) => check.cause === 'runtime.app_force_stopped'));
  assert.match(stoppedBeforeRun(stopped), /opening it for the pushes cleared that/);
});

test('the evidence folder is named in local time', () => {
  const at = new Date(2026, 9, 15, 23, 15, 6);
  assert.strictEqual(localStamp(at), '2026-10-15T23:15:06');
});

test('a temp folder nobody removed is removed when the run ends', async () => {
  const scratch = await scratchDirectory();
  fs.writeFileSync(path.join(scratch.path, 'pulled'), 'app data');
  process.emit('exit', 0);
  assert.strictEqual(fs.existsSync(scratch.path), false);

  const removed = await scratchDirectory();
  await removed.remove();
  assert.strictEqual(fs.existsSync(removed.path), false);
});

const { SDK_DEBUG_LINE } = require('../../dist/verify/areas/push/on_device/sdk_lines');
const { markLateArrivals } = require('../../dist/verify/areas/push/on_device/send');
const { explainNotificationsOff } = require('../../dist/verify/areas/push/on_device');

test('an SDK whose in-app module logged is at debug level, though push said nothing', () => {
  // The iPhone 16 simulator, notifications never allowed: these were the run's only lines.
  const s1 = [
    "[InApp] SseService: → Server event - type: 'heartbeat'",
    '[InApp] SSE Manager: Heartbeat received (interval: 30.0s, timeout: 35.0s)',
  ];
  assert.ok(s1.some((line) => SDK_DEBUG_LINE.test(line)));
  // The iPhone at log level error still wrote these, so none of them counts.
  for (const line of ['[Location] x', '[Telemetry] x', '[TLSCBQ] x', '[FBSScene] x']) {
    assert.doesNotMatch(line, SDK_DEBUG_LINE);
  }
});

test('a push the store held during its cell is not late; notifications off explains it', async () => {
  const cell = {
    state: 'killed',
    title: 'cio verify EFTG7 · killed',
    verdict: 'skip',
    cause: 'runtime.no_evidence',
    arrived: true,
    evidence: ['arrived: "cio verify EFTG7 · killed" is in the notification store'],
  };
  const [same] = await markLateArrivals([cell], async () => true);
  assert.strictEqual(same.cause, 'runtime.no_evidence');

  const off = explainNotificationsOff({ metric: 'delivered', cells: [same] }, true);
  assert.strictEqual(off.cells[0].cause, 'device.notifications_disabled');

  // One that was not seen in its window still is.
  const [late] = await markLateArrivals([{ ...cell, arrived: undefined }], async () => true);
  assert.strictEqual(late.cause, 'runtime.push_arrived_late');
});
