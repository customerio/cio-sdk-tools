# `verify push`: the contract

Internal. For the agents and people building on `cio-sdk-tools verify push`: the Customer.io skills, the dashboard prompt, the docs, and the backend that keeps test pushes. It describes the release the `verify-command` branch becomes, **1.9.0**. Where this file and the tool disagree, the tool's `--help` and output win, and this file is the bug.

## At a glance

`verify push` proves an app's push integration works. It checks the project, the workspace, the device and the profile, then sends real pushes and follows each one until the app handles it. When something breaks, it names the step, the cause and the fix.

```
npx cio-sdk-tools@1.9.0 verify push <path> --depth on-device \
  --workspace <id> --device <udid|serial|name> --json
```

- **Pin the exact version** (`@1.9.0`), never `@latest`. A skill reads the output of the version it pinned.
- **Exit code first, then `causes[]`.** Key on `code`, act on `remedy`, and use the `detail` of the check or push that named it.
- **Get the person's OK before a run that sends.** Naming `--depth`, `--workspace` and `--device` is the go-ahead.

## Release

| | |
|---|---|
| Version | 1.9.0, published by semantic-release when `verify-command` merges to `main`. Nothing else gates it. |
| Where it lives | `cio-sdk-tools verify`, next to `doctor`. `doctor` is deprecated later. |
| Before it ships | See [Open before release](#open-before-release). |

## The command

```
cio-sdk-tools verify <area> [path] [options]
```

`verify` checks one area at a time, and an area checks only what it needs: `verify push` never looks at anything an app without push would lack. `push` is the only area today.

`path` is the app project: an `.xcodeproj`, an Android app module, or a folder holding one (default `.`). A React Native, Expo or Flutter root holds both, so pass `--platform ios` or `--platform android`.

### Depths

Each depth runs everything before it.

| `--depth` | What runs | Sends | A pass proves |
|---|---|---|---|
| `registration` | Project wiring, workspace ready, device ready, profile linked. The first failure stops the run. | Nothing | The device is registered for push. |
| `on-device` | Registration, then one real push per app state (killed, background, foreground), each followed on the device. With `--check-opens` and a person present, the killed and background pushes are tapped. | 1–3 pushes | Each push arrived on the device and the app handled it; each tap reached the SDK and its deep link went where it should. Nothing about what Customer.io recorded. |
| `end-to-end` | On-device, then Customer.io's record of each push, read back after the last one. Waits up to 120s for delivered and 150s for opened. | 1–3 pushes | Also: Customer.io recorded each push as delivered, and as opened when tapped. |

Arrival is read from the OS wherever it can be: the simulator's notification store, the extension's own process, Android's notification list. That the app handled a push is read from the SDK's debug lines. A missing line on a phone makes a push unproven, never failed.

### Options

| Option | |
|---|---|
| `--depth <level>` | `registration`, `on-device`, `end-to-end`. Asked in a terminal; `registration` when nobody can be asked. |
| `--workspace <id>` | The workspace the app reports to. |
| `-d, --device <id\|name>` | Simulator udid, iPhone udid, Android serial, or name. |
| `--app-states <list>` | `killed`, `background`, `foreground` (default all three), one push each. |
| `--check-opens` | A person taps the killed and background pushes. See [Unattended runs](#unattended-runs). |
| `--deep-link <url>` | The URL the pushes carry, so a tap is checked to land there. |
| `-n, --dry-run` | Everything except sending. |
| `--no-retry` | No second push when the first doesn't arrive. |
| `--cio-profile <name>` | The `cio` login to use (env `CIO_PROFILE`). |
| `--platform <ios\|android>` | When the folder holds both projects. |
| `--ios-target`, `--ios-configuration`, `--android-module`, `--android-app-id` | When the project builds several apps. |
| `--watch-registration` | Watch the install, token and login happen, instead of reading what they left behind. |
| `--evidence-dir <dir>` | Keep the device logs and screenshots there. |
| `--json` | The report on stdout. Implies `--non-interactive`. |
| `--report <file>` | The report written to a file as well. |
| `-v, --verbose` | Every check, command, timing and piece of evidence; with `--json` or `--report`, the full report. Env `CIO_VERBOSE=1`. |
| `-q, --quiet` | Only the verdict and what to do about it. |
| `--non-interactive` | Never ask; anything missing is an error naming its option. |

## Running it as an agent

### Before the run: a fresh install

After integrating, have the person delete the app, install the new build, launch it, log in, and answer the notification prompt. Keep the app open for about 30 seconds after logging in, then run the tool.

Why:
- A reinstall over an old build keeps its notification permission and its registration, which can pass checks a new install would fail.
- Customer.io sends push only to identified profiles. An app that isn't logged in stops the run at Device ready.
- On an iPhone, the tool learns whether notifications are allowed only from the app's own log while it runs. A run where the app never starts (killed state only) can't tell "notifications off" from "nothing arrived". A fresh launch, or including the foreground state, gives it the answer.

A new login, and the device it registers, take a while to reach Customer.io, and an app sent to the background holds them on the device: Android cuts a background app's network and iOS suspends it. When the profile or the device isn't there at first, the tool opens the app once, then reads the profile again every 5s for up to 90s before calling it missing.

### Consent

Ask the person before any run that sends, then name all three of `--depth`, `--workspace` and `--device`. Naming them is the go-ahead, and the report records it as `consent.by: "named"`. There is no `--yes`: a flag that only says yes agrees to whatever the run happened to pick.

A run that sends but can't ask, and is missing any of the three, stops before it touches anything:

```
$ cio-sdk-tools verify push ./ios --depth on-device --json
{"error":true,"code":"VALIDATION_ERROR","message":"this run sends real pushes and nobody can be asked, so where they go has to be named — pass --workspace <id> and --device <id|name>","details":{"flags":["--workspace <id>","--device <id|name>"]}}
exit 2
```

### Unattended runs

A run is unattended under `--json`, `--non-interactive`, or without a terminal, which includes most agent shells. It never asks a question and never waits for a tap, so **`--check-opens` taps nothing unattended**. Opens are checked only in a person's interactive terminal: run delivery yourself, and hand the person the same command with `--check-opens` (and `--deep-link`) to run.

### Reading the result

| Exit | Meaning | What to do |
|---|---|---|
| 0 | Everything asked for passed. | Say what the depth proves (see [Depths](#depths)), and nothing more. |
| 20 | The integration is broken. | Each blocker in `causes[]` has the fix. |
| 21 | Nothing failed, but something couldn't be proven. | Run `rerunUnproven`, which retries only those app states. |
| 2 | Bad input: a missing or unknown option, no project found. | stderr names the option. |
| 1, 3, 4, 5 | The tool couldn't run: an error, the `cio` login, a permission, the API. | Not a verdict on the integration. Read the stderr envelope. |

Show `summary` and `remedy` as the tool wrote them. The tool owns that text and keeps it consistent across platforms.

### Simulators

A simulator can lose its link to Apple's push servers and keep reporting itself connected. A run that sends to a simulator says so at the start. When the tool can tell, it names the cause (`device.apns_offline`) with the restart command; when it can't, the advice stands: if a push doesn't arrive, restart the simulator and run again.

### `--verbose`

For debugging the tool, not for the fix. It adds the evidence behind each finding (log lines, paths, delivery ids, timings, the commands the tool ran), and keeps the device logs. Device tokens are cut to their first 12 characters there too.

## Output

### The report

`--json` prints it on stdout, and `--report <file>` writes the same. Errors go to stderr, never stdout. By default the report holds what a customer acts on; `--verbose` gives the full one.

| Field | |
|---|---|
| `schema` | `1`. See [Versioning](#versioning). |
| `tool` | `{ name, version }` |
| `area` | `"push"` |
| `level` | The depth: `registration`, `on-device`, `end-to-end`. |
| `project` | `{ platform: "ios"\|"android", framework: "native"\|"react-native"\|"expo"\|"flutter", name }` |
| `verdict` | `pass`; `warn` (passed, with something worth attention); `fail`; `skip` (something couldn't be proven). |
| `exitCode` | As above. |
| `sections[]` | In the order they ran. |
| — `kind: "checks"` | A registration step: `{ id, title, verdict, summary?, skipped?, checks? }`. `checks` lists only the checks that didn't pass: `{ id, verdict, label, cause?, detail? }`. |
| — `kind: "cells"` | Pushes: `{ metric: "delivered"\|"opened"\|"recorded", verdict, skipped?, cells: [{ state, verdict, cause?, detail?, summary?, recorded? }] }` |
| `causes[]` | Every cause the run found, once each: `{ code, stage, severity, summary, remedy, docs? }`. |
| `advice[]` | Notes that aren't findings, e.g. the build's age, or the simulator note. |
| `consent` | `{ granted, by: "named"\|"prompt", writes: [...] }`, present when the run was due to send. |
| `rerunUnproven` | The command that retries only the app states that couldn't be proven. |

`detail` is the one fact a person needs to act on a finding: the value to change, the command to run, the provider's error. The `--verbose` report adds `command`, `startedAt`, `finishedAt`, `provenance`, `project.path`, `rerun`, every passing check, and `evidence` and durations on everything.

A failing run (a project with no notification service extension), trimmed:

```json
{
  "schema": 1,
  "tool": { "name": "cio-sdk-tools", "version": "1.9.0" },
  "area": "push",
  "level": "registration",
  "project": { "platform": "ios", "framework": "native", "name": "APN UIKit" },
  "verdict": "fail",
  "exitCode": 20,
  "sections": [
    {
      "kind": "checks", "id": "project_wiring", "title": "Project wiring", "verdict": "fail",
      "summary": "APNs · no extension",
      "checks": [
        { "id": "nse_present", "verdict": "fail", "label": "Notification Service Extension exists", "cause": "wiring.nse_missing" },
        { "id": "nse_forwards_to_sdk", "verdict": "skip", "label": "Extension forwards the request to the SDK", "detail": "no extension to inspect" }
      ]
    },
    { "kind": "checks", "id": "workspace_ready", "title": "Workspace ready", "verdict": "skip", "skipped": "an earlier rung failed" }
  ],
  "causes": [
    {
      "code": "wiring.nse_missing", "stage": "project_wiring", "severity": "blocker",
      "summary": "The project has no Notification Service Extension target.",
      "remedy": "Add a Notification Service Extension and forward its requests to the SDK. Without it iOS shows the push, but nothing attaches rich content and nothing counts a delivery.",
      "docs": "https://www.customer.io/docs/sdk/ios/push/#rich-push"
    }
  ]
}
```

### Errors

A tool failure is one JSON line on stderr, in the `cio` CLI's own shape, so one consumer reads both tools:

```json
{"error":true,"code":"VALIDATION_ERROR","message":"…","details":{…}}
```

| `code` | Exit |
|---|---|
| `VALIDATION_ERROR` | 2 |
| `GENERAL_ERROR` | 1 |
| `AUTH_ERROR` | 3 |
| `AUTHZ_ERROR` | 4 |
| `API_ERROR` | 5 |

### Versioning

- `schema` changes when a field is removed, renamed, or changes meaning. New fields, new sections and new cause codes don't change it.
- A cause code is added, never renamed or reused for another meaning. One the tool stops finding stays in the catalog.
- The default report is the stable surface. The fields only `--verbose` adds may change between versions.

## Causes

80 today, each found by one step (`stage`), listed in [the appendix](#appendix-every-cause). Every check or push that doesn't pass names one.

- `blocker`: the integration is broken, or the run can't go on. The run fails (exit 20).
- `warning`: worth the person's attention, or the reason a push is unproven. The run warns (exit 0) or ends unproven (exit 21).

## Requirements

- **Node.js 20 or later.** Node 20 went out of support in April 2026; CI tests it as the oldest the package allows.
- **The Customer.io CLI, logged in:** `npm install -g @customerio/cli`, then `cio auth login`. The login needs to read workspaces, push credentials, sources and their API keys, customers and test deliveries, and to send test pushes. `--cio-profile` needs a `cio` that has profiles.
- **iOS:** macOS with Xcode, and a booted simulator or a USB-connected, unlocked iPhone running a development build. An iPhone's logs need `idevicesyslog` (`brew install libimobiledevice`).
- **Android:** `adb`, and a running emulator or connected device with a debuggable build (the tool reads the SDK's stored token with `run-as`).
- **The SDK at debug log level** for the checks that read its lines. At the default (error), arrival is still proven, but not that the app handled the push.

## App types

| App | How | Tested |
|---|---|---|
| iOS, native | Path to the `.xcodeproj` or its folder | Yes |
| Android, native | Path to the app module or its folder | Yes |
| React Native | App root with `--platform`, or the `ios/`/`android/` folder | Not yet |
| Expo | Run `expo prebuild` first, then as React Native | Not yet |
| Flutter | App root with `--platform`, or the `ios/`/`android/` folder | Not yet |

The tool verifies the native half of a wrapper app, and reads the wrapper package with it: the SDK and its push module come with the package, `CustomerIO.initialize` is found in the app's JavaScript, TypeScript or Dart, and the package's Android manifest counts as the app's. The framework is named in the report (`project.framework`).

## What the tool depends on

Changing any of these can break the tool silently. Tell its owners first.

### Customer.io API (through `cio api`)

| Call | Used for |
|---|---|
| `POST /v1/environments/{id}/verify/push` | The only write: one test push. Body `{ to, platform, provider, sandbox, title, body, is_rich: true, image_url, link? }`. `is_rich` must be true, or the backend drops the deep link and image. Returns `delivery_id` when Customer.io keeps a record; a refusal carries it in `errors[].meta.delivery_id`. |
| `GET /v1/environments/{id}/test_deliveries/{delivery_id}` | End-to-end. `{ test_delivery: { id, state, sent, failed, delivered, opened, provider_status, failure_message, failure_detail } }`, times in Unix seconds. Kept 24 hours, then 404. |
| `GET /v1/accounts/{account_id}/environments` | Workspace names and ids. |
| `GET /v1/environments/{id}/credentials/{push_apns\|push_fcm}` | Whether the workspace has a push credential, and its APNs environment. |
| `GET /v1/environments/{id}/customers` | The profile by email or id, and its devices. |
| `GET /cdp/api/workspaces/{id}/sources`, `GET /cdp/api/workspaces/{id}/sources/{source_id}/api_keys` | The keys the chosen workspace issued, to check the keys the app and its extension run with. |

### SDK debug lines

The tool matches these sentences. A wording change in the SDK is a breaking change for the tool. React Native forwards the Android SDK's lines to logcat under `ReactNativeJS`, with `[CIO] ` in front, and the tool reads them the same.

- **iOS extension:** `Tracking push message delivered`, `Successfully tracked push metric 'delivered'`, `invoking contentHandler` / `normal completion`, `rich push step finished`.
- **Android receipt:** `Received new message with deliveryId:`, `Tracking push message delivered with deliveryId:`, `Showing notification for message:`, `Received duplicate message with deliveryId:`, and the `[CIO-Push-Handoff]` worker lines. Where the SDK logs no receipt, WorkManager's `Worker result SUCCESS for Work … PushDeliveryMetricsWorker` counts instead: a React Native app started for a push runs no JavaScript, which sets its SDK's log level.
- **Taps, both:** `Clicked notification for message` / `Clicked CIO push message`, `Tracking push message opened with deliveryId: <id>`, `Clicked non CIO push message`, `Clicked message with empty deliveryId`.
- **Deep links:** iOS `Handling push notification deep link with url:`; Android `Handling push notification deep link with payload: … - pushClickBehavior:`. Then `Deep link handled by host app callback implementation` / `internal host app navigation` / `system` / `external app`, or `Deep link was not handled`. On Android, `Deep link handled by opening default host app` with a link sent means nothing could open it.
- **Permission (new):** `[Push] Notification permission: <status>`, logged in pending SDK releases (customerio-ios #1341, customerio-android #935). iOS `Deep link was not handled` from iOS's own answer comes with customerio-ios #1340.

### The OS

- **iOS simulator:** the notification store, the app's notification settings (`BulletinBoard/VersionedSectionInfo.plist`), the push service's `Connected on` log lines, and `simctl push` to test the simulator itself.
- **iOS, any:** which process wrote a line (the extension's own process proves it ran), and `Failed to open URL` in the app's process when nothing could open a link.
- **Android:** `dumpsys notification`, `dumpsys package` (permission, stopped state, install time), a ping to `fcm.googleapis.com`, and the SDK's stored token through `run-as`.

## Tested

| Target | Registration | Pushes | Taps | End-to-end |
|---|---|---|---|---|
| iPhone 15, iOS 18.0.1 | ✅ | ✅ | ✅ | Not yet |
| iPhone 16 simulator, iOS 18.0 | ✅ | ✅ | ✅ | Not yet |
| Galaxy S24, Android 16 | ✅ | ✅ | ✅ | Not yet |

The native sample apps, in a workspace with several apps; on the iPhone and the S24 from fresh installs. An Android emulator (API 35) passed registration on the release build.

## Known limits

- **Opens need a person** at an interactive terminal.
- **An iPhone that never starts the app** during the run (killed state only), with notifications off, can't tell why nothing arrived.
- **A simulator's stale link to Apple** goes undetected while it reports itself connected; the run's advice is to restart it.
- **A phone's log stream drops lines.** A missing line makes a push unproven, never failed. For the tap that starts a killed app on an iPhone, the tool reads the launch from its first line.
- **Customer.io's copy of the permission (`push_enabled`)** lags the device by 30–60s and isn't judged.
- **An iPhone app that never asked for permission** can still run its extension for a push, so the push passes; the tool adds that notifications aren't allowed, so nothing would have shown.

## Open before release

- Deploy the backend route for test deliveries, then run end-to-end against a local backend, then production.
- Run a React Native, an Expo and a Flutter sample.
- Run Android with the SDK at error log level.
- Name the SDK versions with the permission line and the deep-link outcome once they ship. The tool works without them.

## Appendix: every cause

Generated from the tool's catalog. `severity` is `blocker` or `warning`; the second line is the remedy, as the tool prints it.

### Project wiring (`project_wiring`)

- **`wiring.sdk_absent`** · blocker — The Customer.io SDK is not a dependency of this project.
  Add the SDK before anything else. Every later finding would be a consequence of its absence rather than a cause. https://www.customer.io/docs/sdk/
- **`wiring.init_absent`** · blocker — No call to CustomerIO.initialize was found in the app sources.
  Initialize the SDK when the app starts: from the app delegate launch method on iOS, from Application.onCreate on Android, or from the app's startup code in React Native, Expo and Flutter. Without it the SDK never registers for push and never reports a metric. https://www.customer.io/docs/sdk/
- **`wiring.init_not_at_launch`** · blocker — CustomerIO.initialize runs where nothing guarantees it runs before a push arrives: a SwiftUI view body on iOS, which is re-evaluated on every redraw, or an Activity on Android, which a push never starts.
  Move initialization to app launch: the app delegate launch method or the App type initializer on iOS, Application.onCreate on Android. https://www.customer.io/docs/sdk/
- **`wiring.init_launch_unproven`** · warning — CustomerIO.initialize was found, but no path from a launch method to it could be resolved.
  Nothing to fix if initialization runs at launch through a helper the tool could not follow. Worth a glance: initialization that runs later than launch loses pushes that arrive before it.
- **`wiring.nse_missing`** · blocker — The project has no Notification Service Extension target.
  Add a Notification Service Extension and forward its requests to the SDK. Without it iOS shows the push, but nothing attaches rich content and nothing counts a delivery. https://www.customer.io/docs/sdk/ios/push/#rich-push
- **`wiring.nse_multiple`** · blocker — More than one Notification Service Extension is embedded in the app.
  iOS runs exactly one service extension per notification, and which one is not something you control. Keep one and forward to the SDK from it. https://www.customer.io/docs/sdk/ios/push/#rich-push
- **`wiring.project_format_json`** · warning — This project uses the JSON .xcproj format, so the checks that need the raw project graph could not run.
  Targets and build settings still come from xcodebuild, which reads either format. Embedding is not exposed that way, so it is proven from the installed build instead — or not at all, if nothing is installed yet. https://developer.apple.com/documentation/xcode/updating-your-xcode-project-configuration-file-format
- **`wiring.nse_not_embedded`** · blocker — A Notification Service Extension target exists but the app does not embed it.
  Add the extension to the app target as a dependency and to its Embed Foundation Extensions phase. An extension that ships outside the app bundle is never launched. https://www.customer.io/docs/sdk/ios/push/#rich-push
- **`wiring.nse_does_not_forward`** · warning — The Notification Service Extension never hands the request to the SDK.
  Call MessagingPush.shared.didReceive(request, withContentHandler:) from didReceive. This is the invisible failure: the push still arrives and still displays, and no delivery is ever counted. https://www.customer.io/docs/sdk/ios/push/#rich-push
- **`wiring.app_group_mismatch`** · blocker — The App Group in the extension code is not granted by the extension entitlements.
  The same App Group has to appear in three places: the app entitlements, the extension entitlements, and appGroupId() in code. Two out of three is the shape that survives code review and fails at runtime. https://www.customer.io/docs/sdk/ios/push/#rich-push
- **`wiring.app_group_absent`** · warning — No App Group is configured for the extension.
  Configure an App Group so the extension can hand metrics back to the app when it cannot report them itself. Delivery tracking works without it in the common case and loses events in the slow-network one. https://www.customer.io/docs/sdk/ios/push/#rich-push
- **`wiring.push_capability_missing`** · blocker — The app entitlements do not declare aps-environment.
  Add the Push Notifications capability to the app target. Without it APNs never issues a token, so there is nothing to send to. https://www.customer.io/docs/sdk/ios/push/
- **`wiring.entitlements_missing`** · blocker — The app target has no entitlements file.
  Add the Push Notifications capability to the app target; Xcode creates the entitlements file with it. https://www.customer.io/docs/sdk/ios/push/
- **`wiring.push_module_missing`** · blocker — The project does not depend on the SDK's push module.
  Add io.customer.android:messaging-push-fcm. Without it the SDK never sees a message: the module is what registers the Firebase service that receives one. https://www.customer.io/docs/sdk/android/push/
- **`wiring.google_services_missing`** · blocker — No google-services.json in the app module.
  Download it from the Firebase console into the app module. Firebase cannot issue a token without it, so there is nothing to send to. https://www.customer.io/docs/sdk/android/push/
- **`wiring.google_services_package_mismatch`** · blocker — google-services.json does not list the app's own package name.
  Add this app to the Firebase project, or fetch the file for the right one. A mismatch here fails at registration, so the app never gets a token. https://www.customer.io/docs/sdk/android/push/
- **`wiring.post_notifications_undeclared`** · blocker — The manifest does not declare POST_NOTIFICATIONS, which Android 13 and later require before a notification can be shown.
  Add <uses-permission android:name="android.permission.POST_NOTIFICATIONS" /> and request it at runtime. Deliveries are still counted without it; nothing is ever displayed. https://www.customer.io/docs/sdk/android/push/
- **`wiring.fcm_service_does_not_forward`** · warning — The app declares its own FirebaseMessagingService and it does not appear to forward messages to the SDK.
  A service the app declares owns every message. Forward to the SDK from onMessageReceived, or every delivery goes uncounted while the notification still displays — the Android shape of the invisible failure. https://www.customer.io/docs/sdk/android/push/

### Workspace ready (`workspace_ready`)

- **`workspace.fcm_credential_missing`** · blocker — The workspace has no FCM push credential.
  Upload the Firebase service account key in the workspace settings. Sends will be accepted and dropped until it exists. https://www.customer.io/docs/sdk/android/push/
- **`workspace.apns_credential_missing`** · blocker — The workspace has no APNs push credential.
  Upload the APNs auth key in the workspace settings. Sends will be accepted and dropped until it exists. https://www.customer.io/docs/sdk/ios/push/
- **`workspace.env_mismatch`** · blocker — The workspace credential's environment does not match the build's aps-environment.
  A development build needs a sandbox credential and a release build needs a production one. This mismatch is the classic "the send returned 200 and nothing ever arrived". https://www.customer.io/docs/sdk/ios/push/
- **`workspace.credential_config_unknown`** · warning — The workspace credential does not say whether it is sandbox or production.
  Re-save the APNs credential so the workspace records its environment. Until it does, the sandbox-versus-production pairing cannot be checked, and that mismatch is silent on both ends. https://www.customer.io/docs/sdk/ios/push/
- **`workspace.fcm_ios_not_enabled`** · blocker — The app gets a Firebase token on iOS, and this workspace's FCM credential isn't set up to send to iOS.
  Customer.io refuses every send to this app with NoProviderConfigured until the workspace sends iOS pushes through Firebase: set that in the workspace's push settings, or build the app with MessagingPushAPN to send through APNs. https://www.customer.io/docs/sdk/ios/push/
- **`workspace.sdk_key_foreign`** · blocker — The app's SDK runs with a key that isn't one of this workspace's.
  Everything the app reports, its profile and device included, goes to the workspace that issued the key, or nowhere if the key is dead, though a push sent to its token still arrives. Initialize the SDK with a key from this workspace, or choose the app's own workspace with --workspace. An app can keep a key from an earlier build in its own storage, so delete the app and install it again rather than installing over it. https://www.customer.io/docs/sdk/
- **`workspace.extension_key_foreign`** · blocker — The Notification Service Extension's SDK runs with a key that isn't one of this workspace's.
  Pushes still arrive and show, but their delivered metrics go to another workspace, or nowhere. Initialize the extension's SDK with the app's key, where this finding points. https://www.customer.io/docs/sdk/ios/push/#rich-push
- **`workspace.lookup_failed`** · warning — The workspace credential could not be read.
  Check that the authenticated account can read this workspace. Nothing about the credential is proven either way.

### Device ready (`device_ready`)

- **`device.no_network`** · blocker — The target cannot reach the network, so no push can arrive.
  Check the emulator or device has a working connection before reading anything into a silent send.
- **`device.apns_offline`** · warning — The simulator has no connection to Apple's push servers, so no push can reach it.
  Restart the simulator with the command shown with this finding, or with Device > Restart in Simulator, then run again. Apple accepts a send whether or not the simulator is connected, so nothing about the send gives this away.
- **`device.dns_unresolved`** · blocker — The target has a network route but cannot resolve host names, so Firebase can never connect.
  Restart the emulator with `-dns-server 8.8.8.8` (an emulator loses DNS whenever the host resolver changes under it). Everything else looks healthy in this state, which is what makes it worth naming.
- **`device.notification_permission_denied`** · blocker — Notification permission is not granted on this target.
  Grant it with the command shown with this finding, or accept the prompt in the app. Deliveries are counted either way; nothing is displayed.
- **`device.build_not_debuggable`** · blocker — The installed build isn't debuggable, so the SDK's token and profile can't be read from it.
  Install a debug build, or set debuggable true on this build type, and run again. Android lets another process read an app's files only when the build is debuggable, and without the token there is nothing to send to.
- **`device.not_available`** · blocker — The requested simulator or device is not usable.
  Boot the simulator or connect and unlock the device, then run again. Pass --device with a name or udid to choose between several.
- **`device.app_not_installed`** · blocker — The app is not installed on the target.
  Build and run the app on this target first. Verification reads what the SDK recorded at runtime, so there has to have been a run.
- **`device.container_unreadable`** · warning — The app's data container could not be read.
  Container access needs a development build installed by Xcode. Without it the token and identity cannot be read, so the later rungs prove nothing.
- **`device.installed_build_cannot_register`** · blocker — The installed build carries no aps-environment entitlement, so it cannot register for push at all.
  Install a build made with code signing on — a build made with CODE_SIGNING_ALLOWED=NO has no entitlements, APNs refuses it a token, and the SDK deletes the one it had while its stored copy stays on disk looking healthy. https://www.customer.io/docs/sdk/ios/push/
- **`device.token_predates_install`** · warning — The stored push token is older than the installed build, so it may not belong to it.
  Launch the app once and let the SDK re-register. A reinstall leaves the container alone, and a dead token reads exactly like a live one.
- **`device.token_unregistered`** · blocker — The SDK has no push token stored on this target.
  Open the app, and run again: the SDK stores a token the first time the app starts with push set up. If the app has been opened, check it registers for push at launch, and background and foreground it once. Without a token there is no address to send to.
- **`device.identity_anonymous`** · blocker — No user is identified on this device, and Customer.io sends push only to identified profiles.
  Log in, or call identify, then run again. Until then the token belongs to no profile, so nothing Customer.io sends can reach this device. Logging out removes the device from the profile, so the app has to be logged in when it's verified.
- **`device.notifications_not_allowed`** · warning — iOS says the app's notifications aren't allowed.
  Allow notifications for the app: accept its prompt, or turn them on in the device's Settings under Notifications. Until then a push can still arrive, and be counted as delivered, without anything showing. This is iOS's own answer, read during the run, not Customer.io's copy of it.

### Profile linked (`profile_linked`)

- **`profile.device_in_other_workspace`** · blocker — This device is registered in a different workspace from the one you chose.
  The app is reporting to another workspace: check the CDP API key passed to CustomerIO.initialize against the key for the workspace you picked. Pushes sent from the chosen workspace will never reach this device.
- **`profile.identity_in_other_workspace`** · blocker — The identity this app logged in as exists in a different workspace.
  Either the app is using another workspace's CDP API key, or this login happened against a different environment. Compare the key in CustomerIO.initialize with the workspace you picked.
- **`profile.not_found`** · blocker — No profile in this workspace matches the device's identity.
  Check the workspace is the one the app talks to, and that identify has reached it — profile sync runs on a cycle, so a login seconds old may not be there yet. An app sent to the background straight after logging in keeps its login on the device until it is opened again (Android cuts its network, iOS suspends it): keep the app open for about 30 seconds after logging in, then run again.
- **`profile.no_device_linked`** · blocker — The profile has no devices at all.
  The SDK registers the token against the identified profile. No devices means the token never reached the workspace, so every campaign send has nowhere to go.
- **`profile.token_not_linked`** · blocker — The profile has devices, but not the token this target is holding.
  This is the failure that hides behind a green dashboard: the profile looks addressable and the phone in your hand is not the device that gets the push. Re-identify after the token was issued, or clear the stale devices. If the app was just installed or logged in, keep it open for about 30 seconds so its device registration reaches Customer.io, then run again: an app sent to the background holds it on the device.
- **`profile.app_identifier_mismatch`** · warning — The linked device's app identifier is not the bundle id being verified.
  Usually means two builds share a profile. Harmless for this run, but a send addressed to the profile may reach the other app.

### Pushes (`delivered_matrix`)

- **`send.provider_rejected`** · blocker — Customer.io refused the send.
  Read the error: it is usually the token, the credential, or a sandbox/production mismatch. Nothing about the SDK is proven either way until a send is accepted.
- **`send.provider_not_configured`** · blocker — Customer.io has no push provider set up for this platform in the workspace (NoProviderConfigured).
  For an iOS app that gets its token from Firebase, the workspace has to send iOS pushes through Firebase; otherwise add the platform's push credential. Every send is refused until then. https://www.customer.io/docs/sdk/ios/push/
- **`send.api_failed`** · warning — Customer.io's API failed while sending the push, so nothing was proven.
  This is an error on Customer.io's side, not the app's, the token or the credential. Run again; if it repeats, report the error shown with the push.
- **`runtime.tap_lines_lost`** · warning — The tap reached the app, and the SDK's lines for it never reached the phone's log stream.
  This is unproven, not failed. A phone's log stream drops lines, most of all during the burst of a cold launch, so a tap the app handled can leave no trace in it. For a tap on a killed app the run watches the next pids the phone will hand out, so the app lands in a stream that is already reading; the cell's evidence says why that did not cover it (usually more processes starting at once than it watched). Run that state again: the run prints the command, and the report carries it as `rerunUnproven`.
- **`runtime.opened_recorded_link_unseen`** · warning — Customer.io recorded the open; where the tap went was in the lines the phone's log lost.
  The open is proven by Customer.io's own record of this push. The deep link's outcome only exists in the device's log, which dropped it, so run the state again to see it.
- **`runtime.cold_tap_not_handled`** · blocker — The tap started the app, and the SDK never handled it.
  iOS handed the tap to the app, and every line the app wrote from its first was read, so this is not a lost line. A tap that starts the app is delivered once, during launch, to the notification delegate in place by then; Apple's rule is that the delegate must be assigned before the app finishes launching. When taps on a running app pass and this one fails, the SDK is set up too late: initialize it, push module included, in the app delegate's launch method, not after a login, a screen appearing or an async load. https://www.customer.io/docs/sdk/ios/push/
- **`runtime.tap_other_push`** · warning — The open the SDK reported belongs to a different push than the one this run sent.
  Usually an older notification was tapped. Tap the one whose title ends in this run’s tag, as the prompt names it, or clear old notifications and run again.
- **`runtime.capture_stopped`** · warning — The device's log capture stopped partway through the run, so nothing after that could be read.
  This says nothing about the integration. Run again; if it repeats, unplug and replug the phone, and make sure nothing else (Console, another idevicesyslog) is reading its log.
- **`runtime.capture_silent`** · warning — Not one log line arrived after the tap, so this cell could not be judged.
  Either the tap did not reach the app, or the log stream stopped delivering. If the app opened when you tapped, it was the stream: on a phone, unplug and replug it; on a simulator, close any other log viewer attached to it. Then run again.
- **`runtime.deep_link_outcome_unseen`** · warning — The SDK reported the open and started following the deep link, but never said how it ended.
  The open itself is fine. Usually the app was moved on before the link finished: run the cell again and leave the app in front until the run continues. If it repeats, check that the deepLinkCallback returns once it has navigated.
- **`runtime.push_arrived_late`** · warning — The push arrived, but only after this run had stopped waiting for it.
  Delivery works; it was slow. An emulator or simulator that was just started or resumed from a snapshot can take minutes to reconnect to the push service, then delivers everything at once — run again once it has been up a few minutes. On a phone, check that battery saver and Doze are off.
- **`device.notifications_disabled`** · blocker — Nothing reached the app in any state, and iOS says the app's notifications aren't allowed.
  On the device, open Settings → Notifications, find the app by its display name, and allow notifications; then run again. With notifications off, iOS drops an alert push before the extension runs, which looks exactly like a broken extension.
- **`send.provider_rate_limited`** · blocker — The push provider refused the send as too frequent (429), so nothing was proven and the remaining states were not sent.
  Apple allows one APNs token change every 20 minutes, and on a workspace with more than one app each test send asks Apple for a new token, so sends close together come back TooManyProviderTokenUpdates. Pushes from campaigns and broadcasts reuse a cached token and are not affected. Wait 20 minutes and run again, or send a single state with --app-states killed.
- **`device.notifications_wedged`** · blocker — This target is not delivering notifications at all, so nothing was proven about the integration.
  Even a locally injected push did not display, though iOS did not say the app's notifications are off. Restart the simulator with the command shown with this finding, then run again. A simulator in this state accepts sends and silently drops every one of them, which reads exactly like a broken integration.
- **`runtime.opened_not_tracked`** · blocker — The notification was tapped and the SDK never reported the open.
  The click reached the SDK but no `opened` metric followed. Check that the app forwards notification responses to the SDK — on iOS that is `MessagingPush.shared.userNotificationCenter(_:didReceive:withCompletionHandler:)`, or the automatic swizzling being left enabled — and that the push carried a delivery id.
- **`runtime.opened_without_delivery_id`** · blocker — The tap reached the SDK, but the message carried no delivery id.
  The SDK logged a click with an empty deliveryId, so it cannot attribute the open to anything. This is a payload problem rather than an app one: verify the push was sent by Customer.io and not rebuilt by an intermediary.
- **`runtime.tap_not_ours`** · blocker — The SDK saw the tap and decided the notification was not a Customer.io one.
  The SDK logged "Clicked non CIO push message". Either another notification was tapped, or the payload lost its `CIO` block on the way — an intermediary that rebuilds the notification does exactly this.
- **`runtime.tap_not_seen`** · warning — Nothing about a tap reached the SDK, so nothing was proven.
  The tap did not arrive: the banner may have gone before it was tapped, or a different notification was tapped. Run the cell again and tap the notification whose title the run printed.
- **`runtime.banner_not_seen`** · warning — The push reached the device, and the person asked to tap it saw no banner.
  Delivery worked — the OS has the notification — so what is missing is the banner. Check that banners are on for the app and no Focus or Do Not Disturb is hiding them, and that the simulator window or the phone screen was in view. A banner shows for a few seconds and then lives only in Notification Centre, so look there too, and run the state again.
- **`runtime.tap_not_confirmed`** · warning — No tap was confirmed, so this cell proved nothing.
  The state was skipped at the prompt, or nobody answered it. `opened` cannot be verified without a tap — there is no way to synthesise one — so run it again when you can tap.
- **`runtime.deep_link_not_handled`** · blocker — The SDK reported the open, and the deep link went nowhere.
  Nothing could open the link: the app's deep link callback did not claim it, and no app on the device handles its scheme. Check the URL is one the app routes: a scheme it declares (CFBundleURLTypes on iOS, an intent filter on Android) or a universal or app link it handles, and that `deepLinkCallback` returns true once it has navigated.
- **`runtime.deep_link_back_to_app`** · warning — The deep link went back to the app through iOS, and where it went from there isn't logged.
  Nothing in the app claimed the link, so the SDK handed it to iOS ("Deep link handled by system"). Its scheme is the app's own, so iOS opened the app with it again, through the app or scene delegate's URL handler, and nothing logs whether that handler routed it: a link the app can't route lands here too. Check the screen the tap landed on. To have it proven, handle the link in `deepLinkCallback` and return true once you've navigated, so the SDK logs it as handled.
- **`runtime.deep_link_absent`** · warning — The SDK reported the open, but the push carried no deep link to follow.
  Nothing is wrong with the open. If the link was expected, remember that `is_rich: true` gates the entire CIO payload block: without it the link never reaches the device.
- **`runtime.push_never_arrived`** · blocker — The send was accepted and nothing reached the device at all.
  Look at the credential pairing and the token first, then the target's own link to its push service. A freshly booted iOS simulator lags minutes behind an accepted send, so try once more. An Android device can hold a dead connection to Firebase that still reports itself connected: turn its Wi-Fi off and on, or cold-boot the emulator, then run again.
- **`runtime.nse_did_not_run`** · blocker — The push arrived and the Notification Service Extension never ran on it.
  This is the invisible failure. The notification displays, the dashboard shows the provider accepted it, and no delivery is ever counted. Check the extension is embedded, entitled to the App Group, and forwarding to the SDK.
- **`runtime.push_not_seen`** · warning — Nothing on the phone showed this push arriving: the extension's process never logged, and the phone's log stream can drop lines.
  This is unproven, not failed: a phone has no notification list the tool can read, so the extension running is the only sign of arrival, and the stream that would show it loses lines. Check the banner appeared, that notifications are allowed for the app, and run again.
- **`runtime.push_not_handled`** · blocker — The notification is on the device, and the app's SDK never said it received the push.
  Something other than the SDK displayed it — usually FCM showing a notification message by itself while the app is in the background, so the SDK never sees the push and nothing is counted. Check that the app’s messaging service hands pushes to the SDK, and that the SDK log level is debug for this check. https://www.customer.io/docs/sdk/android/push/
- **`runtime.sdk_logging_off`** · warning — The app was plainly at work, and the Customer.io SDK did not write a single line during the run.
  The checks that need the SDK's account read its debug lines, so set the SDK's log level to debug in the build you are verifying — SDKConfigBuilder.logLevel(.debug) on iOS, CustomerIOBuilder.logLevel(CioLogLevel.DEBUG) on Android, or the logLevel option in the React Native or Flutter config — and run again. Arrival is still read from the OS either way.
- **`runtime.no_evidence`** · warning — The log was attached and the app said nothing at all, so this cell proves nothing.
  Suspect the capture, not the push: check the log tool is streaming (a filter that matches no process name returns silence), and that the app is the build you think it is. On a phone, make sure nothing else is reading its log (`pgrep -fl idevicesyslog` on the Mac): streams left running load the phone until its log stops delivering to anyone, and unplugging and replugging it resets the log relay. On Android, a React Native app started by a push runs no JavaScript, and its SDK gets its log level from CustomerIO.initialize there, so the SDK can handle a killed push without writing a line.
- **`runtime.app_state_not_set`** · warning — The app could not be put in this state, so no push was sent for it.
  The run launches, backgrounds or stops the app itself to reach each state, and the error is shown with the push. On a phone, keep it unlocked during the run (a locked phone will not launch an app) and verify a development build; on Android the app needs a launcher activity. Then run the state again.
- **`runtime.app_force_stopped`** · warning — The app was in Android's stopped state, which blocks delivery entirely — by design, not by defect.
  Launch the app once and re-run. Force-stopping from Settings (or `am force-stop`) puts an app in this state, and a push sent to it is never delivered: this is the single most common way Android push testing produces a false failure. `am kill` is the faithful "swiped away" case.
- **`runtime.delivery_id_mismatch`** · warning — The delivery the SDK reported is not the one this run sent.
  Usually an earlier push still in flight, so the cell proves less than it appears to. Re-run with the app quiet, and treat the timing as suspect if it repeats.

### Customer.io's record (`recorded`)

- **`backend.metric_not_recorded`** · warning — Customer.io had not recorded the device's report of this push when the tool stopped waiting.
  The SDK sends opens in batches of up to 30 seconds and retries a failed upload later, so a report can arrive after the wait: run that state again before acting on it. If it never arrives, the SDK is reporting somewhere else. It reports with the API key and region it was set up with, so a key from another workspace sends its reports there. On iOS, delivered comes from the notification service extension, which needs the same key as the app.
- **`backend.delivery_not_found`** · warning — Customer.io had no record under a delivery id its own send returned.
  A test push's record is kept for 24 hours and read from the workspace that sent it, so this run should always find it. Run again, and if it repeats, report it with the delivery id shown with the push.
- **`backend.record_unreadable`** · warning — Customer.io's record of the push could not be read.
  The error is shown with the push. The `cio` login needs permission to view deliveries in this workspace: check it with `cio auth status`, then run again.
