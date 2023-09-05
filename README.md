# cio-sdk-tools

## 🚧 This tool is a work in progress. 
For feedback or feature requests, [open an issue](https://github.com/customerio/cio-sdk-tools/issues/new). The tool aims to diagnose common scenarios when integrating the Customer.io mobile SDK in your mobile app. Keep in mind that advanced or custom implementations might require manual troubleshooting.

The tool caters to React Native, Flutter, and iOS Native applications. If you're using a different framework, you can still use the tool to diagnose your iOS Native integration.

The tool currently recognizes:
- **Cocoapods**

(Note: Swift Package Manager (SPM) is not supported at this time.)


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

### Learn More

| Section                | iOS                             | React Native                       | Flutter                         |
|------------------------|---------------------------------|------------------------------------|---------------------------------|
| SDK Initialization     | [Read More](https://www.customer.io/docs/sdk/ios/getting-started/#initialize-the-sdk) | [Read More](https://www.customer.io/docs/sdk/react-native/getting-started/#initialize-the-sdk) | [Read More](https://www.customer.io/docs/sdk/flutter/getting-started/#initialize-the-sdk) |
| Push Notification Setup| [Read More](https://www.customer.io/docs/sdk/ios/push/#rich-push) | [Read More](https://www.customer.io/docs/sdk/react-native/push-notifications/push/) | [Read More](https://www.customer.io/docs/sdk/flutter/push-notifications/push/) |


## Usage

### Doctor Command
To run the diagnostic tool:

```bash
npx cio-sdk-tools@latest doctor
```

**Example**:

Export Logs to Your Preferred Location:
```bash
npx cio-sdk-tools doctor@latest /path/to/project --report diagnostics_report.txt
```
View Additional Options:
```bash
npx cio-sdk-tools@latest doctor /path/to/project --help
```

## Reporting Issues
Encounter problems or have suggestions? [Create an issue on GitHub](https://github.com/customerio/cio-sdk-tools/issues).

## License
MIT License. See `LICENSE` for details.

## Contributing
We value an open, welcoming, diverse, inclusive, and healthy community for this project. We expect all contributors to follow [code of conduct](CODE_OF_CONDUCT.md).
