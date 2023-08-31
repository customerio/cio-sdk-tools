import { Commands, Conflicts, PACKAGE_NAME_REACT_NATIVE } from '../constants';
import { Context, ReactNativeProject } from '../core';
import { CheckGroup } from '../types';
import {
  extractVersionFromPackageJson,
  extractVersionFromPackageLock,
  fetchLatestVersion,
  logger,
  removeNonAlphanumericChars,
  runCatching,
  searchFilesForCode,
} from '../utils';

export async function runChecks(group: CheckGroup): Promise<void> {
  const context = Context.get();
  const project = context.project as ReactNativeProject;

  switch (group) {
    case CheckGroup.Diagnostics:
      await runCatching(validateSDKVersion)(project);
      break;

    case CheckGroup.Initialization:
      await runCatching(validateSDKInitialization)(project);
      break;

    case CheckGroup.PushSetup:
      break;

    case CheckGroup.Dependencies:
      await runCatching(validateNoConflictingSDKs)(project);
      break;
  }
}

async function validateNoConflictingSDKs(
  project: ReactNativeProject
): Promise<void> {
  const packageFile = project.packageJsonFile;
  const packageJson = JSON.parse(packageFile.content!);
  const dependencies = [...Object.keys(packageJson.dependencies || {})];

  const conflictingLibraries = Conflicts.reactNativePackages.filter((lib) =>
    dependencies.includes(lib)
  );

  if (conflictingLibraries.length === 0) {
    logger.success('No conflicting packages found');
  } else {
    logger.warning('Potential conflicting packages found.');
    logger.alert(
      `It seems that your app is using multiple push messaging packages (${conflictingLibraries}).` +
        ` We're continuing to improve support for multiple packages, but there are some limitations.` +
        ` Learn more at: ${project.documentation.multiplePushProviders}`
    );
  }
}

async function validateSDKInitialization(
  project: ReactNativeProject
): Promise<void> {
  const sdkInitializationPattern = /CustomerIO\.initialize/;
  const sdkInitializationFiles = searchFilesForCode(
    {
      codePatternByExtension: {
        '.js': sdkInitializationPattern,
        '.jsx': sdkInitializationPattern,
        '.ts': sdkInitializationPattern,
        '.tsx': sdkInitializationPattern,
      },
      ignoreDirectories: ['android', 'ios'],
      targetFileNames: ['App', 'index'],
      targetFilePatterns: ['cio', 'customerio'],
    },
    project.projectPath
  );

  if (sdkInitializationFiles !== undefined) {
    logger.success(
      `React Native SDK Initialization found in ${sdkInitializationFiles}`
    );
  } else {
    logger.failure('React Native SDK Initialization not found');
  }
}

async function validateSDKVersion(project: ReactNativeProject): Promise<void> {
  const latestSdkVersion = await fetchLatestVersion(PACKAGE_NAME_REACT_NATIVE);

  let packageFileSDKVersion: string | undefined;
  let parsedSDKVersion: string | undefined;

  const packageLockContent = project.packageLockFile?.content;
  if (packageLockContent) {
    packageFileSDKVersion = extractVersionFromPackageLock(
      packageLockContent,
      project.packageLockFile!.args.get('type'),
      PACKAGE_NAME_REACT_NATIVE
    );
    parsedSDKVersion = packageFileSDKVersion;
  }

  if (!packageFileSDKVersion) {
    logger.failure(
      `Customer.io React Native SDK not found in package lock file.` +
        ` Make sure to run ${Commands.ReactNative.INSTALL_DEPENDENCIES} before running the project.`
    );
    const packageJsonContent = project.packageJsonFile?.content;
    if (packageJsonContent) {
      packageFileSDKVersion = extractVersionFromPackageJson(
        packageJsonContent,
        PACKAGE_NAME_REACT_NATIVE
      );
    }
    if (packageFileSDKVersion) {
      parsedSDKVersion = removeNonAlphanumericChars(packageFileSDKVersion);
    }
  }

  if (packageFileSDKVersion) {
    const sdkVersionMessage = `Customer.io React Native SDK version: ${packageFileSDKVersion}`;
    if (!latestSdkVersion || parsedSDKVersion === latestSdkVersion) {
      logger.success(sdkVersionMessage);
    } else {
      logger.warning(sdkVersionMessage);
      logger.alert(`Update to the latest SDK version ${latestSdkVersion}`);
    }
  } else {
    logger.failure(
      `Customer.io React Native SDK not found in ${project.projectPath}`
    );
  }
}
