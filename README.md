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
   <summary>verify push: Prove that push works end to end, and name the step that breaks when it doesn't</summary>

   ## What It Does

   `verify push` checks an iOS or Android app's push setup, then sends real pushes and follows each one until the app receives it and, with a tap, opens it. When something breaks, it names the step and the fix. It catches failures a dashboard doesn't show: the push displays, but the app's notification extension never runs on it, or the SDK never handles the tap.

   1. **Preflight** (every run): project wiring, workspace, device, and profile, in that order. The first failure stops the run.
   2. **Real pushes** (with `--send`): one push per app state (killed, background, foreground), each followed until it reaches the device and the app handles it.
   3. **Opened** (with `--opened`): you tap the same push in the killed and background states, and the tool checks the SDK handled the open and the deep link. One push per state serves both checks.

   A pass means what the device showed: the push arrived and the app handled it, and for a tap, the SDK handled the open of that exact push. Arrival is read from the OS (the notification list, or the extension's own process) wherever it can be, and SDK log lines only where the OS has no answer. Whether Customer.io recorded the metric isn't checked: test pushes have no stored delivery to read back yet, so every cell reports `recorded: "not_checked"`.

   The SDK's push lines are debug lines, so the build you verify needs the SDK's log level set to debug. On a phone, the log stream can drop lines; a missing line there makes a cell inconclusive, never failed.

   ### Requirements

   - Node.js 20 or later.
   - The [Customer.io CLI](https://www.npmjs.com/package/@customerio/cli), logged in: `npm install -g @customerio/cli`, then `cio auth login`.
   - iOS: macOS with Xcode, and a booted simulator or a connected device. Reading a physical iPhone's logs also needs `idevicesyslog` (`brew install libimobiledevice`).
   - Android: `adb` (on your `PATH` or in the Android SDK) and a running emulator or connected device.
   - The app built and run on that target, with a logged-in user, so the SDK has registered a token.

   ## Usage

   Preflight only. Nothing is sent. The tool asks which workspace and target to use, and which app when the project builds several:

   ```bash
   npx cio-sdk-tools@latest verify push /path/to/project
   ```

   Send real pushes and follow them to delivered:

   ```bash
   npx cio-sdk-tools@latest verify push /path/to/project --send
   ```

   Before the first push, the tool shows the target, app, workspace, `cio` login, token prefix, and push count, then asks `Send 3 real pushes? (y/N)`. The default is no.

   Also verify opened and a deep link. This needs a tap per state, so it only runs in a terminal:

   ```bash
   npx cio-sdk-tools@latest verify push /path/to/project --opened --link myapp://some/screen
   ```

   Use a URL your app actually routes. Any other URL makes the SDK log "Deep link was not handled", which reads as a failure.

   ### In CI or a script

   Every question has a flag. A run that can't ask (`--non-interactive`, `--json`, or no terminal) exits with code 2 and names the flag it needs. Real pushes also need `--yes`:

   ```bash
   npx cio-sdk-tools@latest verify push /path/to/project --non-interactive --send --yes \
     --workspace WORKSPACE_ID --target SIMULATOR_NAME_UDID_OR_SERIAL
   ```

   `--json` prints only the report on stdout, with errors on stderr. `--report FILE` also writes the report to a file. `--dry-run` does everything except send.

   ### Exit Codes

   | Code | Meaning |
   |------|---------|
   | 0 | Everything checked passed. |
   | 1 | The tool itself failed. |
   | 2 | A flag is missing or wrong. The message names it. |
   | 20 | A check failed. The integration is broken, and the report names the cause and the fix. |
   | 21 | Nothing was proven, because something was skipped (for example, no `--send`). |

   ### Useful Options

   | Option | What it does |
   |--------|--------------|
   | `--workspace ID` | The workspace the app should report to. |
   | `--target NAME\|UDID\|SERIAL` | The simulator, device, or emulator to use. |
   | `--app-target NAME` / `--package ID` | The iOS app target, or the Android application id, when there are several. |
   | `--states killed` | Send one push instead of three. |
   | `--evidence DIR` | Keep the captured logs. |
   | `--observe` | Watch the install, token, and login happen, instead of reading what they left behind. |
   | `--verbose` / `--quiet` | Print every check and command, or only the verdict. |

   > **Note**
   >
   > On a workspace with more than one app, test sends close together can hit Apple's limit of one token change every 20 minutes (`429 TooManyProviderTokenUpdates`). The tool stops sending and says so. Wait 20 minutes, or send one state with `--states killed`.

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
