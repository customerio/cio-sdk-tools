# cio-sdk-tools

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
      - Validation against any conflicting libraries in `package.json` and `Podfile` for now.
      - Consolidates and displays versions of key integrations like the Customer.io SDK in various configuration files.

   > **Warning**
   >
   > Advanced or custom implementations might require manual troubleshooting.
   >
   > The tool caters to React Native, Flutter, and iOS Native applications. If you're using a different framework, you can still use the tool to diagnose your iOS Native integration.
   >
   > The tool currently recognizes:
   > - **Cocoapods**
   >
   > (Note: Swift Package Manager (SPM) is not supported at this time.)

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

## Reporting Issues
Encounter problems or have suggestions? [Create an issue on GitHub](https://github.com/customerio/cio-sdk-tools/issues).

## License
MIT License. See `LICENSE` for details.

## Contributing
We value an open, welcoming, diverse, inclusive, and healthy community for this project. We expect all contributors to follow [code of conduct](CODE_OF_CONDUCT.md).
