import * as path from 'path';
import {
  Conflicts,
  POD_MESSAGING_IN_APP,
  POD_MESSAGING_PUSH_APN,
  POD_MESSAGING_PUSH_FCM,
  POD_TRACKING,
} from '../constants';
import { Context, iOSProject } from '../core';
import {
  extractVersionFromPodLock,
  getReadablePath,
  logger,
  readAndParseXML,
  runCatching,
  searchFilesForCode,
  trimQuotes,
} from '../utils';

export async function runAllChecks(): Promise<void> {
  const context = Context.get();
  const project = context.project as iOSProject;

  await runCatching(analyzeNotificationServiceExtensionProperties)(project);
  await runCatching(validateUserNotificationCenterDelegate)(project);
  await runCatching(validateSDKInitialization)(project);
  await runCatching(validatePushEntitlements)(project);
  await runCatching(validateNoConflictingSDKs)(project);
  await runCatching(collectSummary)(project);
}

async function analyzeNotificationServiceExtensionProperties(
  project: iOSProject
): Promise<void> {
  for (const { file: projectFile, xcodeProject } of project.projectFiles) {
    logger.searching(`Checking project at path: ${projectFile.readablePath}`);
    const targets = xcodeProject.pbxNativeTargetSection();
    // Check for Notification Service Extension
    await validateNotificationServiceExtension(xcodeProject, project, targets);
  }
}

/**
 * Check if a Notification Service Extension is present and that there is only one.
 * @param {Object} targets - Targets from the Xcode project.
 */
//
async function validateNotificationServiceExtension(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  xcodeProject: any,
  project: iOSProject,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  targets: any[]
) {
  let extensionCount = 0;
  let isEmbedded = false;
  let isFoundationExtension = false;

  for (const name in targets) {
    const target = targets[name];

    // The following check ensures that we are dealing with a valid 'target' that is an app extension.
    // 'target' and 'target.productType' must exist (i.e., they are truthy).
    // We then remove any single or double quotes and any leading or trailing whitespace from 'target.productType'.
    // If it matches "com.apple.product-type.app-extension", we increment the 'extensionCount'.

    const productType: string | undefined = target?.productType;

    if (
      productType &&
      trimQuotes(productType) === 'com.apple.product-type.app-extension'
    ) {
      logger.progress(`Found app extension: ${target.name}`);

      const inferredDirectoryName =
        target.name || target.productReference_comment.replace('.appex', '');
      const possibleInfoPlistPath =
        `./${inferredDirectoryName}/Info.plist`.replace(/"/g, '');

      const infoPlistPath = path.join(
        project.iOSProjectPath,
        possibleInfoPlistPath
      );
      const infoPlistReadablePath = getReadablePath(
        project.projectPath,
        infoPlistPath
      );
      logger.searching(`Checking Info.plist at path: ${infoPlistReadablePath}`);
      const infoPlistContent = await readAndParseXML(infoPlistPath);

      // If the Info.plist content represents an NSE, process further
      if (isNotificationServiceExtension(infoPlistContent.plist.dict)) {
        logger.progress(`Found Notification app extension: ${target.name}`);
        extensionCount++;

        // Check for deployment target for NSE
        const deploymentTarget = getDeploymentTargetVersion(
          xcodeProject,
          target
        );
        logger.result(
          `Deployment Target Version for NSE: ${deploymentTarget}. Ensure this version is not higher than the iOS version of the devices where the app will be installed. A higher target version may prevent some features, like rich notifications, from working correctly.`
        );
      }
    }

    if (
      productType &&
      trimQuotes(productType) === 'com.apple.product-type.application'
    ) {
      logger.searching(
        `Checking if the NSE is embedded into target app: ${target.name}`
      );
      // Check if the target is listed in the Embed App Extensions build phase.
      if (
        target.buildPhases &&
        target.buildPhases.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (phase: any) => trimQuotes(phase.comment) === 'Embed App Extensions'
        )
      ) {
        isEmbedded = true;
      } else if (
        target.buildPhases &&
        target.buildPhases.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (phase: any) =>
            trimQuotes(phase.comment) === 'Embed Foundation Extensions'
        )
      ) {
        isFoundationExtension = true;
      }
    }
  }

  if (extensionCount > 1) {
    logger.failure(
      'Multiple Notification Service Extensions found. Only one should be present.'
    );
  } else if (extensionCount === 1) {
    if (isEmbedded) {
      logger.success('Notification Service Extension found and embedded.');
    } else if (isFoundationExtension) {
      logger.info(
        'Notification Service Extension found but not embedded as it is a Foundation Extension.'
      );
    } else {
      logger.failure('Notification Service Extension found but not embedded.');
    }
  } else {
    logger.failure('Notification Service Extension not found.');
  }
}

/**
 * Determine if the provided content represents a Notification Service Extension.
 *
 * The function checks the structure of the content to identify keys and values
 * that indicate the presence of a Notification Service Extension.
 *
 * Specifically, it checks for:
 * 1. The presence of the 'NSExtension' key.
 * 2. Inside the nested 'dict' structure, the presence of the 'NSExtensionPointIdentifier' key.
 * 3. The associated value of 'com.apple.usernotifications.service' for the 'NSExtensionPointIdentifier' key.
 *
 * @param content - The parsed content of the Info.plist for a target.
 * @returns - Returns true if the content indicates a Notification Service Extension, else false.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isNotificationServiceExtension(content: any) {
  // Check if 'NSExtension' is present as a key, accounting for both string and array type.
  const hasNSExtensionKey = Array.isArray(content.key)
    ? content.key.includes('NSExtension')
    : content.key === 'NSExtension';

  // Check if 'NSExtensionPointIdentifier' is present inside the nested dict, accounting for both string and array type.
  const hasNSExtensionPointIdentifier =
    content.dict && Array.isArray(content.dict.key)
      ? content.dict.key.includes('NSExtensionPointIdentifier')
      : content.dict.key === 'NSExtensionPointIdentifier';

  // Check if the value associated with 'NSExtensionPointIdentifier' is 'com.apple.usernotifications.service'.
  const hasUserNotificationsService =
    content.dict && Array.isArray(content.dict.string)
      ? content.dict.string.includes('com.apple.usernotifications.service')
      : content.dict.string === 'com.apple.usernotifications.service';

  // If all checks pass, return true; otherwise, return false.
  return (
    hasNSExtensionKey &&
    hasNSExtensionPointIdentifier &&
    hasUserNotificationsService
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getDeploymentTargetVersion(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pbxProject: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  notificationExtensionNativeTarget: any
) {
  const buildConfig = pbxProject.pbxXCBuildConfigurationSection();
  const configList = pbxProject.pbxXCConfigurationList();

  let nseBuildConfigKeys = [];

  // Find the NSE build configuration list key

  const productType: string | undefined =
    notificationExtensionNativeTarget?.productType;

  if (
    productType &&
    trimQuotes(productType) === 'com.apple.product-type.app-extension'
  ) {
    const configListKey =
      notificationExtensionNativeTarget.buildConfigurationList;
    const buildConfigurations = configList[configListKey].buildConfigurations;
    nseBuildConfigKeys = buildConfigurations.map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config: any) => config.value
    );
  }

  // Return deployment target of the NSE
  if (nseBuildConfigKeys.length) {
    for (const key in buildConfig) {
      const config = buildConfig[key];
      // Check if the config is the NSE build configuration and it has an iOS deployment target
      if (
        nseBuildConfigKeys.includes(key) &&
        config.buildSettings &&
        config.buildSettings['IPHONEOS_DEPLOYMENT_TARGET']
      ) {
        return config.buildSettings['IPHONEOS_DEPLOYMENT_TARGET'];
      }
    }
  }

  return null;
}

async function validateUserNotificationCenterDelegate(
  project: iOSProject
): Promise<void> {
  let allRequirementsMet = false;
  const userNotificationCenterPatternSwift =
    /func\s+userNotificationCenter\(\s*_[^:]*:\s*UNUserNotificationCenter,\s*didReceive[^:]*:\s*UNNotificationResponse,\s*withCompletionHandler[^:]*:\s*@?escaping\s*\(?\)?\s*->\s*Void\s*\)?/;
  const userNotificationCenterPatternObjC =
    /-\s*\(\s*void\s*\)\s*userNotificationCenter:\s*\(\s*UNUserNotificationCenter\s*\s*\*\s*\)\s*[^:]*\s*didReceiveNotificationResponse:\s*\(\s*UNNotificationResponse\s*\*\s*\)\s*[^:]*\s*withCompletionHandler:\s*\(\s*void\s*\(\s*\^\s*\)\(\s*void\s*\)\s*\)\s*[^;]*;?/;

  for (const appDelegateFile of project.appDelegateFiles) {
    logger.searching(
      `Checking AppDelegate at path: ${appDelegateFile.readablePath}`
    );
    const extension = appDelegateFile.args.get('extension');
    let pattern: RegExp;
    switch (extension) {
      case 'swift':
        pattern = userNotificationCenterPatternSwift;
        break;
      case 'Objective-C':
      case 'Objective-C++':
        pattern = userNotificationCenterPatternObjC;
        break;
      default:
        continue;
    }

    allRequirementsMet =
      allRequirementsMet || pattern.test(appDelegateFile.content!);
  }

  if (allRequirementsMet) {
    logger.success(
      `Found the method in AppDelegate required to track the "open" metric when a push notification is clicked.`
    );
  } else {
    logger.failure(
      `Didn't find the necessary method in AppDelegate to track the "open" metric when a push notification is clicked.`
    );
  }
}

async function validateSDKInitialization(project: iOSProject): Promise<void> {
  logger.searching(`Checking for SDK Initialization in iOS`);

  const sdkInitializationPattern = /CustomerIO\.initialize/;
  const sdkInitializationFiles = searchFilesForCode(
    {
      codePatternByExtension: {
        '.swift': sdkInitializationPattern,
        '.m': sdkInitializationPattern,
        '.mm': sdkInitializationPattern,
      },
      ignoreDirectories: ['Images.xcassets'],
      targetFileNames: ['AppDelegate'],
      targetFilePatterns: ['cio', 'customerio', 'notification', 'push'],
    },
    project.iOSProjectPath
  );

  if (sdkInitializationFiles !== undefined) {
    logger.success(`SDK Initialization found in ${sdkInitializationFiles}`);
  } else {
    logger.warning('SDK Initialization not found in suggested files');
  }
}

async function validatePushEntitlements(project: iOSProject): Promise<void> {
  let allRequirementsMet = false;
  const pushEnvPattern = /<key>\s*aps-environment\s*<\/key>/;

  for (const entitlementsFile of project.entitlementsFiles) {
    logger.searching(
      `Checking entitlements file at path: ${entitlementsFile.readablePath}`
    );
    allRequirementsMet =
      allRequirementsMet || pushEnvPattern.test(entitlementsFile.content!);
  }

  if (allRequirementsMet) {
    logger.success(`Push Notification capability found in entitlements`);
  } else {
    logger.failure(`Push Notification capability not found in entitlements`);
  }
}

async function validateNoConflictingSDKs(project: iOSProject): Promise<void> {
  if (!project.isUsingCocoaPods) {
    // Since we do not support SPM at the moment
    return;
  }

  const podfileLock = project.podfileLock;
  logger.searching(
    `Checking for conflicting libraries in: ${podfileLock.readablePath}`
  );
  const podfileLockContent = podfileLock.content;
  if (!podfileLockContent) {
    logger.failure(`No podfile.lock found at ${podfileLock.readablePath}`);
    return;
  }

  const conflictingPods = Conflicts.iosPods.filter((lib) =>
    podfileLockContent.includes(lib)
  );
  if (conflictingPods.length === 0) {
    logger.success('No conflicting pods found in Podfile');
  } else {
    logger.warning(
      'More than one pods found in Podfile for handling push notifications',
      conflictingPods
    );
  }
}

async function collectSummary(project: iOSProject): Promise<void> {
  if (project.isUsingCocoaPods) {
    await runCatching(extractPodVersions)(project);
  } else {
    project.summary.push(
      logger.formatter.warning(
        `No Podfile found at ${project.podfile.readablePath}. The project appears to be using Swift Package Manager (SPM).`
      )
    );
  }
}

async function extractPodVersions(project: iOSProject): Promise<void> {
  const podfileLock = project.podfileLock;
  const podfileLockContent = podfileLock.content;

  const validatePod = (
    podName: string
  ): { found: boolean; logs: logger.Log[] } => {
    let podVersions: string | undefined;
    const logs: logger.Log[] = [];

    if (podfileLockContent) {
      podVersions = extractVersionFromPodLock(podfileLockContent, podName);
      if (podVersions) {
        logs.push(
          logger.formatter.info(
            `${podName} version in ${podfileLock.readablePath} set to ${podVersions}`
          )
        );
      }
    }

    const found = podVersions !== undefined;
    if (!found) {
      logs.push(
        logger.formatter.failure(
          `${podName} not found in ${podfileLock.filename} at ${podfileLock.readablePath}`
        )
      );
    }
    return {
      found: found,
      logs: logs,
    };
  };

  const trackingPod = validatePod(POD_TRACKING);
  project.summary.push(...trackingPod.logs);
  const inAppMessagingPod = validatePod(POD_MESSAGING_IN_APP);
  project.summary.push(...inAppMessagingPod.logs);

  const pushMessagingAPNPod = validatePod(POD_MESSAGING_PUSH_APN);
  const pushMessagingFCMPod = validatePod(POD_MESSAGING_PUSH_FCM);
  if (pushMessagingAPNPod.found && pushMessagingFCMPod.found) {
    project.summary.push(
      logger.formatter.failure(
        `${POD_MESSAGING_PUSH_APN} and ${POD_MESSAGING_PUSH_FCM} found in ${podfileLock.filename} at ${podfileLock.readablePath}. Both cannot be used at a time, please use only one of them.`
      )
    );
  } else if (pushMessagingAPNPod.found) {
    project.summary.push(...pushMessagingAPNPod.logs);
  } else if (pushMessagingFCMPod.found) {
    project.summary.push(...pushMessagingFCMPod.logs);
  } else {
    project.summary.push(
      logger.formatter.warning(
        `None of ${POD_MESSAGING_PUSH_APN} or ${POD_MESSAGING_PUSH_FCM} found in ${podfileLock.filename} at ${podfileLock.readablePath}`
      )
    );
  }
}
