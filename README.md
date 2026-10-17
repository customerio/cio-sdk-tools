# cio-sdk-tools

[![npm version](https://img.shields.io/npm/v/cio-sdk-tools)](https://www.npmjs.com/package/cio-sdk-tools)
[![npm downloads](https://img.shields.io/npm/dm/cio-sdk-tools)](https://www.npmjs.com/package/cio-sdk-tools)

A collection of tools to assist in the integration of the Customer.io mobile SDKs.

## 🚧 This tool is a work in progress. 
For feedback or feature requests, [open an issue](https://github.com/customerio/cio-sdk-tools/issues/new).

## Available Commands
<details>
   <summary>doctor: Diagnose common scenarios when integrating the Customer.io mobile SDK</summary>

   ## What It Does
   The tool assists in diagnosing and troubleshooting the Customer.io mobile SDK installations. It examines:

   1. **Project Setup**: Recognizing your mobile framework, such as React Native.
   2. **SDK Initialization**: Verification of the SDK's initiation within key project files based on our setup guide recommendations.
   3. **Push Notification Setup**:
      - Validation of the presence and correct embedding of Notification Service Extensions.
      - Verification of deployment target versions to ensure compatibility with the CIO SDK.
      - Examination of `AppDelegate` to ensure correct metrics tracking for push notifications.
      - Checking entitlements for push notification capabilities and potential conflicts.
   4. **Dependencies**:
      - Validation against any conflicting libraries in `package.json`, `Podfile.lock`, and `Package.resolved`.
      - Consolidates and displays versions of key integrations like the Customer.io SDK in various configuration files.

   > **Warning**
   >
   > Advanced or custom implementations might require manual troubleshooting.
   >
   > The tool caters to React Native, Flutter, and iOS Native applications. If you're using a different framework, you can still use the tool to diagnose your iOS Native integration.
   >
   > The tool currently recognizes:
   > - **CocoaPods**
   > - **Swift Package Manager (SPM)**

   ### Learn More

   | Section                 | iOS                                                                                   | React Native                                                                                   | Flutter                                                                                   |
   |-------------------------|---------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------|
   | SDK Initialization      | [Read More](https://www.customer.io/docs/sdk/ios/getting-started/#initialize-the-sdk) | [Read More](https://www.customer.io/docs/sdk/react-native/getting-started/#initialize-the-sdk) | [Read More](https://www.customer.io/docs/sdk/flutter/getting-started/#initialize-the-sdk) |
   | Push Notification Setup | [Read More](https://www.customer.io/docs/sdk/ios/push/#rich-push)                     | [Read More](https://www.customer.io/docs/sdk/react-native/push-notifications/push/)            | [Read More](https://www.customer.io/docs/sdk/flutter/push-notifications/push/)            |


   ## Usage

   ### Doctor Command
   To run the diagnostic tool:

   ```bash
   npx cio-sdk-tools@latest doctor
   ```

   **Example**:

   Export Logs to Your Preferred Location:
   ```bash
   npx cio-sdk-tools@latest doctor /path/to/project --report diagnostics_report.txt
   ```
   View Additional Options:
   ```bash
   npx cio-sdk-tools@latest doctor /path/to/project --help
   ```

</details>

<details>
   <summary>send-push: Send a rich push notification to a specified device</summary>

   ## What It Does

   The tool assists in sending a rich push notification to a specified device.
   The rich notification contains an image to be able to test that the app is configured correctly to receive rich push notifications.
   Optionally, you can also send a deep link to test that the app handles those correctly.

   ## Usage

   **Example**:

   Using the native push provider for the related device platform:

   ```bash
   npx cio-sdk-tools@latest send-push --api-key API_KEY --token DEVICE_TOKEN --platform DEVICE_PLATFORM
   ```

   > Note: For `--api-key API_KEY`, this required an *App* API key. You can visit https://fly.customer.io/settings/api_credentials?keyType=app to get your API key.

   Specifying a deep link to be sent with the push notification:

   ```bash
   npx cio-sdk-tools@latest send-push --api-key API_KEY --token DEVICE_TOKEN --platform DEVICE_PLATFORM --deep-link DEEP_LINK
   ```

   > **Important**
   >
   > If you are using Firebase Cloud Messaging (FCM) on iOS as your push provider, you would need to use the `--provider` flag.

   Specifying provider when using FCM with iOS app:

   ```bash
   npx cio-sdk-tools@latest send-push --api-key API_KEY --token DEVICE_TOKEN --platform ios --provider fcm
   ```

   View Additional Options:

   ```bash
   npx cio-sdk-tools@latest send-push --help
   ```

</details>

<details>
   <summary>verify push: Prove that push works, and name the step that breaks when it doesn't</summary>

   ## What It Does

   `verify` proves a Customer.io SDK integration works, one area at a time. `push` is the first area; each area checks only what it needs, so `verify push` never looks at anything an app without push would lack.

   `verify push` checks an iOS or Android app's push setup, then sends real pushes and follows each one until the app receives it and, with a tap, opens it. When something breaks, it names the step and the fix. It catches failures a dashboard doesn't show: the push displays, but the app's notification extension never runs on it, or the SDK never handles the tap.

   `--depth` says how far to go:

   1. **`registration`**: project wiring, workspace, device, and profile, in that order. The first failure stops the run. Nothing is sent.
   2. **`on-device`**: registration, plus one real push per app state (killed, background, foreground), each followed until it reaches the device and the app handles it. With `--check-opens`, you tap the killed and background pushes and the tool checks the SDK handled the open, and the deep link when the push carries one.
   3. **`end-to-end`**: on-device, plus Customer.io recorded each push as delivered, and opened when tapped. It reads the record of each push from Customer.io once the last one is done.

   A pass at `on-device` means what the device showed: the push arrived and the app handled it, and for a tap, the SDK handled the open of that exact push. Arrival is read from the OS (the notification list, or the extension's own process) wherever it can be, and SDK log lines only where the OS has no answer. Each cell's `recorded` says whether Customer.io's record of it was read: `not_checked` unless it was.

   ### Customer.io's record

   A test push leaves a record only once Customer.io keeps test pushes for the workspace: the send then returns a delivery id, and the record holds when the device reported the push delivered and opened. Until then the sends return no id, so `end-to-end` has nothing to read: its record section is skipped with that reason, and the run ends unproven (exit 21), never passed.

   The SDK sends opens in batches of up to 30 seconds, so the tool waits up to 120 seconds for delivered and 150 seconds for opened, reading every push at once. A report still missing then is `backend.metric_not_recorded`, unproven rather than failed, because it can still arrive.

   The SDK's push lines are debug lines, so the build you verify needs the SDK's log level set to debug. On a phone, the log stream can drop lines; a missing line there makes a cell inconclusive, never failed.

   A tap on the push sent while the app was killed starts the app, and that launch is where a phone drops the most lines. So before asking for that tap, the tool opens streams for the next 8 process ids the phone will hand out, which the phone filters to one process each and does not drop, and moves them along as other processes start. The app lands in one that is already reading, so every line it writes is read, and a tap the SDK never handled is a failure (`runtime.cold_tap_not_handled`): usually the SDK set up after launch, where a tap that starts the app never reaches it. Lines from any other process that takes one of those ids are dropped unread. If the app lands outside them, the cell is judged as before. At any depth, a tap the log could not prove is then settled by Customer.io's record of the open, when the send returned a delivery id.

   ### Requirements

   - Node.js 20 or later.
   - The [Customer.io CLI](https://www.npmjs.com/package/@customerio/cli), logged in: `npm install -g @customerio/cli`, then `cio auth login`.
   - iOS: macOS with Xcode, and a booted simulator or a connected device. Reading a physical iPhone's logs also needs `idevicesyslog` (`brew install libimobiledevice`).
   - Android: `adb` (on your `PATH` or in the Android SDK) and a running emulator or connected device, with a debuggable build of the app: the tool reads the SDK's stored token with `run-as`.
   - The app built and run on that device, with a logged-in user, so the SDK has registered a token.

   ## Usage

   Run it with no options in a terminal and it asks for everything it needs: how far to go, which pushes, the workspace, and the device when more than one is connected. It ends by printing the command that repeats the run without a question:

   ```bash
   npx cio-sdk-tools@latest verify push /path/to/project
   ```

   Send real pushes, and tap them to check opens and a deep link:

   ```bash
   npx cio-sdk-tools@latest verify push /path/to/project --depth on-device \
     --check-opens --deep-link myapp://some/screen
   ```

   Use a deep link your app actually routes. A link nothing on the device can open fails the tap. On iOS, a link on the app's own scheme that the app's deep link callback doesn't claim goes back to the app through iOS, and nothing logs whether the app routed it, so that tap is reported as a warning rather than a pass. Without `--deep-link` the open is still checked.

   ### Sending real pushes

   Pushes go out without a question when `--depth`, `--workspace`, and `--device` are all on the command line: naming where they go is the go-ahead. If the run picked any of them itself, it shows the device, app, workspace, `cio` login, token prefix, and push count, then asks `Send 3 real pushes?` with two answers to pick with the arrow keys. The cursor starts on no, so Enter alone sends nothing.

   ### In CI or a script

   Every question has a flag. A run that can't ask (`--non-interactive`, `--json`, or no terminal) exits with code 2 and names the flag it needs. A run that sends must name the workspace and the device:

   ```bash
   npx cio-sdk-tools@latest verify push /path/to/project --depth on-device --json \
     --workspace WORKSPACE_ID --device SIMULATOR_NAME_UDID_OR_SERIAL > verify.json
   ```

   `--json` prints only the report on stdout, with errors on stderr. `--report FILE` also writes the report to a file. `--dry-run` does everything except send. The report carries `area`, `level`, `project` (`platform`, `framework`), the `verdict` and `exitCode`, its sections in order with the checks and pushes that didn't pass, each with a `cause` and, when the fix needs a value, a `detail`, then `causes` with each cause's `summary` and `remedy`, and, when a check couldn't be proven either way, `rerunUnproven`, the command that tries only those app states again.

   ### Output

   The output says what passed, what didn't, why, and what to change. The evidence behind each finding (log lines, file paths, delivery ids, timings, the commands the tool ran) is left out unless you add `--verbose`, on screen and in `--json` and `--report`, which then carry the full report. The device logs a run captures are deleted when it ends, unless you pass `--verbose` or `--evidence-dir`.

   ### For agents

   - Ask the person before a run that sends, then name `--depth`, `--workspace`, and `--device`: naming all three is the go-ahead to send real pushes, and a run missing one exits with code 2 and names it.
   - Read `--json` from stdout and the exit code. Key on `causes[].code`; act on `remedy`, using the `detail` on the check or push it came from.
   - Verify a fresh install: after integrating, delete the app, install it, launch it, log in, and answer the notification prompt, then run. A reinstall over an old build keeps its notification permission and registration, which can pass checks a new install would fail.
   - Run `rerunUnproven` when the exit code is 21. Add `--verbose` only to debug the tool itself.

   ### Exit Codes

   | Code | Meaning |
   |------|---------|
   | 0 | Everything asked for passed. |
   | 1, 3, 4, 5 | The tool couldn't run (an error, the login, a permission, the API). |
   | 2 | A flag is missing or wrong. The message names it. |
   | 20 | A check failed. The integration is broken, and the report names the cause and the fix. |
   | 21 | Nothing failed, but something asked for couldn't be proven. |

   ### Useful Options

   | Option | What it does |
   |--------|--------------|
   | `--workspace ID` | The workspace the app should report to. |
   | `-d, --device NAME\|UDID\|SERIAL` | The simulator, phone, or emulator to use. |
   | `--ios-target NAME` / `--android-app-id ID` | The iOS app target, or the Android application id, when there are several. |
   | `--app-states killed` | Send one push instead of three. |
   | `--evidence-dir DIR` | Keep the captured logs and screenshots here. |
   | `--watch-registration` | Watch the install, token, and login happen, instead of reading what they left behind. |
   | `--cio-profile NAME` | The `cio` CLI login to use. |
   | `--verbose` / `--quiet` | Print every check, command, and the evidence behind them, and keep the device logs; or print only the verdict. |

   > **Note**
   >
   > On a workspace with more than one app, test sends close together can hit Apple's limit of one token change every 20 minutes (`429 TooManyProviderTokenUpdates`). The tool stops sending and says so. Wait 20 minutes, or send one state with `--app-states killed`.
   >
   > A simulator can lose its connection to Apple's push servers and not get it back. Apple still accepts every send, and nothing arrives. The tool reads the simulator's push service log: when it is offline, nothing is sent (or, if it drops mid-run, the push is marked unproven, not failed), and the fix is to restart the simulator. The link can also go stale while the log still reports it connected, so a run that sends to a simulator says at the start to restart it if a push doesn't arrive.

   View all options:

   ```bash
   npx cio-sdk-tools@latest verify push --help
   ```

</details>

## Reporting Issues
Encounter problems or have suggestions? [Create an issue on GitHub](https://github.com/customerio/cio-sdk-tools/issues).

## License
MIT License. See `LICENSE` for details.

## Contributing
We value an open, welcoming, diverse, inclusive, and healthy community for this project. We expect all contributors to follow [code of conduct](CODE_OF_CONDUCT.md).
