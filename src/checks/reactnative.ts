import { Commands, Conflicts, PACKAGE_NAME_REACT_NATIVE } from '../constants';
import { Context, ReactNativeProject } from '../core';
import { CheckGroup } from '../enums';
import {
  extractVersionFromPackageLock,
  fetchNPMVersion,
  logger,
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

  const sdkVersionInPackageJson =
    packageJson.dependencies[PACKAGE_NAME_REACT_NATIVE];
  logger.success(
    `${PACKAGE_NAME_REACT_NATIVE} version in package.json: ${sdkVersionInPackageJson}`
  );

  const conflictingLibraries = Conflicts.reactNativePackages.filter((lib) =>
    dependencies.includes(lib)
  );

  if (conflictingLibraries.length === 0) {
    logger.success('No conflicting libraries found');
  } else {
    logger.warning('Potential conflicting libraries found.');
    logger.alert(
      `It seems that your app is using multiple push messaging libraries (${conflictingLibraries}).` +
        ` We're continuing to improve support for multiple libraries, but there are some limitations.` +
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
  const latestSdkVersion = await fetchNPMVersion(PACKAGE_NAME_REACT_NATIVE);

  const packageFileSDKVersion =
    getSDKVersionPackageLock(project) ?? getSDKVersionPackageFile(project);

  if (packageFileSDKVersion) {
    const sdkVersionMessage = `Customer.io React Native SDK version: ${packageFileSDKVersion}`;
    if (packageFileSDKVersion === latestSdkVersion) {
      logger.success(sdkVersionMessage);
    } else {
      logger.warning(sdkVersionMessage);
      logger.alert(`Update to the latest SDK version ${latestSdkVersion}`);
    }
  } else {
    logger.failure(
      `Customer.io React Native SDK not found in ${project.packageLockFile?.readablePath}`
    );
  }
}

function getSDKVersionPackageLock(
  project: ReactNativeProject
): string | undefined {
  const packageLockFile = project.packageLockFile;
  if (!packageLockFile || !packageLockFile.content) {
    logger.warning(
      `No lock file found for package.json. Make sure to run ${Commands.REACT_NATIVE.INSTALL_DEPENDENCIES} before running the project.`
    );
    return undefined;
  }

  return extractVersionFromPackageLock(
    packageLockFile.content,
    packageLockFile.args.get('type'),
    PACKAGE_NAME_REACT_NATIVE
  );
}

function getSDKVersionPackageFile(
  project: ReactNativeProject
): string | undefined {
  const packageFile = project.packageJsonFile;
  if (!packageFile || !packageFile.content) {
    return undefined;
  }

  const packageJson = JSON.parse(packageFile.content!);
  return packageJson[PACKAGE_NAME_REACT_NATIVE];
}
