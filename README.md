# cio-sdk-tools

## ⚠️ Warning
This tool is a work in progress. For feedback or feature requests, [open an issue](https://github.com/customerio/cio-sdk-tools/issues/new). The tool aims to diagnose common integration scenarios, but advanced or custom implementations might require manual troubleshooting.

## What It Does
The tool assists in diagnosing and troubleshooting the Customer.io mobile SDK installations. It examines:

1. **Project Setup**: Recognizing your mobile framework, such as React Native.
2. **SDK Initialization**: Verification of the SDK's initiation within key project files.
3. **Library Conflicts**: Validation against any conflicting libraries in `package.json` and `Podfile`.
4. **Push Notification Setup**:
    - Validation of the presence and correct embedding of Notification Service Extensions.
    - Verification of deployment target versions to ensure compatibility with the CIO SDK.
    - Examination of `AppDelegate` to ensure correct metrics tracking for push notifications.
    - Checking entitlements for push notification capabilities and potential conflicts.
5. **Version Validation**: Consolidates and displays versions of key integrations like the Customer.io SDK in various configuration files.

## Installation
To install the tool:

```bash
npm install cio-sdk-tools -g
```

## Usage

### Doctor Command
To run the diagnostic tool:

```bash
npm run doctor
```
#### Arguments & Options
- `[path]`: Path to the project directory.
- `-v, --verbose`: Detailed output.
- `-r, --report <filename>`: Save report to a file.

Example:

```bash
npm run doctor -- /path/to/project -r diagnostics_report.txt
```

## Supported Frameworks
The tool caters to React Native, Flutter, and iOS Native applications.

## Package Managers
The tool currently recognizes:
- **Cocoapods**

(Note: Swift Package Manager (SPM) is not supported at this time.)

## Reporting Issues
Encounter problems or have suggestions? [Create an issue on GitHub](https://github.com/customerio/cio-sdk-tools/issues).

## License
MIT License. See `LICENSE` for details.