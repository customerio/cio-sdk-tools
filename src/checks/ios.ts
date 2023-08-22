import * as path from "path";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import xcode from "xcode";
import { Conflicts, Patterns } from "../constants";
import { Context, iOSProject } from "../core";
import {
  logger,
  readAndParseXML,
  readFileContent,
  runCatching,
  trimEqualOperator,
  trimQuotes,
  uniqueValues,
} from "../utils";

export async function runAllChecks(): Promise<void> {
  const context = Context.get();
  const project = context.project as iOSProject;

  await runCatching(validateDeploymentTarget)(project);
  await runCatching(validateUserNotificationCenterDelegate)(project);
  await runCatching(validatePushEntitlements)(project);
  await runCatching(validateNoConflictingSDKs)(project);
  await runCatching(collectSummary)(project);
}

async function validateDeploymentTarget(project: iOSProject): Promise<void> {
  for (const projectFile of project.projectFiles) {
    const filepath = projectFile.path;
    const xcodeProject = xcode.project(filepath);
    xcodeProject.parseSync();

    logger.searching(`Checking project at path: ${filepath}`);

    const targets = xcodeProject.pbxNativeTargetSection();
    // Check for Notification Service Extension
    await verifyNotificationServiceExtension(project, targets);

    const deploymentTarget = getDeploymentTargetVersion(xcodeProject);
    logger.result(
      `Deployment Target Version for NSE: ${deploymentTarget}. Ensure this version is not higher than the iOS version of the devices where the app will be installed. A higher target version may prevent some features, like rich notifications, from working correctly.`,
    );
  }
}

/**
 * Check if a Notification Service Extension is present and that there is only one.
 * @param {Object} targets - Targets from the Xcode project.
 */
//
async function verifyNotificationServiceExtension(
  project: iOSProject,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  targets: any[],
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
      trimQuotes(productType) === "com.apple.product-type.app-extension"
    ) {
      logger.progress(`Found app extension: ${target.name}`);

      const inferredDirectoryName =
        target.name || target.productReference_comment.replace(".appex", "");
      const possibleInfoPlistPath =
        `./${inferredDirectoryName}/Info.plist`.replace(/"/g, "");

      const infoPlistPath = path.join(
        project.iOSProjectPath,
        possibleInfoPlistPath,
      );
      logger.searching(`Checking Info.plist at path: ${infoPlistPath}`);
      const infoPlistContent = await readAndParseXML(infoPlistPath);

      // If the Info.plist content represents an NSE, process further
      if (isNotificationServiceExtension(infoPlistContent.plist.dict)) {
        logger.progress(`Found Notification app extension: ${target.name}`);
        extensionCount++;
      }
    }

    if (
      productType &&
      trimQuotes(productType) === "com.apple.product-type.application"
    ) {
      logger.searching(
        `Checking if the NSE is embedded into target app: ${target.name}`,
      );
      // Check if the target is listed in the Embed App Extensions build phase.
      if (
        target.buildPhases &&
        target.buildPhases.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (phase: any) => trimQuotes(phase.comment) === "Embed App Extensions",
        )
      ) {
        isEmbedded = true;
      } else if (
        target.buildPhases &&
        target.buildPhases.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (phase: any) =>
            trimQuotes(phase.comment) === "Embed Foundation Extensions",
        )
      ) {
        isFoundationExtension = true;
      }
    }
  }

  if (extensionCount > 1) {
    logger.failure(
      "Multiple Notification Service Extensions found. Only one should be present.",
    );
  } else if (extensionCount === 1) {
    if (isEmbedded) {
      logger.success("Notification Service Extension found and embedded.");
    } else if (isFoundationExtension) {
      logger.warning(
        "Notification Service Extension found but not embedded as it is a Foundation Extension.",
      );
    } else {
      logger.failure("Notification Service Extension found but not embedded.");
    }
  } else {
    logger.failure("Notification Service Extension not found.");
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
    ? content.key.includes("NSExtension")
    : content.key === "NSExtension";

  // Check if 'NSExtensionPointIdentifier' is present inside the nested dict, accounting for both string and array type.
  const hasNSExtensionPointIdentifier =
    content.dict && Array.isArray(content.dict.key)
      ? content.dict.key.includes("NSExtensionPointIdentifier")
      : content.dict.key === "NSExtensionPointIdentifier";

  // Check if the value associated with 'NSExtensionPointIdentifier' is 'com.apple.usernotifications.service'.
  const hasUserNotificationsService =
    content.dict && Array.isArray(content.dict.string)
      ? content.dict.string.includes("com.apple.usernotifications.service")
      : content.dict.string === "com.apple.usernotifications.service";

  // If all checks pass, return true; otherwise, return false.
  return (
    hasNSExtensionKey &&
    hasNSExtensionPointIdentifier &&
    hasUserNotificationsService
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getDeploymentTargetVersion(pbxProject: any) {
  const buildConfig = pbxProject.pbxXCBuildConfigurationSection();
  const nativeTargets = pbxProject.pbxNativeTargetSection();
  const configList = pbxProject.pbxXCConfigurationList();

  let nseBuildConfigKeys = [];

  // Find the NSE build configuration list key
  for (const key in nativeTargets) {
    const nativeTarget = nativeTargets[key];
    const productType: string | undefined = nativeTarget?.productType;

    if (
      productType &&
      trimQuotes(productType) === "com.apple.product-type.app-extension"
    ) {
      const configListKey = nativeTarget.buildConfigurationList;
      const buildConfigurations = configList[configListKey].buildConfigurations;
      nseBuildConfigKeys = buildConfigurations.map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (config: any) => config.value,
      );
      break;
    }
  }

  // Return deployment target of the NSE
  if (nseBuildConfigKeys.length) {
    for (const key in buildConfig) {
      const config = buildConfig[key];
      // Check if the config is the NSE build configuration and it has an iOS deployment target
      if (
        nseBuildConfigKeys.includes(key) &&
        config.buildSettings &&
        config.buildSettings["IPHONEOS_DEPLOYMENT_TARGET"]
      ) {
        return config.buildSettings["IPHONEOS_DEPLOYMENT_TARGET"];
      }
    }
  }

  return null;
}

async function validateUserNotificationCenterDelegate(
  project: iOSProject,
): Promise<void> {
  let allRequirementsMet = false;
  for (const appDelegateFile of project.appDelegateFiles) {
    const filepath = appDelegateFile.path;
    logger.searching(`Checking AppDelegate at path: ${filepath}`);
    const contents = readFileContent(filepath)!;

    const extension = appDelegateFile.args.get("extension");
    switch (extension) {
      case "swift":
        allRequirementsMet =
          allRequirementsMet ||
          contents.includes("func userNotificationCenter(");
        break;
      case "Objective-C":
      case "Objective-C++":
        allRequirementsMet =
          allRequirementsMet ||
          Patterns.iOS_OBJ_C_USER_NOTIFICATION_CENTER.test(contents);
        break;
    }
  }

  if (allRequirementsMet) {
    logger.success(`Required method found in AppDelegate`);
  } else {
    logger.failure(`Required method not found in AppDelegate`);
  }
}

async function validatePushEntitlements(project: iOSProject): Promise<void> {
  let allRequirementsMet = false;

  for (const entitlementsFile of project.entitlementsFiles) {
    const filepath = entitlementsFile.path;
    logger.searching(`Checking entitlements file at path: ${filepath}`);
    const contents = readFileContent(filepath)!;
    allRequirementsMet =
      allRequirementsMet || Patterns.iOS_PUSH_ENV_ENTITLEMENT.test(contents);
  }

  if (allRequirementsMet) {
    logger.success(`Push Notification capability found in entitlements`);
  } else {
    logger.failure(`Push Notification capability not found in entitlements`);
  }
}

async function validateNoConflictingSDKs(project: iOSProject): Promise<void> {
  const podfileLockPath = project.podfileLock.path;
  logger.searching(`Checking for conflicting libraries in: ${podfileLockPath}`);
  const podfileLockContent = readFileContent(podfileLockPath);
  if (!podfileLockContent) {
    logger.failure(`No podfile.lock found at ${podfileLockPath}`);
    return;
  }

  const conflictingPods = Conflicts.iosPods.filter((lib) =>
    podfileLockContent.includes(lib),
  );
  if (conflictingPods.length === 0) {
    logger.success("No conflicting pods found in Podfile");
  } else {
    logger.warning(
      "More than one pods found in Podfile for handling push notifications",
      conflictingPods,
    );
  }
}

async function collectSummary(project: iOSProject): Promise<void> {
  try {
    const podfileLock = project.podfileLock;
    const podfileLockPath = podfileLock.path;
    const podfileLockContent = podfileLock.content!;

    const trackingPodVersions = extractPodVersions(
      podfileLockContent,
      Patterns.iOS_POD_CIO_TRACKING,
    );
    if (trackingPodVersions) {
      project.summary.push(
        logger.formatter.info(
          `CustomerIO/Tracking version in ${podfileLockPath} set to ${trackingPodVersions}`,
        ),
      );
    } else {
      project.summary.push(
        logger.formatter.failure(
          `CustomerIO/Tracking not found in Podfile.lock at ${podfileLockPath}`,
        ),
      );
    }

    const inAppMessagingPodVersions = extractPodVersions(
      podfileLockContent,
      Patterns.iOS_POD_CIO_IN_APP,
    );
    if (inAppMessagingPodVersions) {
      project.summary.push(
        logger.formatter.info(
          `CustomerIO/MessagingInApp version in ${podfileLockPath} set to ${inAppMessagingPodVersions}`,
        ),
      );
    } else {
      project.summary.push(
        logger.formatter.failure(
          `CustomerIO/MessagingInApp not found in Podfile.lock at ${podfileLockPath}`,
        ),
      );
    }

    const messagingPushAPNPodVersions = extractPodVersions(
      podfileLockContent,
      Patterns.iOS_POD_CIO_PUSH_APN,
    );
    const messagingPushFCMPodVersions = extractPodVersions(
      podfileLockContent,
      Patterns.iOS_POD_CIO_PUSH_FCM,
    );
    if (messagingPushAPNPodVersions && messagingPushFCMPodVersions) {
      project.summary.push(
        logger.formatter.failure(
          `CustomerIO/MessagingPushAPN and CustomerIO/MessagingPushFCM found in Podfile.lock at ${podfileLockPath}. Both cannot be used at a time, please use only one of them.`,
        ),
      );
    } else if (messagingPushAPNPodVersions) {
      project.summary.push(
        logger.formatter.info(
          `CustomerIO/MessagingPushAPN version in ${podfileLockPath} set to ${messagingPushAPNPodVersions}`,
        ),
      );
    } else if (messagingPushFCMPodVersions) {
      project.summary.push(
        logger.formatter.info(
          `CustomerIO/MessagingPushFCM version in ${podfileLockPath} set to ${messagingPushFCMPodVersions}`,
        ),
      );
    } else {
      project.summary.push(
        logger.formatter.warning(
          `CustomerIO/MessagingPush not found in Podfile.lock at ${podfileLockPath}`,
        ),
      );
    }
  } catch (err) {
    logger.error(
      `Unable to read Podfile.lock at ${project.podfileLock.path}: %s`,
      err,
    );
  }
}

function extractPodVersions(
  podfileLockContent: string,
  podPattern: RegExp,
): string | undefined {
  let match;
  const versions: string[] = [];
  while ((match = podPattern.exec(podfileLockContent)) !== null) {
    versions.push(match[1]);
  }

  if (versions.length > 0) {
    const distinctValues = uniqueValues(
      versions.map((version) => trimEqualOperator(version)),
    );
    return distinctValues.join(", ");
  } else {
    return undefined;
  }
}
