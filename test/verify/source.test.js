const test = require('node:test');
const assert = require('node:assert');

const {
  analyzeSources,
  enclosingScope,
  forwardsToSdk,
  resolveRunsAtLaunch,
} = require('../../dist/verify/ios/source');

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

const { simctlError } = require('../../dist/verify/ios/device');

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
