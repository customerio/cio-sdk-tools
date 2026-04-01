import {
  ANDROID_MIN_SDK_VERSION,
  ANDROID_MODULE_DATA_PIPELINES,
  ANDROID_MODULE_MESSAGING_IN_APP,
  ANDROID_MODULE_MESSAGING_PUSH_FCM,
  ANDROID_PACKAGE_GROUP,
  ANDROID_SDK_MIN_VERSION,
} from '../constants';
import { androidGradleDependencies } from '../constants/conflicts';
import { AndroidProject, Context } from '../core';
import { CheckGroup } from '../types';
import {
  compareSemanticVersions,
  extractSemanticVersion,
  extractVersionFromBuildGradle,
  fetchCachedLatestVersion,
  logger,
  runCatching,
  searchFilesForCode,
} from '../utils';
import { doesExists } from '../utils/file';

// Common search configurations for Android files
const ANDROID_SOURCE_BASE_CONFIG = {
  ignoreDirectories: ['build', '.gradle', 'gradle'],
  targetFileNames: ['Application', 'App', 'MainActivity'],
};

const SDK_INIT_SEARCH_CONFIG = {
  ...ANDROID_SOURCE_BASE_CONFIG,
  targetFilePatterns: ['customerio', 'cio', 'initialize'],
};

const PUSH_SETUP_SEARCH_CONFIG = {
  ...ANDROID_SOURCE_BASE_CONFIG,
  targetFilePatterns: ['messaging', 'firebase', 'fcm', 'push'],
};

export async function runChecks(group: CheckGroup): Promise<void> {
  const context = Context.get();
  const project = context.project as AndroidProject;

  switch (group) {
    case CheckGroup.Diagnostics:
      await runCatching(validateAndroidSdkVersions)(project);
      break;

    case CheckGroup.Initialization:
      await runCatching(validateSDKInitialization)(project);
      break;

    case CheckGroup.PushSetup:
      await runCatching(validateGoogleServices)(project);
      await runCatching(validateFirebaseMessagingService)(project);
      break;

    case CheckGroup.Dependencies:
      await runCatching(validateNoConflictingSDKs)(project);
      await runCatching(validateDependencies)(project);
      break;
  }
}

/**
 * Validates Android SDK versions (minSdkVersion, targetSdkVersion)
 */
async function validateAndroidSdkVersions(
  project: AndroidProject
): Promise<void> {
  if (!project.appBuildGradle?.content) {
    logger.warning('Unable to find app-level build.gradle file');
    return;
  }

  // Try app build.gradle first
  // Match both Groovy DSL (minSdk 21) and Kotlin DSL (minSdk = 24)
  let minSdkMatch = project.appBuildGradle.content.match(
    /minSdk(?:Version)?\s*[=:]?\s*(\d+)/
  );
  let targetSdkMatch = project.appBuildGradle.content.match(
    /targetSdk(?:Version)?\s*[=:]?\s*(\d+)/
  );

  // If not found (variable references like rootProject.ext.minSdkVersion),
  // try root build.gradle for wrapper frameworks
  if ((!minSdkMatch || !targetSdkMatch) && project.rootBuildGradle?.content) {
    if (!minSdkMatch) {
      minSdkMatch = project.rootBuildGradle.content.match(
        /minSdk(?:Version)?\s*[=:]?\s*(\d+)/
      );
    }
    if (!targetSdkMatch) {
      targetSdkMatch = project.rootBuildGradle.content.match(
        /targetSdk(?:Version)?\s*[=:]?\s*(\d+)/
      );
    }
  }

  if (minSdkMatch) {
    const minSdk = parseInt(minSdkMatch[1], 10);
    if (minSdk < ANDROID_MIN_SDK_VERSION) {
      logger.failure(
        `minSdkVersion ${minSdk} is below required minimum ${ANDROID_MIN_SDK_VERSION}`
      );
    } else {
      logger.success(`minSdkVersion: ${minSdk}`);
    }
  }

  if (targetSdkMatch) {
    const targetSdk = parseInt(targetSdkMatch[1], 10);
    logger.success(`targetSdkVersion: ${targetSdk}`);
  }
}

/**
 * Validates CustomerIO SDK initialization in Application or MainActivity
 *
 * NOTE: For wrapper frameworks (React Native/Flutter), initialization happens
 * in JavaScript/Dart code, not in native Android code. This check is skipped
 * for wrapper frameworks.
 */
async function validateSDKInitialization(
  project: AndroidProject
): Promise<void> {
  // Skip this check for wrapper frameworks - they initialize in JS/Dart
  if (project.isWrapperFramework) {
    logger.debug(
      'Skipping native Android initialization check for wrapper framework'
    );
    return;
  }

  const initPattern = /CustomerIO\.initialize/;

  const searchResults = searchFilesForCode(
    {
      codePatternByExtension: {
        '.java': initPattern,
        '.kt': initPattern,
      },
      ...SDK_INIT_SEARCH_CONFIG,
    },
    project.androidProjectPath
  );

  if (searchResults.matchedFiles.length > 0) {
    logger.success('Found CustomerIO.initialize() in project');
  } else {
    logger.failure('Could not find CustomerIO.initialize() call');
    logger.alert(
      'Make sure to initialize the SDK in your Application class or MainActivity'
    );
  }
}

/**
 * Validates Google Services configuration
 */
async function validateGoogleServices(project: AndroidProject): Promise<void> {
  // Check for google-services.json
  if (
    project.googleServicesJson &&
    doesExists(project.googleServicesJson.absolutePath)
  ) {
    logger.success('google-services.json file found');
  } else {
    logger.warning('google-services.json file not found');
    logger.alert('Push notifications require Firebase configuration');
  }

  // Check for Google Services plugin in build.gradle
  if (project.appBuildGradle?.content) {
    const hasPlugin =
      /apply\s+plugin:\s*['"]com\.google\.gms\.google-services['"]/.test(
        project.appBuildGradle.content
      ) ||
      /id\s*\(?['"]com\.google\.gms\.google-services['"]/.test(
        project.appBuildGradle.content
      );

    if (hasPlugin) {
      logger.success('Google Services plugin applied');
    } else {
      logger.warning('Google Services plugin not found in app/build.gradle');
    }
  } else {
    logger.debug(
      'Unable to check Google Services plugin - build.gradle not loaded'
    );
  }
}

/**
 * Validates FirebaseMessagingService implementation
 *
 * NOTE: A custom FirebaseMessagingService is NOT required.
 * The Customer.io SDK automatically adds a FirebaseMessagingService to the manifest.
 * Custom implementations are only needed if the app has specific push handling requirements.
 */
async function validateFirebaseMessagingService(
  project: AndroidProject
): Promise<void> {
  // Look for custom FirebaseMessagingService extension
  const servicePattern =
    /:\s*FirebaseMessagingService\(\)|extends\s+FirebaseMessagingService/;

  const searchResults = searchFilesForCode(
    {
      codePatternByExtension: {
        '.java': servicePattern,
        '.kt': servicePattern,
      },
      ...PUSH_SETUP_SEARCH_CONFIG,
    },
    project.androidProjectPath
  );

  if (searchResults.matchedFiles.length > 0) {
    logger.success('Found custom FirebaseMessagingService implementation');
    logger.debug(
      'Custom implementation found - ensure it calls CustomerIOFirebaseMessagingService methods'
    );
  } else {
    logger.success('Using SDK default FirebaseMessagingService');
  }

  // Check if service is registered in AndroidManifest.xml
  if (project.androidManifest?.content) {
    if (project.androidManifest.content.includes('FirebaseMessagingService')) {
      logger.debug(
        'FirebaseMessagingService registered in AndroidManifest.xml'
      );
    }
  }
}

/**
 * Validates no conflicting Android SDKs are present
 */
async function validateNoConflictingSDKs(
  project: AndroidProject
): Promise<void> {
  if (!project.appBuildGradle?.content) return;

  const conflictsFound: string[] = [];

  for (const conflictingDep of androidGradleDependencies) {
    if (project.appBuildGradle.content.includes(conflictingDep)) {
      conflictsFound.push(conflictingDep);
    }
  }

  if (conflictsFound.length > 0) {
    logger.failure('Found conflicting Android push notification libraries:');
    conflictsFound.forEach((dep) => logger.alert(`  - ${dep}`));
  } else {
    // Only show success for native Android projects
    // For wrappers, this is redundant since iOS checks already covered it
    if (!project.isWrapperFramework) {
      logger.success('No conflicting Android push libraries detected');
    }
  }
}

/**
 * Validates Customer.io SDK dependencies and versions
 *
 * NOTE: This check is primarily for native Android projects.
 * React Native and Flutter projects include Android dependencies transitively
 * through their wrapper SDKs (package.json/pubspec.yaml), so they won't have
 * explicit io.customer.android:* dependencies in build.gradle.
 */
async function validateDependencies(project: AndroidProject): Promise<void> {
  if (!project.appBuildGradle?.content) {
    logger.warning('Unable to analyze dependencies - build.gradle not found');
    return;
  }

  const latestSdkVersion = extractSemanticVersion(
    await fetchCachedLatestVersion('customerio-android')
  );

  const modules = [
    { name: ANDROID_MODULE_DATA_PIPELINES, displayName: 'Data Pipelines' },
    { name: ANDROID_MODULE_MESSAGING_IN_APP, displayName: 'Messaging In-App' },
    {
      name: ANDROID_MODULE_MESSAGING_PUSH_FCM,
      displayName: 'Messaging Push FCM',
    },
  ];

  let foundAny = false;

  for (const module of modules) {
    const version = extractVersionFromBuildGradle(
      project.appBuildGradle.content,
      ANDROID_PACKAGE_GROUP,
      module.name
    );

    if (version) {
      foundAny = true;
      const sdkVersionMessage = `${module.displayName}: ${version}`;

      if (compareSemanticVersions(version, ANDROID_SDK_MIN_VERSION) < 0) {
        logger.warning(sdkVersionMessage);
        logger.alert(
          `Version ${version} is below recommended minimum ${ANDROID_SDK_MIN_VERSION}`
        );
      } else if (
        latestSdkVersion &&
        compareSemanticVersions(version, latestSdkVersion) < 0
      ) {
        logger.warning(sdkVersionMessage);
        logger.alert(`Update to the latest SDK version ${latestSdkVersion}`);
      } else {
        logger.success(sdkVersionMessage);
      }
    }
  }

  if (!foundAny) {
    // For native Android, this is a warning
    // For React Native/Flutter, this is expected (dependencies come from wrapper SDK)
    logger.debug(
      'No explicit io.customer.android:* dependencies in build.gradle'
    );
    logger.debug('This is expected for React Native/Flutter projects');
  }
}
