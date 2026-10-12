import { ReportedCause, Severity, Stage } from './types';

/**
 * The cause registry is the contract between this CLI and anything reading it — an LLM
 * plugin, a CI job, a human skimming a terminal. Codes are added, never repurposed: a
 * consumer that learned `wiring.nse_missing` must keep being right about it.
 *
 * Each entry answers the two questions a failure raises. What did the tool actually observe
 * (`summary`), and what does the developer do next (`remedy`).
 */
export interface CauseDefinition {
  stage: Stage;
  severity: Severity;
  summary: string;
  remedy: string;
  docs?: string;
}

const IOS_PUSH_DOCS = 'https://www.customer.io/docs/sdk/ios/push/';
const IOS_RICH_PUSH_DOCS =
  'https://www.customer.io/docs/sdk/ios/push/#rich-push';
const ANDROID_PUSH_DOCS = 'https://www.customer.io/docs/sdk/android/push/';
const IOS_GETTING_STARTED_DOCS =
  'https://www.customer.io/docs/sdk/ios/getting-started/';

export const CAUSES: Record<string, CauseDefinition> = {
  'wiring.sdk_absent': {
    stage: 'project_wiring',
    severity: 'blocker',
    summary: 'The Customer.io SDK is not a dependency of this project.',
    remedy:
      'Add the SDK before anything else. Every later finding would be a consequence of its absence rather than a cause.',
    docs: IOS_GETTING_STARTED_DOCS,
  },
  'wiring.init_absent': {
    stage: 'project_wiring',
    severity: 'blocker',
    summary: 'No call to CustomerIO.initialize was found in the app sources.',
    remedy:
      'Initialize the SDK from the app delegate launch method. Without it the SDK never registers for push and never reports a metric.',
    docs: IOS_GETTING_STARTED_DOCS,
  },
  'wiring.init_not_at_launch': {
    stage: 'project_wiring',
    severity: 'blocker',
    summary:
      'CustomerIO.initialize runs from a SwiftUI view body, which is re-evaluated on every redraw and carries no guarantee of running before the system delivers a launch push.',
    remedy:
      'Move initialization into the app delegate launch method, or into the App type initializer.',
    docs: IOS_GETTING_STARTED_DOCS,
  },
  'wiring.init_launch_unproven': {
    stage: 'project_wiring',
    severity: 'warning',
    summary:
      'CustomerIO.initialize was found, but no path from a launch method to it could be resolved.',
    remedy:
      'Nothing to fix if initialization runs at launch through a helper the tool could not follow. Worth a glance: initialization that runs later than launch loses pushes that arrive before it.',
  },
  'wiring.nse_missing': {
    stage: 'project_wiring',
    severity: 'blocker',
    summary: 'The project has no Notification Service Extension target.',
    remedy:
      'Add a Notification Service Extension and forward its requests to the SDK. Without it iOS shows the push, but nothing attaches rich content and nothing counts a delivery.',
    docs: IOS_RICH_PUSH_DOCS,
  },
  'wiring.nse_multiple': {
    stage: 'project_wiring',
    severity: 'blocker',
    summary:
      'More than one Notification Service Extension is embedded in the app.',
    remedy:
      'iOS runs exactly one service extension per notification, and which one is not something you control. Keep one and forward to the SDK from it.',
    docs: IOS_RICH_PUSH_DOCS,
  },
  'wiring.project_format_json': {
    stage: 'project_wiring',
    severity: 'warning',
    summary:
      'This project uses the JSON .xcproj format, so the checks that need the raw project graph could not run.',
    remedy:
      'Targets and build settings still come from xcodebuild, which reads either format. Embedding is not exposed that way, so it is proven from the installed build instead — or not at all, if nothing is installed yet.',
    docs: 'https://developer.apple.com/documentation/xcode/updating-your-xcode-project-configuration-file-format',
  },
  'wiring.nse_not_embedded': {
    stage: 'project_wiring',
    severity: 'blocker',
    summary:
      'A Notification Service Extension target exists but the app does not embed it.',
    remedy:
      'Add the extension to the app target as a dependency and to its Embed Foundation Extensions phase. An extension that ships outside the app bundle is never launched.',
    docs: IOS_RICH_PUSH_DOCS,
  },
  'wiring.nse_does_not_forward': {
    stage: 'project_wiring',
    severity: 'warning',
    summary:
      'The Notification Service Extension never hands the request to the SDK.',
    remedy:
      'Call MessagingPush.shared.didReceive(request, withContentHandler:) from didReceive. This is the invisible failure: the push still arrives and still displays, and no delivery is ever counted.',
    docs: IOS_RICH_PUSH_DOCS,
  },
  'wiring.app_group_mismatch': {
    stage: 'project_wiring',
    severity: 'blocker',
    summary:
      'The App Group in the extension code is not granted by the extension entitlements.',
    remedy:
      'The same App Group has to appear in three places: the app entitlements, the extension entitlements, and appGroupId() in code. Two out of three is the shape that survives code review and fails at runtime.',
    docs: IOS_RICH_PUSH_DOCS,
  },
  'wiring.app_group_absent': {
    stage: 'project_wiring',
    severity: 'warning',
    summary: 'No App Group is configured for the extension.',
    remedy:
      'Configure an App Group so the extension can hand metrics back to the app when it cannot report them itself. Delivery tracking works without it in the common case and loses events in the slow-network one.',
    docs: IOS_RICH_PUSH_DOCS,
  },
  'wiring.push_capability_missing': {
    stage: 'project_wiring',
    severity: 'blocker',
    summary: 'The app entitlements do not declare aps-environment.',
    remedy:
      'Add the Push Notifications capability to the app target. Without it APNs never issues a token, so there is nothing to send to.',
    docs: IOS_PUSH_DOCS,
  },
  'wiring.entitlements_missing': {
    stage: 'project_wiring',
    severity: 'blocker',
    summary: 'The app target has no entitlements file.',
    remedy:
      'Add the Push Notifications capability to the app target; Xcode creates the entitlements file with it.',
    docs: IOS_PUSH_DOCS,
  },
  'wiring.push_module_missing': {
    stage: 'project_wiring',
    severity: 'blocker',
    summary: "The project does not depend on the SDK's push module.",
    remedy:
      'Add io.customer.android:messaging-push-fcm. Without it the SDK never sees a message: the module is what registers the Firebase service that receives one.',
    docs: ANDROID_PUSH_DOCS,
  },
  'wiring.google_services_missing': {
    stage: 'project_wiring',
    severity: 'blocker',
    summary: 'No google-services.json in the app module.',
    remedy:
      'Download it from the Firebase console into the app module. Firebase cannot issue a token without it, so there is nothing to send to.',
    docs: ANDROID_PUSH_DOCS,
  },
  'wiring.google_services_package_mismatch': {
    stage: 'project_wiring',
    severity: 'blocker',
    summary: "google-services.json does not list the app's own package name.",
    remedy:
      'Add this app to the Firebase project, or fetch the file for the right one. A mismatch here fails at registration, so the app never gets a token.',
    docs: ANDROID_PUSH_DOCS,
  },
  'wiring.post_notifications_undeclared': {
    stage: 'project_wiring',
    severity: 'blocker',
    summary:
      'The manifest does not declare POST_NOTIFICATIONS, which Android 13 and later require before a notification can be shown.',
    remedy:
      'Add <uses-permission android:name="android.permission.POST_NOTIFICATIONS" /> and request it at runtime. Deliveries are still counted without it; nothing is ever displayed.',
    docs: ANDROID_PUSH_DOCS,
  },
  'wiring.fcm_service_does_not_forward': {
    stage: 'project_wiring',
    severity: 'warning',
    summary:
      'The app declares its own FirebaseMessagingService and it does not appear to forward messages to the SDK.',
    remedy:
      'A service the app declares owns every message. Forward to the SDK from onMessageReceived, or every delivery goes uncounted while the notification still displays — the Android shape of the invisible failure.',
    docs: ANDROID_PUSH_DOCS,
  },
  'device.no_network': {
    stage: 'device_ready',
    severity: 'blocker',
    summary: 'The target cannot reach the network, so no push can arrive.',
    remedy:
      'Check the emulator or device has a working connection before reading anything into a silent send.',
  },
  'device.dns_unresolved': {
    stage: 'device_ready',
    severity: 'blocker',
    summary:
      'The target has a network route but cannot resolve host names, so Firebase can never connect.',
    remedy:
      'Restart the emulator with `-dns-server 8.8.8.8` (an emulator loses DNS whenever the host resolver changes under it). Everything else looks healthy in this state, which is what makes it worth naming.',
  },
  'device.notification_permission_denied': {
    stage: 'device_ready',
    severity: 'blocker',
    summary: 'Notification permission is not granted on this target.',
    remedy:
      'Grant it with `adb shell pm grant <package> android.permission.POST_NOTIFICATIONS`, or accept the prompt in the app. Deliveries are counted either way; nothing is displayed.',
  },
  'workspace.fcm_credential_missing': {
    stage: 'workspace_ready',
    severity: 'blocker',
    summary: 'The workspace has no FCM push credential.',
    remedy:
      'Upload the Firebase service account key in the workspace settings. Sends will be accepted and dropped until it exists.',
    docs: ANDROID_PUSH_DOCS,
  },
  'workspace.apns_credential_missing': {
    stage: 'workspace_ready',
    severity: 'blocker',
    summary: 'The workspace has no APNs push credential.',
    remedy:
      'Upload the APNs auth key in the workspace settings. Sends will be accepted and dropped until it exists.',
    docs: IOS_PUSH_DOCS,
  },
  'workspace.env_mismatch': {
    stage: 'workspace_ready',
    severity: 'blocker',
    summary:
      "The workspace credential's environment does not match the build's aps-environment.",
    remedy:
      'A development build needs a sandbox credential and a release build needs a production one. This mismatch is the classic "the send returned 200 and nothing ever arrived".',
    docs: IOS_PUSH_DOCS,
  },
  'workspace.credential_config_unknown': {
    stage: 'workspace_ready',
    severity: 'warning',
    summary:
      'The workspace credential does not say whether it is sandbox or production.',
    remedy:
      'Re-save the APNs credential so the workspace records its environment. Until it does, the sandbox-versus-production pairing cannot be checked, and that mismatch is silent on both ends.',
    docs: IOS_PUSH_DOCS,
  },
  'workspace.lookup_failed': {
    stage: 'workspace_ready',
    severity: 'warning',
    summary: 'The workspace credential could not be read.',
    remedy:
      'Check that the authenticated account can read this workspace. Nothing about the credential is proven either way.',
  },
  'device.not_available': {
    stage: 'device_ready',
    severity: 'blocker',
    summary: 'The requested simulator or device is not usable.',
    remedy:
      'Boot the simulator or connect and unlock the device, then run again. Pass --target with a name or udid to choose between several.',
  },
  'device.app_not_installed': {
    stage: 'device_ready',
    severity: 'blocker',
    summary: 'The app is not installed on the target.',
    remedy:
      'Build and run the app on this target first. Verification reads what the SDK recorded at runtime, so there has to have been a run.',
  },
  'device.container_unreadable': {
    stage: 'device_ready',
    severity: 'warning',
    summary: "The app's data container could not be read.",
    remedy:
      'Container access needs a development build installed by Xcode. Without it the token and identity cannot be read, so the later rungs prove nothing.',
  },
  'device.installed_build_cannot_register': {
    stage: 'device_ready',
    severity: 'blocker',
    summary:
      'The installed build carries no aps-environment entitlement, so it cannot register for push at all.',
    remedy:
      'Install a build made with code signing on — a build made with CODE_SIGNING_ALLOWED=NO has no entitlements, APNs refuses it a token, and the SDK deletes the one it had while its stored copy stays on disk looking healthy.',
    docs: IOS_PUSH_DOCS,
  },
  'device.token_predates_install': {
    stage: 'device_ready',
    severity: 'warning',
    summary:
      'The stored push token is older than the installed build, so it may not belong to it.',
    remedy:
      'Launch the app once and let the SDK re-register. A reinstall leaves the container alone, and a dead token reads exactly like a live one.',
  },
  'device.token_unregistered': {
    stage: 'device_ready',
    severity: 'blocker',
    summary: 'The SDK has no push token stored on this target.',
    remedy:
      'Register for notifications and accept the permission prompt, then background and foreground the app. Without a token there is no address to send to.',
    docs: IOS_PUSH_DOCS,
  },
  'device.identity_anonymous': {
    stage: 'device_ready',
    severity: 'warning',
    summary: 'The app has an anonymous profile only — identify has never run.',
    remedy:
      'Log in, or call identify, so the token belongs to a profile a campaign can address. An anonymous token still receives a direct send.',
  },
  'profile.device_in_other_workspace': {
    stage: 'profile_linked',
    severity: 'blocker',
    summary:
      'This device is registered in a different workspace from the one you chose.',
    remedy:
      'The app is reporting to another workspace: check the CDP API key passed to CustomerIO.initialize against the key for the workspace you picked. Pushes sent from the chosen workspace will never reach this device.',
  },
  'profile.identity_in_other_workspace': {
    stage: 'profile_linked',
    severity: 'blocker',
    summary:
      'The identity this app logged in as exists in a different workspace.',
    remedy:
      "Either the app is using another workspace's CDP API key, or this login happened against a different environment. Compare the key in CustomerIO.initialize with the workspace you picked.",
  },
  'profile.not_found': {
    stage: 'profile_linked',
    severity: 'blocker',
    summary: "No profile in this workspace matches the device's identity.",
    remedy:
      'Check the workspace is the one the app talks to, and that identify has reached it — profile sync runs on a cycle, so a login seconds old may not be there yet.',
  },
  'profile.no_device_linked': {
    stage: 'profile_linked',
    severity: 'blocker',
    summary: 'The profile has no devices at all.',
    remedy:
      'The SDK registers the token against the identified profile. No devices means the token never reached the workspace, so every campaign send has nowhere to go.',
  },
  'profile.token_not_linked': {
    stage: 'profile_linked',
    severity: 'blocker',
    summary:
      'The profile has devices, but not the token this target is holding.',
    remedy:
      'This is the failure that hides behind a green dashboard: the profile looks addressable and the phone in your hand is not the device that gets the push. Re-identify after the token was issued, or clear the stale devices.',
  },
  'profile.app_identifier_mismatch': {
    stage: 'profile_linked',
    severity: 'warning',
    summary:
      "The linked device's app identifier is not the bundle id being verified.",
    remedy:
      'Usually means two builds share a profile. Harmless for this run, but a send addressed to the profile may reach the other app.',
  },
  'profile.push_disabled': {
    stage: 'profile_linked',
    severity: 'warning',
    summary: 'The linked device reports push_enabled false.',
    remedy:
      'Treat this as a hint, not a verdict — it has read false while permission was genuinely granted, and a later identify flipped it true. The registered token is the stronger evidence.',
  },
  'send.provider_rejected': {
    stage: 'delivered_matrix',
    severity: 'blocker',
    summary: 'Customer.io refused the send.',
    remedy:
      'Read the error: it is usually the token, the credential, or a sandbox/production mismatch. Nothing about the SDK is proven either way until a send is accepted.',
  },
  'send.provider_rate_limited': {
    stage: 'delivered_matrix',
    severity: 'blocker',
    summary:
      'The push provider refused the send as too frequent (429), so nothing was proven and the remaining states were not sent.',
    remedy:
      'Apple allows one APNs token change every 20 minutes, and on a workspace with more than one app each test send asks Apple for a new token, so sends close together come back TooManyProviderTokenUpdates. Pushes from campaigns and broadcasts reuse a cached token and are not affected. Wait 20 minutes and run again, or send a single state with --states killed.',
  },
  'device.notifications_wedged': {
    stage: 'delivered_matrix',
    severity: 'blocker',
    summary:
      'This target is not delivering notifications at all, so nothing was proven about the integration.',
    remedy:
      'Even a locally injected push did not display. Restart the target — `xcrun simctl shutdown <udid> && xcrun simctl boot <udid>` — and run again. A simulator in this state accepts sends and silently drops every one of them, which reads exactly like a broken integration.',
  },
  'runtime.opened_not_tracked': {
    stage: 'delivered_matrix',
    severity: 'blocker',
    summary: 'The notification was tapped and the SDK never reported the open.',
    remedy:
      'The click reached the SDK but no `opened` metric followed. Check that the app forwards notification responses to the SDK — on iOS that is `MessagingPush.shared.userNotificationCenter(_:didReceive:withCompletionHandler:)`, or the automatic swizzling being left enabled — and that the push carried a delivery id.',
  },
  'runtime.opened_without_delivery_id': {
    stage: 'delivered_matrix',
    severity: 'blocker',
    summary: 'The tap reached the SDK, but the message carried no delivery id.',
    remedy:
      'The SDK logged a click with an empty deliveryId, so it cannot attribute the open to anything. This is a payload problem rather than an app one: verify the push was sent by Customer.io and not rebuilt by an intermediary.',
  },
  'runtime.tap_not_ours': {
    stage: 'delivered_matrix',
    severity: 'blocker',
    summary:
      'The SDK saw the tap and decided the notification was not a Customer.io one.',
    remedy:
      'The SDK logged "Clicked non CIO push message". Either another notification was tapped, or the payload lost its `CIO` block on the way — an intermediary that rebuilds the notification does exactly this.',
  },
  'runtime.tap_not_seen': {
    stage: 'delivered_matrix',
    severity: 'warning',
    summary: 'Nothing about a tap reached the SDK, so nothing was proven.',
    remedy:
      'The tap did not arrive: the banner may have gone before it was tapped, or a different notification was tapped. Run the cell again and tap the notification whose title the run printed.',
  },
  'runtime.tap_not_confirmed': {
    stage: 'delivered_matrix',
    severity: 'warning',
    summary: 'Nobody confirmed the tap, so this cell proved nothing.',
    remedy:
      'The run waited for a tap and moved on. `opened` cannot be verified without one — there is no way to synthesise a notification tap — so run it again when you can tap.',
  },
  'runtime.deep_link_not_handled': {
    stage: 'delivered_matrix',
    severity: 'blocker',
    summary: 'The SDK reported the open, and the deep link went nowhere.',
    remedy:
      'The SDK tried the link and nothing claimed it. Check the URL against what the app actually routes — a scheme the app declares but whose host it does not handle fails exactly this way — and check the `deepLinkCallback` returns true once it has navigated.',
  },
  'runtime.deep_link_absent': {
    stage: 'delivered_matrix',
    severity: 'warning',
    summary:
      'The SDK reported the open, but the push carried no deep link to follow.',
    remedy:
      'Nothing is wrong with the open. If the link was expected, remember that `is_rich: true` gates the entire CIO payload block: without it the link never reaches the device.',
  },
  'runtime.push_never_arrived': {
    stage: 'delivered_matrix',
    severity: 'blocker',
    summary: 'The send was accepted and nothing reached the device at all.',
    remedy:
      'Look at the credential pairing and the token first. A freshly booted simulator also lags minutes behind an accepted send, so try once more before believing this.',
  },
  'runtime.nse_did_not_run': {
    stage: 'delivered_matrix',
    severity: 'blocker',
    summary:
      'The push arrived and the Notification Service Extension never ran on it.',
    remedy:
      'This is the invisible failure. The notification displays, the dashboard shows the provider accepted it, and no delivery is ever counted. Check the extension is embedded, entitled to the App Group, and forwarding to the SDK.',
  },
  'runtime.nse_did_not_forward': {
    stage: 'delivered_matrix',
    severity: 'blocker',
    summary:
      'The extension ran on the push and never handed it to the SDK, so nothing was even attempted.',
    remedy:
      'Call MessagingPush.shared.didReceive(request, withContentHandler:) from didReceive. The notification still displays, which is what makes this failure invisible from the outside.',
    docs: IOS_RICH_PUSH_DOCS,
  },
  'runtime.metric_not_accepted': {
    stage: 'delivered_matrix',
    severity: 'blocker',
    summary: 'The extension ran and the delivered metric was never accepted.',
    remedy:
      'The SDK tried and the report did not land — usually the cdpApiKey the extension initializes with, or no network in the extension process. The pending-delivery queue holds it for the app to retry.',
  },
  'runtime.no_evidence': {
    stage: 'delivered_matrix',
    severity: 'warning',
    summary:
      'The log was attached and the app said nothing at all, so this cell proves nothing.',
    remedy:
      'Suspect the capture, not the push: check the log tool is streaming (a filter that matches no process name returns silence), and that the app is the build you think it is.',
  },
  'runtime.metric_not_tracked': {
    stage: 'delivered_matrix',
    severity: 'blocker',
    summary: 'The SDK received the push and never reported a delivery for it.',
    remedy:
      'Check that automatic delivery tracking is on and that the message carries a delivery id. The notification still displays, which is what makes this failure invisible.',
  },
  'runtime.app_force_stopped': {
    stage: 'delivered_matrix',
    severity: 'warning',
    summary:
      "The app was in Android's stopped state, which blocks delivery entirely — by design, not by defect.",
    remedy:
      'Launch the app once and re-run. Force-stopping from Settings (or `am force-stop`) puts an app in this state, and a push sent to it is never delivered: this is the single most common way Android push testing produces a false failure. `am kill` is the faithful "swiped away" case.',
  },
  'runtime.delivery_id_mismatch': {
    stage: 'delivered_matrix',
    severity: 'warning',
    summary: 'The delivery the SDK reported is not the one this run sent.',
    remedy:
      'Usually an earlier push still in flight, so the cell proves less than it appears to. Re-run with the app quiet, and treat the timing as suspect if it repeats.',
  },
};

export function resolveCause(
  code: string,
  evidence: string[] = []
): ReportedCause {
  const definition = CAUSES[code];
  if (!definition) {
    // An unregistered code is a bug in this tool, and saying so beats reporting nothing.
    return {
      code,
      stage: 'project_wiring',
      severity: 'blocker',
      summary: `Unregistered cause code: ${code}`,
      remedy:
        'This is a defect in cio-sdk-tools. Please report it with the surrounding output.',
      evidence,
    };
  }
  return { code, evidence, ...definition };
}

export function severityOf(code: string): Severity {
  return CAUSES[code]?.severity ?? 'blocker';
}
