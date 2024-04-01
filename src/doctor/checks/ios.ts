import * as path from 'path';
import {
  Conflicts,
  POD_MESSAGING_IN_APP,
  POD_MESSAGING_PUSH_APN,
  POD_MESSAGING_PUSH_FCM,
  POD_TRACKING,
  iOS_DEPLOYMENT_TARGET_MIN_REQUIRED,
} from '../constants';
import { Context, iOSProject } from '../core';
import { CheckGroup } from '../types';
import {
  extractVersionFromPodLock,
  getReadablePath,
  logger,
  readAndParseXML,
  runCatching,
  searchFilesForCode,
  trimQuotes,
} from '../utils';

export async function runChecks(group: CheckGroup): Promise<void> {
  const context = Context.get();
  const project = context.project as iOSProject;

  switch (group) {
    case CheckGroup.Diagnostics:
      // Get deployment target version;
      break;

    case CheckGroup.Initialization:
      await runCatching(validateSDKInitialization)(project);
      break;

    case CheckGroup.PushSetup:
      await runCatching(validatePushEntitlements)(project);
      await runCatching(analyzeNotificationServiceExtensionProperties)(project);
      await runCatching(validateMessagingPushInitialization)(project);
      break;

    case CheckGroup.Dependencies:
      await runCatching(validateNoConflictingSDKs)(project);
      await runCatching(validateDependencies)(project);
      break;
  }
}

async function analyzeNotificationServiceExtensionProperties(
  project: iOSProject
): Promise<void> {
  for (const { file: projectFile, xcodeProject } of project.projectFiles) {
    logger.debug(`Checking project at path: ${projectFile.readablePath}`);
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
      logger.debug(`Found app extension: ${target.name}`);

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
      logger.success(`NSE info.plist file found at ${infoPlistReadablePath}`);
      const infoPlistContent = await readAndParseXML(infoPlistPath);

      // If the Info.plist content represents an NSE, process further
      if (isNotificationServiceExtension(infoPlistContent.plist.dict)) {
        logger.success(`NSE is embedded in target app: ${target.name}`);
        extensionCount++;

        // Check for deployment target for NSE
        const deploymentTargetString = getDeploymentTargetVersion(
          xcodeProject,
          target
        );
        const deploymentTarget = parseFloat(deploymentTargetString);
        if (
          !isNaN(deploymentTarget) &&
          deploymentTarget >= iOS_DEPLOYMENT_TARGET_MIN_REQUIRED
        ) {
          logger.success(`Deployment Target for NSE: ${deploymentTarget}`);
        } else {
          logger.failure(`Deployment Target for NSE: ${deploymentTarget}`);
          logger.error(
            `The SDK requires an iOS deployment target of ${iOS_DEPLOYMENT_TARGET_MIN_REQUIRED} or higher.`
          );
        }
      }
    }

    if (
      productType &&
      trimQuotes(productType) === 'com.apple.product-type.application'
    ) {
      logger.debug(
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
      logger.success('Notification Service Extension (NSE) found');
    } else if (isFoundationExtension) {
      logger.success(
        'Notification Service Extension (NSE) found but not embedded as it is a Foundation Extension'
      );
    } else {
      logger.failure(
        'Notification Service Extension (NSE) found but not embedded'
      );
      logger.error(
        'The Notification Service Extension should be embedded in order to display and track push notifications.'
      );
    }
  } else {
    logger.failure('Notification Service Extension (NSE) not found');
    logger.error(
      'The Notification Service Extension is required in order to display and track push notifications.'
    );
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

async function validateMessagingPushInitialization(
  project: iOSProject
): Promise<void> {
  logger.debug(`Checking for MessagingPush Initialization in iOS`);

  // Search for any of the following patterns in the project files:
  // - MessagingPush.initialize
  // - MessagingPushAPN.initialize
  // - MessagingPushFCM.initialize
  const moduleInitializationPattern = /MessagingPush\w*\.initialize/;
  const moduleInitializationFiles = searchFilesForCode(
    {
      codePatternByExtension: {
        '.swift': moduleInitializationPattern,
        '.m': moduleInitializationPattern,
        '.mm': moduleInitializationPattern,
      },
      ignoreDirectories: ['Images.xcassets'],
      targetFileNames: ['AppDelegate'],
      targetFilePatterns: ['cio', 'customerio', 'notification', 'push'],
    },
    project.iOSProjectPath
  );

  if (moduleInitializationFiles.matchedFiles.length > 0) {
    logger.success(
      `MessagingPush Initialization found in ${moduleInitializationFiles.formattedMatchedFiles}`
    );
  } else {
    logger.debug(`Search Criteria:`);
    logger.debug(
      `Searching files with names: ${moduleInitializationFiles.formattedTargetFileNames}`
    );
    logger.debug(
      `Searching files with keywords: ${moduleInitializationFiles.formattedTargetPatterns}`
    );
    logger.debug(
      `Looked into the following files: ${moduleInitializationFiles.formattedSearchedFiles}`
    );
    if (logger.isDebug()) {
      logger.failure('MessagingPush Module Initialization not found');
    } else {
      logger.failure(
        'MessagingPush Module Initialization not found. For more details, run the script with the -v flag'
      );
    }
  }
}

async function validateSDKInitialization(project: iOSProject): Promise<void> {
  logger.debug(`Checking for SDK Initialization in iOS`);

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

  if (sdkInitializationFiles.matchedFiles.length > 0) {
    logger.success(
      `iOS SDK Initialization found in ${sdkInitializationFiles.formattedMatchedFiles}`
    );
  } else {
    logger.debug(`Search Criteria:`);
    logger.debug(
      `Searching files with names: ${sdkInitializationFiles.formattedTargetFileNames}`
    );
    logger.debug(
      `Searching files with keywords: ${sdkInitializationFiles.formattedTargetPatterns}`
    );
    logger.debug(
      `Looked into the following files: ${sdkInitializationFiles.formattedSearchedFiles}`
    );
    if (logger.isDebug()) {
      logger.failure('iOS SDK Initialization not found');
    } else {
      logger.failure(
        'iOS SDK Initialization not found. For more details, run the script with the -v flag'
      );
    }
  }
}

async function validatePushEntitlements(project: iOSProject): Promise<void> {
  let allRequirementsMet = false;
  const pushEnvPattern = /<key>\s*aps-environment\s*<\/key>/;

  for (const entitlementsFile of project.entitlementsFiles) {
    logger.debug(
      `Checking entitlements file at path: ${entitlementsFile.readablePath}`
    );
    allRequirementsMet =
      allRequirementsMet || pushEnvPattern.test(entitlementsFile.content!);
  }

  if (allRequirementsMet) {
    logger.success(`Push notification capability found in entitlements`);
  } else {
    logger.failure(`Push notification capability not found in entitlements`);
    logger.error(
      `The push notification capability is not enabled in your app.`
    );
  }
}

async function validateNoConflictingSDKs(project: iOSProject): Promise<void> {
  if (!project.isUsingCocoaPods) {
    // Since we do not support SPM at the moment
    return;
  }

  const podfileLock = project.podfileLock;
  logger.debug(
    `Checking for conflicting libraries in: ${podfileLock.readablePath}`
  );
  const podfileLockContent = podfileLock.content;
  if (!podfileLockContent) {
    logger.error(`No Podfile.lock found at ${podfileLock.readablePath}`);
    return;
  }

  const conflictingPods = Conflicts.iosPods.filter((lib) =>
    podfileLockContent.includes(lib)
  );
  if (conflictingPods.length === 0) {
    logger.success('No conflicting pods found');
  } else {
    logger.warning('Potential conflicting libraries found.');
    logger.alert(
      `It seems that your app is using multiple push messaging libraries (${conflictingPods}).` +
        ` We're continuing to improve support for multiple libraries, but there are some limitations.` +
        ` Learn more at: ${project.documentation.multiplePushProviders}`
    );
  }
}

async function validateDependencies(project: iOSProject): Promise<void> {
  if (project.isUsingCocoaPods) {
    await runCatching(extractPodVersions)(project);
  } else {
    logger.warning(
      `No Podfile found at ${project.podfile.readablePath}. The project appears to be using Swift Package Manager (SPM).`
    );
  }
}

async function extractPodVersions(project: iOSProject): Promise<void> {
  const podfileLock = project.podfileLock;
  const podfileLockContent = podfileLock.content;

  const validatePod = (podName: string, optional: boolean = false): boolean => {
    let podVersions: string | undefined;
    if (podfileLockContent) {
      podVersions = extractVersionFromPodLock(podfileLockContent, podName);
    }

    if (podVersions) {
      logger.success(`${podName}: ${podVersions}`);
    } else if (!optional) {
      logger.failure(`${podName} module not found`);
    }
    return podVersions !== undefined;
  };

  validatePod(POD_TRACKING);
  validatePod(POD_MESSAGING_IN_APP);

  const pushMessagingAPNPod = validatePod(POD_MESSAGING_PUSH_APN, true);
  const pushMessagingFCMPod = validatePod(POD_MESSAGING_PUSH_FCM, true);

  if (pushMessagingAPNPod && pushMessagingFCMPod) {
    logger.error(
      `${POD_MESSAGING_PUSH_APN} and ${POD_MESSAGING_PUSH_FCM} modules found. Both cannot be used at a time, please use only one of them.`
    );
  }
}
