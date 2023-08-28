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

  await runCatching(validateSDKInitialization)(project);
  await runCatching(validateNoConflictingSDKs)(project);
  await runCatching(collectSummary)(project);
}

async function validateNoConflictingSDKs(
  project: ReactNativeProject
): Promise<void> {
  const packageFile = project.packageJsonFile;
  logger.searching(
    `Checking for conflicting libraries in: ${packageFile.readablePath}`
  );

  const packageJson = JSON.parse(packageFile.content!);
  const dependencies = [...Object.keys(packageJson.dependencies || {})];

  const sdkVersionInPackageJson =
    packageJson.dependencies[PACKAGE_NAME_REACT_NATIVE];
  project.summary.push(
    logger.formatter.info(
      `${PACKAGE_NAME_REACT_NATIVE} version in package.json: ${sdkVersionInPackageJson}`
    )
  );

  const conflictingLibraries = Conflicts.reactNativePackages.filter((lib) =>
    dependencies.includes(lib)
  );

  if (conflictingLibraries.length === 0) {
    logger.success('No conflicting libraries found in package.json');
  } else {
    logger.warning(
      'More than one libraries found in package.json for handling push notifications',
      conflictingLibraries
    );
  }
}

async function validateSDKInitialization(
  project: ReactNativeProject
): Promise<void> {
  logger.searching(`Checking for SDK Initialization in React Native`);

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
    logger.warning('SDK Initialization not found in suggested files');
  }
}

async function collectSummary(project: ReactNativeProject): Promise<void> {
  try {
    const packageLockFile = project.packageLockFile;
    if (!packageLockFile || !packageLockFile.content) {
      project.summary.push(
        logger.formatter.warning(`No lock file found for package.json`)
      );
    } else {
      const lockFileType = packageLockFile.args.get('type');

      const sdkVersionInLockFile = extractVersionFromPackageLock(
        packageLockFile.content,
        lockFileType,
        PACKAGE_NAME_REACT_NATIVE
      );
      if (sdkVersionInLockFile) {
        project.summary.push(
          logger.formatter.info(
            `${PACKAGE_NAME_REACT_NATIVE} version in ${packageLockFile.readablePath} file set to ${sdkVersionInLockFile}`
          )
        );
      } else {
        project.summary.push(
          logger.formatter.warning(
            `${PACKAGE_NAME_REACT_NATIVE} not found in ${packageLockFile.readablePath}`
          )
        );
      }
    }
  } catch (err) {
    logger.error('Unable to read lock files for package.json: %s', err);
  }

  try {
    const podfileLock = project.podfileLock;
    const podfileLockContent = podfileLock.content!;

    const reactNativePodVersion = extractVersionFromPodLock(
      podfileLockContent,
      PACKAGE_NAME_REACT_NATIVE
    );
    if (reactNativePodVersion) {
      project.summary.push(
        logger.formatter.info(
          `${PACKAGE_NAME_REACT_NATIVE} version in ${podfileLock.readablePath} set to ${reactNativePodVersion}`
        )
      );
    } else {
      project.summary.push(
        logger.formatter.warning(
          `${PACKAGE_NAME_REACT_NATIVE} not found in ${podfileLock.readablePath}`
        )
      );
    }
  } catch (err) {
    logger.error(
      `Unable to read Podfile.lock at ${project.podfileLock.readablePath}: %s`,
      err
    );
  }
}
