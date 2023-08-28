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
npx cio-sdk-tools doctor
```

**Example**:

Export Logs to Your Preferred Location:
```bash
npx cio-sdk-tools doctor /path/to/project -r diagnostics_report.txt
```
View Additional Options:
```bash
npx cio-sdk-tools doctor /path/to/project -h
```

## Reporting Issues
Encounter problems or have suggestions? [Create an issue on GitHub](https://github.com/customerio/cio-sdk-tools/issues).

## License
MIT License. See `LICENSE` for details.


# Contributor Covenant Code of Conduct

## Our Pledge

We as members, contributors, and leaders pledge to make participation in our
community a harassment-free experience for everyone, regardless of age, body
size, visible or invisible disability, ethnicity, sex characteristics, gender
identity and expression, level of experience, education, socio-economic status,
nationality, personal appearance, race, caste, color, religion, or sexual
identity and orientation.

We pledge to act and interact in ways that contribute to an open, welcoming,
diverse, inclusive, and healthy community.

## Our Standards

Examples of behavior that contributes to a positive environment for our
community include:

* Demonstrating empathy and kindness toward other people
* Being respectful of differing opinions, viewpoints, and experiences
* Giving and gracefully accepting constructive feedback
* Accepting responsibility and apologizing to those affected by our mistakes,
  and learning from the experience
* Focusing on what is best not just for us as individuals, but for the overall
  community

Examples of unacceptable behavior include:

* The use of sexualized language or imagery, and sexual attention or advances of
  any kind
* Trolling, insulting or derogatory comments, and personal or political attacks
* Public or private harassment
* Publishing others' private information, such as a physical or email address,
  without their explicit permission
* Other conduct which could reasonably be considered inappropriate in a
  professional setting

## Enforcement Responsibilities

Community leaders are responsible for clarifying and enforcing our standards of
acceptable behavior and will take appropriate and fair corrective action in
response to any behavior that they deem inappropriate, threatening, offensive,
or harmful.

Community leaders have the right and responsibility to remove, edit, or reject
comments, commits, code, wiki edits, issues, and other contributions that are
not aligned to this Code of Conduct, and will communicate reasons for moderation
decisions when appropriate.

## Scope

This Code of Conduct applies within all community spaces, and also applies when
an individual is officially representing the community in public spaces.
Examples of representing our community include using an official e-mail address,
posting via an official social media account, or acting as an appointed
representative at an online or offline event.

## Enforcement

Instances of abusive, harassing, or otherwise unacceptable behavior may be
reported to the community leaders responsible for enforcement at
[INSERT CONTACT METHOD].
All complaints will be reviewed and investigated promptly and fairly.

All community leaders are obligated to respect the privacy and security of the
reporter of any incident.

## Enforcement Guidelines

Community leaders will follow these Community Impact Guidelines in determining
the consequences for any action they deem in violation of this Code of Conduct:

### 1. Correction

**Community Impact**: Use of inappropriate language or other behavior deemed
unprofessional or unwelcome in the community.

**Consequence**: A private, written warning from community leaders, providing
clarity around the nature of the violation and an explanation of why the
behavior was inappropriate. A public apology may be requested.

### 2. Warning

**Community Impact**: A violation through a single incident or series of
actions.

**Consequence**: A warning with consequences for continued behavior. No
interaction with the people involved, including unsolicited interaction with
those enforcing the Code of Conduct, for a specified period of time. This
includes avoiding interactions in community spaces as well as external channels
like social media. Violating these terms may lead to a temporary or permanent
ban.

### 3. Temporary Ban

**Community Impact**: A serious violation of community standards, including
sustained inappropriate behavior.

**Consequence**: A temporary ban from any sort of interaction or public
communication with the community for a specified period of time. No public or
private interaction with the people involved, including unsolicited interaction
with those enforcing the Code of Conduct, is allowed during this period.
Violating these terms may lead to a permanent ban.

### 4. Permanent Ban

**Community Impact**: Demonstrating a pattern of violation of community
standards, including sustained inappropriate behavior, harassment of an
individual, or aggression toward or disparagement of classes of individuals.

**Consequence**: A permanent ban from any sort of public interaction within the
community.

## Attribution

This Code of Conduct is adapted from the [Contributor Covenant][homepage],
version 2.1, available at
[https://www.contributor-covenant.org/version/2/1/code_of_conduct.html][v2.1].

Community Impact Guidelines were inspired by
[Mozilla's code of conduct enforcement ladder][Mozilla CoC].

For answers to common questions about this code of conduct, see the FAQ at
[https://www.contributor-covenant.org/faq][FAQ]. Translations are available at
[https://www.contributor-covenant.org/translations][translations].

[homepage]: https://www.contributor-covenant.org
[v2.1]: https://www.contributor-covenant.org/version/2/1/code_of_conduct.html
[Mozilla CoC]: https://github.com/mozilla/diversity
[FAQ]: https://www.contributor-covenant.org/faq
[translations]: https://www.contributor-covenant.org/translations
