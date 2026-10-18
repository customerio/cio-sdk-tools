import {
  CauseDefinition,
  registerCauses,
  resolveCause,
  severityOf,
} from '../../core/report/causes';
import { Stage } from './types';

/**
 * Push's causes. Each one names the step that finds it, so a reader knows how far the run
 * got before it went wrong.
 */
type PushCause = CauseDefinition & { stage: Stage };

const IOS_PUSH_DOCS = 'https://www.customer.io/docs/sdk/ios/push/';
const IOS_RICH_PUSH_DOCS =
  'https://www.customer.io/docs/sdk/ios/push/#rich-push';
const ANDROID_PUSH_DOCS = 'https://www.customer.io/docs/sdk/android/push/';
/** Every platform's setup, the wrappers' included: these causes are shared. */
const SDK_DOCS = 'https://www.customer.io/docs/sdk/';

export const CAUSES: Record<string, PushCause> = {
  'wiring.sdk_absent': {
    stage: 'project_wiring',
    severity: 'blocker',
    summary: 'The Customer.io SDK is not a dependency of this project.',
    remedy:
      'Add the SDK before anything else. Every later finding would be a consequence of its absence rather than a cause.',
    docs: SDK_DOCS,
  },
  'wiring.init_absent': {
    stage: 'project_wiring',
    severity: 'blocker',
    summary: 'No call to CustomerIO.initialize was found in the app sources.',
    remedy:
      "Initialize the SDK when the app starts: from the app delegate launch method on iOS, from Application.onCreate on Android, or from the app's startup code in React Native, Expo and Flutter. Without it the SDK never registers for push and never reports a metric.",
    docs: SDK_DOCS,
  },
  'wiring.init_not_at_launch': {
    stage: 'project_wiring',
    severity: 'blocker',
    summary:
      'CustomerIO.initialize runs where nothing guarantees it runs before a push arrives: a SwiftUI view body on iOS, which is re-evaluated on every redraw, or an Activity on Android, which a push never starts.',
    remedy:
      'Move initialization to app launch: the app delegate launch method or the App type initializer on iOS, Application.onCreate on Android.',
    docs: SDK_DOCS,
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
  'wiring.wrapper_build_unread': {
    stage: 'project_wiring',
    severity: 'warning',
    summary:
      "The wrapper package's Gradle files declare the SDK in a way this tool doesn't read, so whether it brings the push module isn't checked.",
    remedy:
      'Update cio-sdk-tools. The rest of the run still proves push end to end: a push that arrives and is tracked shows the module is there.',
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
  'device.apns_offline': {
    stage: 'device_ready',
    severity: 'warning',
    summary:
      "The simulator has no connection to Apple's push servers, so no push can reach it.",
    remedy:
      'Restart the simulator with the command shown with this finding, or with Device > Restart in Simulator, then run again. Apple accepts a send whether or not the simulator is connected, so nothing about the send gives this away.',
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
      'Grant it with the command shown with this finding, or accept the prompt in the app. Deliveries are counted either way; nothing is displayed.',
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
  'workspace.fcm_ios_not_enabled': {
    stage: 'workspace_ready',
    severity: 'blocker',
    summary:
      "The app gets a Firebase token on iOS, and this workspace's FCM credential isn't set up to send to iOS.",
    remedy:
      "Customer.io refuses every send to this app with NoProviderConfigured until the workspace sends iOS pushes through Firebase: set that in the workspace's push settings, or build the app with MessagingPushAPN to send through APNs.",
    docs: IOS_PUSH_DOCS,
  },
  'workspace.sdk_key_foreign': {
    stage: 'workspace_ready',
    severity: 'blocker',
    summary:
      "The app's SDK runs with a key that isn't one of this workspace's.",
    remedy:
      "Everything the app reports, its profile and device included, goes to the workspace that issued the key, or nowhere if the key is dead, though a push sent to its token still arrives. Initialize the SDK with a key from this workspace, or choose the app's own workspace with --workspace. An app can keep a key from an earlier build in its own storage, so delete the app and install it again rather than installing over it.",
    docs: SDK_DOCS,
  },
  'workspace.extension_key_foreign': {
    stage: 'workspace_ready',
    severity: 'blocker',
    summary:
      "The Notification Service Extension's SDK runs with a key that isn't one of this workspace's.",
    remedy:
      "Pushes still arrive and show, but their delivered metrics go to another workspace, or nowhere. Initialize the extension's SDK with the app's key, where this finding points.",
    docs: IOS_RICH_PUSH_DOCS,
  },
  'workspace.lookup_failed': {
    stage: 'workspace_ready',
    severity: 'warning',
    summary: 'The workspace credential could not be read.',
    remedy:
      'Check that the authenticated account can read this workspace. Nothing about the credential is proven either way.',
  },
  'device.build_not_debuggable': {
    stage: 'device_ready',
    severity: 'blocker',
    summary:
      "The installed build isn't debuggable, so the SDK's token and profile can't be read from it.",
    remedy:
      "Install a debug build, or set debuggable true on this build type, and run again. Android lets another process read an app's files only when the build is debuggable, and without the token there is nothing to send to.",
  },
  'device.not_available': {
    stage: 'device_ready',
    severity: 'blocker',
    summary: 'The requested simulator or device is not usable.',
    remedy:
      'Boot the simulator or connect and unlock the device, then run again. Pass --device with a name or udid to choose between several.',
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
      'Open the app, and run again: the SDK stores a token the first time the app starts with push set up. If the app has been opened, check it registers for push at launch, and background and foreground it once. Without a token there is no address to send to.',
  },
  'device.sdk_state_unreadable': {
    stage: 'device_ready',
    severity: 'warning',
    summary:
      "The tool couldn't read what the SDK stored on this target, so it can't say whether the SDK holds a token or an identified user.",
    remedy:
      "Update cio-sdk-tools: this SDK version may keep its state where this version of the tool doesn't look. To go on meanwhile, pass --token and --user. An SDK that writes its state line in the log at debug level is read from there when its files can't be.",
  },
  'device.identity_anonymous': {
    stage: 'device_ready',
    severity: 'blocker',
    summary:
      'No user is identified on this device, and Customer.io sends push only to identified profiles.',
    remedy:
      "Log in, or call identify, then run again. Until then the token belongs to no profile, so nothing Customer.io sends can reach this device. Logging out removes the device from the profile, so the app has to be logged in when it's verified.",
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
      'Check the workspace is the one the app talks to, and that identify has reached it — profile sync runs on a cycle, so a login seconds old may not be there yet. An app sent to the background straight after logging in keeps its login on the device until it is opened again (Android cuts its network, iOS suspends it): keep the app open for about 30 seconds after logging in, then run again.',
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
      'This is the failure that hides behind a green dashboard: the profile looks addressable and the phone in your hand is not the device that gets the push. Re-identify after the token was issued, or clear the stale devices. If the app was just installed or logged in, keep it open for about 30 seconds so its device registration reaches Customer.io, then run again: an app sent to the background holds it on the device.',
  },
  'profile.app_identifier_mismatch': {
    stage: 'profile_linked',
    severity: 'warning',
    summary:
      "The linked device's app identifier is not the bundle id being verified.",
    remedy:
      'Usually means two builds share a profile. Harmless for this run, but a send addressed to the profile may reach the other app.',
  },
  'device.notifications_not_allowed': {
    stage: 'device_ready',
    severity: 'warning',
    summary: "iOS says the app's notifications aren't allowed.",
    remedy:
      "Allow notifications for the app: accept its prompt, or turn them on in the device's Settings under Notifications. Until then a push can still arrive, and be counted as delivered, without anything showing. This is iOS's own answer, read during the run, not Customer.io's copy of it.",
  },
  'send.provider_rejected': {
    stage: 'delivered_matrix',
    severity: 'blocker',
    summary: 'Customer.io refused the send.',
    remedy:
      'Read the error: it is usually the token, the credential, or a sandbox/production mismatch. Nothing about the SDK is proven either way until a send is accepted.',
  },
  'send.provider_not_configured': {
    stage: 'delivered_matrix',
    severity: 'blocker',
    summary:
      'Customer.io has no push provider set up for this platform in the workspace (NoProviderConfigured).',
    remedy:
      "For an iOS app that gets its token from Firebase, the workspace has to send iOS pushes through Firebase; otherwise add the platform's push credential. Every send is refused until then.",
    docs: IOS_PUSH_DOCS,
  },
  'send.api_failed': {
    stage: 'delivered_matrix',
    severity: 'warning',
    summary:
      "Customer.io's API failed while sending the push, so nothing was proven.",
    remedy:
      "This is an error on Customer.io's side, not the app's, the token or the credential. Run again; if it repeats, report the error shown with the push.",
  },
  'runtime.tap_lines_lost': {
    stage: 'delivered_matrix',
    severity: 'warning',
    summary:
      "The tap reached the app, and the SDK's lines for it never reached the phone's log stream.",
    remedy:
      "This is unproven, not failed. A phone's log stream drops lines, most of all during the burst of a cold launch, so a tap the app handled can leave no trace in it. For a tap on a killed app the run watches the next pids the phone will hand out, so the app lands in a stream that is already reading; the cell's evidence says why that did not cover it (usually more processes starting at once than it watched). Run that state again: the run prints the command, and the report carries it as `rerunUnproven`.",
  },
  'runtime.opened_recorded_link_unseen': {
    stage: 'delivered_matrix',
    severity: 'warning',
    summary:
      "Customer.io recorded the open; where the tap went was in the lines the phone's log lost.",
    remedy:
      "The open is proven by Customer.io's own record of this push. The deep link's outcome only exists in the device's log, which dropped it, so run the state again to see it.",
  },
  'runtime.cold_tap_not_handled': {
    stage: 'delivered_matrix',
    severity: 'blocker',
    summary: 'The tap started the app, and the SDK never handled it.',
    remedy:
      "iOS handed the tap to the app, and every line the app wrote from its first was read, so this is not a lost line. A tap that starts the app is delivered once, during launch, to the notification delegate in place by then; Apple's rule is that the delegate must be assigned before the app finishes launching. When taps on a running app pass and this one fails, the SDK is set up too late: initialize it, push module included, in the app delegate's launch method, not after a login, a screen appearing or an async load.",
    docs: IOS_PUSH_DOCS,
  },
  'runtime.tap_other_push': {
    stage: 'delivered_matrix',
    severity: 'warning',
    summary:
      'The open the SDK reported belongs to a different push than the one this run sent.',
    remedy:
      'Usually an older notification was tapped. Tap the one whose title ends in this run’s tag, as the prompt names it, or clear old notifications and run again.',
  },
  'runtime.tap_unmatched': {
    stage: 'delivered_matrix',
    severity: 'warning',
    summary:
      "The SDK tracked an open, but its line names no delivery id this tool can read, so the open can't be tied to the push this run sent.",
    remedy:
      'Update cio-sdk-tools: the SDK may now write the id differently. Until then, clear older notifications before the run so the only banner to tap is this one.',
  },
  'runtime.capture_stopped': {
    stage: 'delivered_matrix',
    severity: 'warning',
    summary:
      "The device's log capture stopped partway through the run, so nothing after that could be read.",
    remedy:
      'This says nothing about the integration. Run again; if it repeats, unplug and replug the phone, and make sure nothing else (Console, another idevicesyslog) is reading its log.',
  },
  'runtime.capture_silent': {
    stage: 'delivered_matrix',
    severity: 'warning',
    summary:
      'Not one log line arrived after the tap, so this cell could not be judged.',
    remedy:
      'Either the tap did not reach the app, or the log stream stopped delivering. If the app opened when you tapped, it was the stream: on a phone, unplug and replug it; on a simulator, close any other log viewer attached to it. Then run again.',
  },
  'runtime.deep_link_outcome_unseen': {
    stage: 'delivered_matrix',
    severity: 'warning',
    summary:
      'The SDK reported the open and started following the deep link, but never said how it ended.',
    remedy:
      'The open itself is fine. Usually the app was moved on before the link finished: run the cell again and leave the app in front until the run continues. If it repeats, check that the deepLinkCallback returns once it has navigated.',
  },
  'runtime.push_arrived_late': {
    stage: 'delivered_matrix',
    severity: 'warning',
    summary:
      'The push arrived, but only after this run had stopped waiting for it.',
    remedy:
      'Delivery works; it was slow. An emulator or simulator that was just started or resumed from a snapshot can take minutes to reconnect to the push service, then delivers everything at once — run again once it has been up a few minutes. On a phone, check that battery saver and Doze are off.',
  },
  'device.notifications_disabled': {
    stage: 'delivered_matrix',
    severity: 'blocker',
    summary:
      "Nothing reached the app in any state, and iOS says the app's notifications aren't allowed.",
    remedy:
      'On the device, open Settings → Notifications, find the app by its display name, and allow notifications; then run again. With notifications off, iOS drops an alert push before the extension runs, which looks exactly like a broken extension.',
  },
  'send.provider_rate_limited': {
    stage: 'delivered_matrix',
    severity: 'blocker',
    summary:
      'The push provider refused the send as too frequent (429), so nothing was proven and the remaining states were not sent.',
    remedy:
      'Apple allows one APNs token change every 20 minutes, and on a workspace with more than one app each test send asks Apple for a new token, so sends close together come back TooManyProviderTokenUpdates. Pushes from campaigns and broadcasts reuse a cached token and are not affected. Wait 20 minutes and run again, or send a single state with --app-states killed.',
  },
  'device.notifications_wedged': {
    stage: 'delivered_matrix',
    severity: 'blocker',
    summary:
      'This target is not delivering notifications at all, so nothing was proven about the integration.',
    remedy:
      "Even a locally injected push did not display, though iOS did not say the app's notifications are off. Restart the simulator with the command shown with this finding, then run again. A simulator in this state accepts sends and silently drops every one of them, which reads exactly like a broken integration.",
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
  'runtime.banner_not_seen': {
    stage: 'delivered_matrix',
    severity: 'warning',
    summary:
      'The push reached the device, and the person asked to tap it saw no banner.',
    remedy:
      'Delivery worked — the OS has the notification — so what is missing is the banner. Check that banners are on for the app and no Focus or Do Not Disturb is hiding them, and that the simulator window or the phone screen was in view. A banner shows for a few seconds and then lives only in Notification Centre, so look there too, and run the state again.',
  },
  'runtime.tap_not_confirmed': {
    stage: 'delivered_matrix',
    severity: 'warning',
    summary: 'No tap was confirmed, so this cell proved nothing.',
    remedy:
      'The state was skipped at the prompt, or nobody answered it. `opened` cannot be verified without a tap — there is no way to synthesise one — so run it again when you can tap.',
  },
  'runtime.deep_link_not_handled': {
    stage: 'delivered_matrix',
    severity: 'blocker',
    summary: 'The SDK reported the open, and the deep link went nowhere.',
    remedy:
      "Nothing could open the link: the app's deep link callback did not claim it, and no app on the device handles its scheme. Check the URL is one the app routes: a scheme it declares (CFBundleURLTypes on iOS, an intent filter on Android) or a universal or app link it handles, and that `deepLinkCallback` returns true once it has navigated.",
  },
  'runtime.deep_link_back_to_app': {
    stage: 'delivered_matrix',
    severity: 'warning',
    summary:
      "The deep link went back to the app through iOS, and where it went from there isn't logged.",
    remedy:
      "Nothing in the app claimed the link, so the SDK handed it to iOS (\"Deep link handled by system\"). Its scheme is the app's own, so iOS opened the app with it again, through the app or scene delegate's URL handler, and nothing logs whether that handler routed it: a link the app can't route lands here too. Check the screen the tap landed on. To have it proven, handle the link in `deepLinkCallback` and return true once you've navigated, so the SDK logs it as handled.",
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
      "Look at the credential pairing and the token first, then the target's own link to its push service. A freshly booted iOS simulator lags minutes behind an accepted send, so try once more. An Android device can hold a dead connection to Firebase that still reports itself connected: turn its Wi-Fi off and on, or cold-boot the emulator, then run again.",
  },
  'runtime.nse_did_not_run': {
    stage: 'delivered_matrix',
    severity: 'blocker',
    summary:
      'The push arrived and the Notification Service Extension never ran on it.',
    remedy:
      'This is the invisible failure. The notification displays, the dashboard shows the provider accepted it, and no delivery is ever counted. Check the extension is embedded, entitled to the App Group, and forwarding to the SDK.',
  },
  'runtime.push_not_seen': {
    stage: 'delivered_matrix',
    severity: 'warning',
    summary:
      "Nothing on the phone showed this push arriving: the extension's process never logged, and the phone's log stream can drop lines.",
    remedy:
      'This is unproven, not failed: a phone has no notification list the tool can read, so the extension running is the only sign of arrival, and the stream that would show it loses lines. Check the banner appeared, that notifications are allowed for the app, and run again.',
  },
  'runtime.push_not_handled': {
    stage: 'delivered_matrix',
    severity: 'blocker',
    summary:
      "The notification is on the device, and the app's SDK never said it received the push.",
    remedy:
      'Something other than the SDK displayed it — usually FCM showing a notification message by itself while the app is in the background, so the SDK never sees the push and nothing is counted. Check that the app’s messaging service hands pushes to the SDK, and that the SDK log level is debug for this check.',
    docs: ANDROID_PUSH_DOCS,
  },
  'runtime.sdk_logging_off': {
    stage: 'delivered_matrix',
    severity: 'warning',
    summary:
      'The app was plainly at work, and the Customer.io SDK did not write a single line during the run.',
    remedy:
      "The checks that need the SDK's account read its debug lines, so set the SDK's log level to debug in the build you are verifying — SDKConfigBuilder.logLevel(.debug) on iOS, CustomerIOBuilder.logLevel(CioLogLevel.DEBUG) on Android, or the logLevel option in the React Native or Flutter config — and run again. Arrival is still read from the OS either way.",
  },
  'runtime.no_evidence': {
    stage: 'delivered_matrix',
    severity: 'warning',
    summary:
      'The log was attached and the app said nothing at all, so this cell proves nothing.',
    remedy:
      'Suspect the capture, not the push: check the log tool is streaming (a filter that matches no process name returns silence), and that the app is the build you think it is. On a phone, make sure nothing else is reading its log (`pgrep -fl idevicesyslog` on the Mac): streams left running load the phone until its log stops delivering to anyone, and unplugging and replugging it resets the log relay. On Android, a React Native app started by a push runs no JavaScript, and its SDK gets its log level from CustomerIO.initialize there, so the SDK can handle a killed push without writing a line.',
  },
  'runtime.sdk_lines_unchecked': {
    stage: 'delivered_matrix',
    severity: 'warning',
    summary:
      "The SDK didn't write the line this tool looks for, and its version isn't one the tool has been checked against, so the missing line proves nothing.",
    remedy:
      'Update cio-sdk-tools. If it is already the latest, the SDK may have reworded the line: report it with the SDK version at https://github.com/customerio/cio-sdk-tools/issues.',
  },
  'runtime.app_state_not_set': {
    stage: 'delivered_matrix',
    severity: 'warning',
    summary:
      'The app could not be put in this state, so no push was sent for it.',
    remedy:
      'The run launches, backgrounds or stops the app itself to reach each state, and the error is shown with the push. On a phone, keep it unlocked during the run (a locked phone will not launch an app) and verify a development build; on Android the app needs a launcher activity. Then run the state again.',
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
  'backend.metric_not_recorded': {
    stage: 'recorded',
    severity: 'warning',
    summary:
      "Customer.io had not recorded the device's report of this push when the tool stopped waiting.",
    remedy:
      'The SDK sends opens in batches of up to 30 seconds and retries a failed upload later, so a report can arrive after the wait: run that state again before acting on it. If it never arrives, the SDK is reporting somewhere else. It reports with the API key and region it was set up with, so a key from another workspace sends its reports there. On iOS, delivered comes from the notification service extension, which needs the same key as the app.',
  },
  'backend.delivery_not_found': {
    stage: 'recorded',
    severity: 'warning',
    summary:
      'Customer.io had no record under a delivery id its own send returned.',
    remedy:
      "A test push's record is kept for 24 hours and read from the workspace that sent it, so this run should always find it. Run again, and if it repeats, report it with the delivery id shown with the push.",
  },
  'backend.record_unreadable': {
    stage: 'recorded',
    severity: 'warning',
    summary: "Customer.io's record of the push could not be read.",
    remedy:
      'The error is shown with the push. The `cio` login needs permission to view deliveries in this workspace: check it with `cio auth status`, then run again.',
  },
};

registerCauses('push', CAUSES);

// Resolution lives in the core registry; re-exported so push code reads causes from one place.
export { resolveCause, severityOf };
