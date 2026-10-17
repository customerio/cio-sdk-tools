const test = require('node:test');
const assert = require('node:assert');

const {
  analyzeSources,
  enclosingScope,
  extensionKey,
  forwardsToSdk,
  resolveRunsAtLaunch,
} = require('../../dist/verify/platform/ios/source');

const file = (p, text) => ({ path: p, absolutePath: `/${p}`, text });

test('initialize inside a launch method resolves directly', () => {
  const text = `
class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ app: UIApplication, didFinishLaunchingWithOptions o: [AnyHashable: Any]?) -> Bool {
        CustomerIO.initialize(withConfig: config)
        return true
    }
}`;
  const { initSites } = analyzeSources([file('AppDelegate.swift', text)]);
  assert.strictEqual(initSites.length, 1);
  assert.strictEqual(initSites[0].runsAtLaunch, true);
});

test('initialize behind a helper called from launch still resolves — the common shape', () => {
  const text = `
class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ app: UIApplication, didFinishLaunchingWithOptions o: [AnyHashable: Any]?) -> Bool {
        setUpCustomerIO()
        return true
    }

    func setUpCustomerIO() {
        CustomerIO.initialize(withConfig: config)
    }
}`;
  const { initSites } = analyzeSources([file('AppDelegate.swift', text)]);
  assert.strictEqual(initSites[0].runsAtLaunch, true);
});

test('a helper called from another file resolves too', () => {
  const app = `
class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ app: UIApplication, didFinishLaunchingWithOptions o: [AnyHashable: Any]?) -> Bool {
        Bootstrap.start()
        return true
    }
}`;
  const boot = `
enum Bootstrap {
    static func start() {
        CustomerIO.initialize(withConfig: config)
    }
}`;
  const { initSites } = analyzeSources([
    file('AppDelegate.swift', app),
    file('Bootstrap.swift', boot),
  ]);
  assert.strictEqual(initSites[0].runsAtLaunch, true);
});

test('initialize in a SwiftUI body is the one positively wrong answer', () => {
  const text = `
struct RootView: View {
    var body: some View {
        Text("hi").onAppear {
            CustomerIO.initialize(withConfig: config)
        }
    }
}`;
  const { initSites } = analyzeSources([file('RootView.swift', text)]);
  assert.strictEqual(initSites[0].runsAtLaunch, false);
});

test('an unreachable helper is unknown, not a failure', () => {
  const text = `
enum Setup {
    static func configureAnalytics() {
        CustomerIO.initialize(withConfig: config)
    }
}`;
  const { initSites } = analyzeSources([file('Setup.swift', text)]);
  assert.strictEqual(initSites[0].runsAtLaunch, 'unknown');
});

test('a declaration is not a call site', () => {
  // `setUp()` is only ever declared here; nothing calls it, so nothing is proven.
  assert.strictEqual(
    resolveRunsAtLaunch('func setUp()', [
      'func setUp() {\n  CustomerIO.initialize(\n}',
    ]),
    'unknown'
  );
});

test('enclosingScope picks the nearest declaration, not the first in the file', () => {
  const text = `
func application(_ a: UIApplication) -> Bool {
}

func later() {
  CustomerIO.initialize(
`;
  assert.match(enclosingScope(text), /func later/);
});

test('forwarding is found for both SDK entry points and a stored instance', () => {
  const sharedApn =
    'import CioMessagingPushAPN\nMessagingPushAPN.shared.didReceive(request, withContentHandler: handler)';
  const shared =
    'import CioMessagingPush\nMessagingPush.shared.didReceive(request, withContentHandler: handler)';
  const stored =
    'import CioMessagingPush\nmessagingPush.didReceive(request, withContentHandler: handler)';
  for (const text of [shared, sharedApn, stored]) {
    assert.strictEqual(
      forwardsToSdk([file('NotificationService.swift', text)]).forwards,
      true
    );
  }
});

test('an override that answers the content handler itself does not count as forwarding', () => {
  const text = `
import CioMessagingPushAPN
class NotificationService: UNNotificationServiceExtension {
    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        contentHandler(request.content)
    }
}`;
  const result = forwardsToSdk([file('NotificationService.swift', text)]);
  assert.strictEqual(result.forwards, false);
  assert.strictEqual(result.declaresEntryPoint, true);
});

test('app group ids and log level are read out of the code', () => {
  const text = `
MessagingPushAPN.initializeForExtension(
    withConfig: MessagingPushConfigBuilder(cdpApiKey: key)
        .logLevel(.debug)
        .appGroupId("group.io.customer.sample")
        .build()
)`;
  const signals = analyzeSources([file('NotificationService.swift', text)]);
  assert.deepStrictEqual(signals.appGroupIds, ['group.io.customer.sample']);
  assert.strictEqual(signals.logLevel, 'debug');
});

const { simctlError } = require('../../dist/verify/platform/ios/device');

test("a missing app container is said plainly, not as simctl's header line", () => {
  const notInstalled =
    'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=2):\nThe operation couldn’t be completed. No such file or directory\nNo such file or directory\n';
  assert.strictEqual(
    simctlError(notInstalled),
    'simctl has no app with this bundle id on this simulator'
  );
  assert.strictEqual(
    simctlError(
      'An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\nUnable to lookup in current state: Shutdown\n'
    ),
    'Unable to lookup in current state: Shutdown'
  );
  assert.strictEqual(simctlError(''), undefined);
});

const {
  deviceReachability,
  describeTarget,
  isUsable,
} = require('../../dist/verify/platform/ios/device');

test('a paired phone on a cable is usable even while its tunnel idles', () => {
  // devicectl, 2026-10-13: an iPhone 15 plugged in by cable, between commands.
  const cabled = deviceReachability({
    pairingState: 'paired',
    transportType: 'wired',
    tunnelState: 'disconnected',
  });
  assert.deepStrictEqual(cabled, { state: 'available', transport: 'usb' });
  assert.strictEqual(
    isUsable({ kind: 'device', name: 'x', udid: 'u', ...cabled }),
    true
  );
  assert.strictEqual(
    describeTarget({
      kind: 'device',
      name: 'iPhone',
      udid: 'u',
      osVersion: '18.0.1',
      ...cabled,
    }),
    'iPhone (device iOS 18.0.1, USB)'
  );

  assert.deepStrictEqual(
    deviceReachability({
      pairingState: 'paired',
      transportType: 'localNetwork',
      tunnelState: 'disconnected',
    }),
    { state: 'available', transport: 'wifi' }
  );
  assert.deepStrictEqual(
    deviceReachability({
      pairingState: 'paired',
      transportType: 'wired',
      tunnelState: 'connected',
    }),
    { state: 'connected', transport: 'usb' }
  );
});

test('a paired phone that is not reachable stays out of the list', () => {
  // devicectl, the same day: a second iPhone, paired months ago and nowhere near.
  const away = deviceReachability({
    pairingState: 'paired',
    tunnelState: 'unavailable',
  });
  assert.strictEqual(away.state, 'unavailable');
  assert.strictEqual(
    isUsable({ kind: 'device', name: 'x', udid: 'u', ...away }),
    false
  );
  assert.strictEqual(deviceReachability(undefined).state, 'unavailable');
});

test("the extension's key is read through the Env constant it names, comments ignored", () => {
  const nse = file(
    'NotificationServiceExtension/NotificationService.swift',
    'MessagingPushAPN.initializeForExtension(\n  withConfig: MessagingPushConfigBuilder(cdpApiKey: Env.CDP_API_KEY)\n)'
  );
  const env = file(
    'NotificationServiceExtension/Env.swift',
    'struct Env {\n  static let CDP_API_KEY = "abc123"\n}\n/*\nstruct Env {\n  static let CDP_API_KEY = "<API_KEY>"\n}\n*/\n// static let CDP_API_KEY = "old"'
  );
  assert.deepStrictEqual(extensionKey([nse], [nse, env]), {
    value: 'abc123',
    site: 'NotificationServiceExtension/Env.swift:2',
  });
});

test("a literal key at the call is read, and a name with two values is left unread", () => {
  const literal = file('NSE/NotificationService.swift', 'MessagingPushConfigBuilder(cdpApiKey: "test-cdp-api-key")');
  assert.strictEqual(extensionKey([literal], [literal]).value, 'test-cdp-api-key');

  const named = file('NSE/NotificationService.swift', 'MessagingPushConfigBuilder(cdpApiKey: Env.key)');
  const perBuild = file('NSE/Env.swift', '#if USE_FCM\nstatic let key = "one"\n#else\nstatic let key = "two"\n#endif');
  assert.strictEqual(extensionKey([named], [named, perBuild]), undefined);
  // Computed at runtime: nothing to read.
  const computed = file('NSE/NotificationService.swift', 'MessagingPushConfigBuilder(cdpApiKey: settings.key)');
  assert.strictEqual(extensionKey([computed], [computed]), undefined);
});

test('the newest SDK store is read, and its name is the key the SDK runs with', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { readSdkState } = require('../../dist/verify/platform/ios/device');

  // An app that changed its key keeps a store for the old one.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cio-verify-'));
  const old = path.join(dir, 'com.segment.storage.localsmoke_key.plist');
  const current = path.join(dir, 'com.segment.storage.5f660a00000000000000.plist');
  fs.writeFileSync(old, '');
  fs.writeFileSync(current, '');
  fs.utimesSync(old, new Date('2026-07-01'), new Date('2026-07-01'));

  const state = await readSdkState(dir, 'io.customer.app');
  assert.strictEqual(state.cdpApiKey, '5f660a00000000000000');
  assert.deepStrictEqual(state.sources, ['com.segment.storage.5f660a00000000000000.plist']);
});
