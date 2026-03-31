import * as path from 'path';
import {
  Conflicts,
  POD_DATA_PIPELINE,
  POD_MESSAGING_IN_APP,
  POD_MESSAGING_PUSH_APN,
  POD_MESSAGING_PUSH_FCM,
  SPM_PACKAGE_IDENTITY,
  SPM_DATA_PIPELINE,
  SPM_MESSAGING_IN_APP,
  SPM_MESSAGING_PUSH_APN,
  SPM_MESSAGING_PUSH_FCM,
  iOS_DEPLOYMENT_TARGET_MIN_REQUIRED,
  iOS_SDK_PUSH_SWIZZLE_VERSION,
} from '../constants';
import { Context, iOSProject } from '../core';
import { CheckGroup } from '../types';
import {
  compareSemanticVersions,
  extractSemanticVersion,
  extractVersionFromPodLock,
  extractModuleVersionFromPackageResolved,
  getReadablePath,
  logger,
  readAndParseXML,
  runCatching,
  searchFilesForCode,
  trimQuotes,
} from '../utils';
import { doesExists } from '../utils/file';

// Common search configurations for AppDelegate files
const APP_DELEGATE_BASE_CONFIG = {
  ignoreDirectories: ['Images.xcassets'],
  targetFileNames: ['AppDelegate'],
};

const SDK_INIT_SEARCH_CONFIG = {
  ...APP_DELEGATE_BASE_CONFIG,
  targetFilePatterns: ['cio', 'customerio'],
};

const PUSH_INIT_SEARCH_CONFIG = {
  ...APP_DELEGATE_BASE_CONFIG,
  targetFilePatterns: ['cio', 'customerio', 'notification', 'push'],
};

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
      const directoryPath = path.join(
        project.iOSProjectPath,
        inferredDirectoryName.replace(/"/g, '')
      );

      // Try common Info.plist naming patterns
      const possibleInfoPlistNames = [
        'Info.plist',
        `${inferredDirectoryName.replace(/"/g, '')}-Info.plist`,
      ];

      let infoPlistPath: string | undefined;
      let infoPlistContent;

      for (const plistName of possibleInfoPlistNames) {
        const candidatePath = path.join(directoryPath, plistName);
        if (doesExists(candidatePath)) {
          infoPlistPath = candidatePath;
          infoPlistContent = await readAndParseXML(infoPlistPath);
          if (infoPlistContent) {
            break;
          }
        }
      }

      if (!infoPlistPath || !infoPlistContent || !infoPlistContent.plist) {
        logger.debug(
          `Could not find or parse Info.plist for extension: ${inferredDirectoryName}`
        );
        continue;
      }

      const infoPlistReadablePath = getReadablePath(
        project.projectPath,
        infoPlistPath
      );
      logger.success(`NSE info.plist file found at ${infoPlistReadablePath}`);

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
      // Check if the target has an embedding build phase for extensions
      if (target.buildPhases) {
        // buildPhases is an array of objects with 'value' being the phase UUID and 'comment' being the phase name
        // We need to look up the actual phase object from xcodeProject.pbxCopyFilesBuildPhaseSection
        // Access all copy files build phases
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const copyFilesPhases = (xcodeProject as any).hash.project.objects[
          'PBXCopyFilesBuildPhase'
        ];

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        target.buildPhases.forEach((phaseRef: any) => {
          const comment = trimQuotes(phaseRef.comment || '');
          const phaseUuid = phaseRef.value;

          // Check for named embed phases by comment
          if (comment === 'Embed App Extensions') {
            isEmbedded = true;
            return;
          }
          if (comment === 'Embed Foundation Extensions') {
            isFoundationExtension = true;
            return;
          }

          // Check if this phase is a Copy Files phase with dstSubfolderSpec = 13 (PlugIns folder)
          // This is how Expo and some other tools embed extensions
          if (copyFilesPhases && copyFilesPhases[phaseUuid]) {
            const phase = copyFilesPhases[phaseUuid];
            // dstSubfolderSpec 13 is the Xcode constant for PlugIns folder (where app extensions are embedded)
            if (Number(phase.dstSubfolderSpec) === 13) {
              isEmbedded = true;
            }
          }
        });
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
      ...PUSH_INIT_SEARCH_CONFIG,
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

  const isNativeIOS = project.framework === 'iOS';
  const nativeInitPattern = /CustomerIO\.initialize/;
  const appDelegateWrapperPattern = /CioAppDelegateWrapper/;
  const pushInitPattern = /MessagingPush\w*\.initialize/;

  // Check for CustomerIO.initialize (native initialization)
  const nativeInitFiles = searchFilesForCode(
    {
      codePatternByExtension: {
        '.swift': nativeInitPattern,
        '.m': nativeInitPattern,
        '.mm': nativeInitPattern,
      },
      ...SDK_INIT_SEARCH_CONFIG,
    },
    project.iOSProjectPath
  );

  // Check for CioAppDelegateWrapper (recommended pattern for all iOS apps)
  const appDelegateWrapperFiles = searchFilesForCode(
    {
      codePatternByExtension: {
        '.swift': appDelegateWrapperPattern,
      },
      ...SDK_INIT_SEARCH_CONFIG,
    },
    project.iOSProjectPath
  );

  // Check for MessagingPush initialization (legacy push pattern)
  const pushInitFiles = searchFilesForCode(
    {
      codePatternByExtension: {
        '.swift': pushInitPattern,
        '.m': pushInitPattern,
        '.mm': pushInitPattern,
      },
      ...PUSH_INIT_SEARCH_CONFIG,
    },
    project.iOSProjectPath
  );

  const foundNativeInit = nativeInitFiles.matchedFiles.length > 0;
  const foundAppDelegateWrapper =
    appDelegateWrapperFiles.matchedFiles.length > 0;
  const foundPushInit = pushInitFiles.matchedFiles.length > 0;

  // CustomerIO.initialize check
  if (foundNativeInit) {
    logger.success(
      `CustomerIO.initialize found in ${nativeInitFiles.formattedMatchedFiles}`
    );
  } else if (isNativeIOS) {
    // Required for native iOS
    logger.failure('CustomerIO.initialize not found');
    logger.error(
      'Native iOS apps must call CustomerIO.initialize in AppDelegate'
    );
  }
  // Optional for wrapper frameworks (they initialize in JS/Dart/Flutter) - no warning needed

  // CioAppDelegateWrapper check (recommended for all iOS apps)
  if (foundAppDelegateWrapper) {
    logger.success(
      `CioAppDelegateWrapper found in ${appDelegateWrapperFiles.formattedMatchedFiles}`
    );
  } else if (foundPushInit) {
    // Using legacy push initialization pattern
    logger.warning('CioAppDelegateWrapper not found');
    logger.alert(
      'Consider migrating to CioAppDelegateWrapper for simplified push notification setup. See the documentation for migration guides.'
    );
  } else {
    // No push setup detected
    logger.debug(
      'Neither CioAppDelegateWrapper nor MessagingPush initialization found'
    );
  }

  // Note: MessagingPush initialization is checked and logged in validateMessagingPushInitialization
  // during the PushSetup group. The foundPushInit variable here is used only for the
  // CioAppDelegateWrapper recommendation logic above.
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
  // Check conflicts in both package managers if present
  // Projects can use both SPM and CocoaPods for different dependencies

  if (project.isUsingSPM) {
    const packageResolved = project.packageResolved;
    logger.debug(
      `Checking for conflicting libraries in: ${packageResolved.readablePath}`
    );
    const packageResolvedContent = packageResolved.content;
    if (packageResolvedContent) {
      const conflictingPackages = Conflicts.iosSPMPackages.filter((lib) =>
        packageResolvedContent.includes(lib)
      );
      if (conflictingPackages.length === 0) {
        logger.success('No conflicting SPM packages found');
      } else {
        logger.warning(
          'Potential conflicting libraries found in SPM packages.'
        );
        logger.alert(
          `It seems that your app may be using multiple push messaging libraries (${conflictingPackages}).` +
            ` Note: Some packages like Firebase include multiple products, not all of which may conflict.` +
            ` We're continuing to improve support for multiple libraries, but there are some limitations.` +
            ` Learn more at: ${project.documentation.multiplePushProviders}`
        );
      }
    }
  }

  if (project.isUsingCocoaPods) {
    const podfileLock = project.podfileLock;
    logger.debug(
      `Checking for conflicting libraries in: ${podfileLock.readablePath}`
    );
    const podfileLockContent = podfileLock.content;
    if (podfileLockContent) {
      const conflictingPods = Conflicts.iosPods.filter((lib) =>
        podfileLockContent.includes(lib)
      );
      if (conflictingPods.length === 0) {
        logger.success('No conflicting pods found');
      } else {
        logger.warning('Potential conflicting libraries found in pods.');
        logger.alert(
          `It seems that your app is using multiple push messaging libraries (${conflictingPods}).` +
            ` We're continuing to improve support for multiple libraries, but there are some limitations.` +
            ` Learn more at: ${project.documentation.multiplePushProviders}`
        );
      }
    }
  }
}

async function validateDependencies(project: iOSProject): Promise<void> {
  // Check both package managers if present
  if (project.isUsingSPM) {
    await runCatching(extractSPMVersions)(project);
  }

  if (project.isUsingCocoaPods) {
    await runCatching(extractPodVersions)(project);
  }

  // Warn if no package manager found
  if (!project.isUsingCocoaPods && !project.isUsingSPM) {
    logger.warning(
      `No Podfile found at ${project.podfile.readablePath} and no Package.resolved found. Unable to detect dependencies.`
    );
  }
}

async function extractPodVersions(project: iOSProject): Promise<void> {
  const podfileLock = project.podfileLock;
  const podfileLockContent = podfileLock.content;

  const validatePod = (
    podName: string,
    optional: boolean = false,
    // Minimum required version for new features
    minRequiredVersion: string | undefined = undefined,
    // Message to display when the pod needs to be updated for new features
    updatePodMessage: string = `Please update ${podName} to latest version following our documentation`
  ): boolean => {
    let podVersions: string | undefined;
    if (podfileLockContent) {
      podVersions = extractVersionFromPodLock(podfileLockContent, podName);
    }

    if (podVersions) {
      logger.success(`${podName}: ${podVersions}`);

      // Check if the pod version is below the minimum required version
      // If so, alert the user to update the pod for new features
      if (
        minRequiredVersion &&
        compareSemanticVersions(
          extractSemanticVersion(podVersions),
          minRequiredVersion
        ) < 0
      ) {
        logger.alert(updatePodMessage);
      }
    } else if (!optional) {
      logger.failure(`${podName} module not found`);
    }
    return podVersions !== undefined;
  };

  // Since iOS SDK 3.0.0, we have removed Tracking module and apps should use Data Pipeline module now
  // Validate Data Pipeline module for all frameworks
  validatePod(POD_DATA_PIPELINE);
  validatePod(POD_MESSAGING_IN_APP);

  // Alert message for updating Push Messaging pods
  const pushMessagingPodUpdateMessage = (podName: string) =>
    `Please update ${podName} to latest version following our documentation for improved tracking of push notification metrics`;
  const pushMessagingAPNPod = validatePod(
    POD_MESSAGING_PUSH_APN,
    true,
    iOS_SDK_PUSH_SWIZZLE_VERSION,
    pushMessagingPodUpdateMessage(POD_MESSAGING_PUSH_APN)
  );
  const pushMessagingFCMPod = validatePod(
    POD_MESSAGING_PUSH_FCM,
    true,
    iOS_SDK_PUSH_SWIZZLE_VERSION,
    pushMessagingPodUpdateMessage(POD_MESSAGING_PUSH_FCM)
  );

  if (pushMessagingAPNPod && pushMessagingFCMPod) {
    logger.error(
      `${POD_MESSAGING_PUSH_APN} and ${POD_MESSAGING_PUSH_FCM} modules found. Both cannot be used at a time, please use only one of them.`
    );
  }
}

async function extractSPMVersions(project: iOSProject): Promise<void> {
  const packageResolved = project.packageResolved;
  const packageResolvedContent = packageResolved.content;

  if (!packageResolvedContent) {
    logger.error(
      `No Package.resolved found at ${packageResolved.readablePath}`
    );
    return;
  }

  // Check if the Customer.io package exists in Package.resolved
  const packageVersion = extractModuleVersionFromPackageResolved(
    packageResolvedContent,
    SPM_PACKAGE_IDENTITY,
    ''
  );

  if (!packageVersion) {
    logger.failure(`Customer.io SDK not found in Package.resolved.`);
    logger.error(
      'The Customer.io SDK does not appear to be installed via Swift Package Manager. ' +
        'Please verify that you have added the Customer.io package to your project. ' +
        'Refer to the Customer.io documentation for installation instructions.'
    );
    return;
  }

  const validateSPMModule = (
    moduleName: string,
    optional: boolean = false,
    minRequiredVersion: string | undefined = undefined,
    updateModuleMessage: string = `Please update ${moduleName} to latest version following our documentation`
  ): boolean => {
    const moduleVersion = extractModuleVersionFromPackageResolved(
      packageResolvedContent,
      SPM_PACKAGE_IDENTITY,
      moduleName
    );

    if (moduleVersion) {
      logger.success(`${moduleName}: ${moduleVersion}`);

      // Check if the module version is below the minimum required version
      if (
        minRequiredVersion &&
        compareSemanticVersions(
          extractSemanticVersion(moduleVersion),
          minRequiredVersion
        ) < 0
      ) {
        logger.alert(updateModuleMessage);
      }
    } else if (!optional) {
      logger.failure(`${moduleName} module not found`);
    }
    return moduleVersion !== undefined;
  };

  // Validate Data Pipeline module for all frameworks
  validateSPMModule(SPM_DATA_PIPELINE);
  validateSPMModule(SPM_MESSAGING_IN_APP);

  // Alert message for updating Push Messaging modules
  const pushMessagingModuleUpdateMessage = (moduleName: string) =>
    `Please update ${moduleName} to latest version following our documentation for improved tracking of push notification metrics`;
  validateSPMModule(
    SPM_MESSAGING_PUSH_APN,
    true,
    iOS_SDK_PUSH_SWIZZLE_VERSION,
    pushMessagingModuleUpdateMessage(SPM_MESSAGING_PUSH_APN)
  );
  validateSPMModule(
    SPM_MESSAGING_PUSH_FCM,
    true,
    iOS_SDK_PUSH_SWIZZLE_VERSION,
    pushMessagingModuleUpdateMessage(SPM_MESSAGING_PUSH_FCM)
  );

  // Note: Cannot detect conflicts between MessagingPushAPN and MessagingPushFCM for SPM
  // because Package.resolved only lists the package, not individual products/modules.
  // Both modules will appear present if the Customer.io package is installed.
}
