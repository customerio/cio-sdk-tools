import { Conflicts, PACKAGE_NAME_REACT_NATIVE } from '../constants';
import { Context, ReactNativeProject } from '../core';
import {
  extractVersionFromPackageLock,
  extractVersionFromPodLock,
  logger,
  runCatching,
  searchFilesForCode,
} from '../utils';

export async function runAllChecks(): Promise<void> {
  const context = Context.get();
  const project = context.project as ReactNativeProject;

  logger.linebreak();
  logger.bold(`Dependencies`);

  await runCatching(validateReactNativeSDKVersion)(project);
  await runCatching(validateNoConflictingSDKs)(project);
  await runCatching(validateSDKInitialization)(project);
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
        ` Learn more at: https://customer.io/docs/sdk/react-native/push-notifications/multiple-push-providers/`
    );
  }
}

async function validateSDKInitialization(
  project: ReactNativeProject
): Promise<void> {
  logger.linebreak();
  logger.bold(`Initialization`);

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
    logger.success(`SDK Initialization found in ${sdkInitializationFiles}`);
  } else {
    logger.failure('SDK Initialization not found');
  }
}

async function validateReactNativeSDKVersion(
  project: ReactNativeProject
): Promise<void> {
  try {
    const packageLockFile = project.packageLockFile;
    if (!packageLockFile || !packageLockFile.content) {
      logger.failure(`No lock file found for package.json`);
    } else {
      const lockFileType = packageLockFile.args.get('type');

      const sdkVersionInLockFile = extractVersionFromPackageLock(
        packageLockFile.content,
        lockFileType,
        PACKAGE_NAME_REACT_NATIVE
      );
      if (sdkVersionInLockFile) {
        logger.success(
          `Customer.io React Native SDK version: ${sdkVersionInLockFile}`
        );
      } else {
        logger.failure(
          `Customer.io React Native SDK not found in ${packageLockFile.readablePath}`
        );
      }
    }
  } catch (err) {
    logger.exception('Unable to read lock files for package.json: %s', err);
  }

  try {
    const podfileLock = project.podfileLock;
    const podfileLockContent = podfileLock.content!;

    const reactNativePodVersion = extractVersionFromPodLock(
      podfileLockContent,
      PACKAGE_NAME_REACT_NATIVE
    );
    if (reactNativePodVersion) {
      logger.success(
        `Customer.io React Native SDK POD version: ${reactNativePodVersion}`
      );
    } else {
      logger.failure(
        `Customer.io React Native SDK not found in ${podfileLock.readablePath}`
      );
    }
  } catch (err) {
    logger.exception(
      `Unable to read Podfile.lock at ${project.podfileLock.readablePath}: %s`,
      err
    );
  }
}
