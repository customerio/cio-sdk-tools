import { Commands, Conflicts, PACKAGE_NAME_REACT_NATIVE } from '../constants';
import { Context, ReactNativeProject } from '../core';
import { CheckGroup } from '../types';
import {
  extractVersionFromPackageJson,
  extractVersionFromPackageLock,
  fetchCachedLatestVersion,
  logger,
  removeNonAlphanumericChars,
  runCatching,
  searchFilesForCode,
} from '../utils';
import { doesExists, readFileContent } from '../utils/file';
import * as path from 'path';

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

function checkExpoPluginConfig(content: string, filename: string): boolean {
  // For app.json, parse as JSON
  if (filename.endsWith('.json')) {
    try {
      const appJson = JSON.parse(content);
      const plugins = appJson?.expo?.plugins || [];

      for (const plugin of plugins) {
        if (Array.isArray(plugin) && plugin[0] === 'customerio-expo-plugin') {
          const pluginConfig = plugin[1];
          if (pluginConfig && pluginConfig.config) {
            logger.debug(
              `Found Expo auto-initialization config in ${filename}`
            );
            return true;
          }
        }
      }
    } catch (err) {
      logger.debug(`Failed to parse ${filename}: ${err}`);
    }
  } else {
    // For app.config.js/ts, look for the plugin array entry with config
    // Pattern: ['customerio-expo-plugin', { ... config: { ... }]
    // Use non-greedy match (.*?) to handle nested objects (android: {}, ios: {}) before config
    const pluginPattern = /['"]customerio-expo-plugin['"],\s*\{.*?config\s*:/s;
    if (pluginPattern.test(content)) {
      logger.debug(`Found Expo auto-initialization config in ${filename}`);
      return true;
    }
  }

  return false;
}

function checkExpoAutoInitialization(
  project: ReactNativeProject
): string | null {
  logger.debug(`Checking for Expo auto-initialization config`);

  // Expo config files in order of precedence
  // When a higher-precedence file exists, lower-precedence files are ignored by Expo
  const configFiles = ['app.config.ts', 'app.config.js', 'app.json'];

  // Find which config file Expo will actually use
  let activeConfigFile: string | null = null;
  for (const configFile of configFiles) {
    const configPath = path.join(project.projectPath, configFile);
    if (doesExists(configPath)) {
      activeConfigFile = configFile;
      break; // Stop at first existing file (highest precedence)
    }
  }

  // Check only the active config file (the one Expo actually reads)
  if (activeConfigFile) {
    const configPath = path.join(project.projectPath, activeConfigFile);
    const content = readFileContent(configPath);
    if (content && checkExpoPluginConfig(content, activeConfigFile)) {
      return activeConfigFile;
    }
  }

  return null;
}

async function validateSDKInitialization(
  project: ReactNativeProject
): Promise<void> {
  logger.debug(`Checking for SDK Initialization in React Native`);

  // Check for Expo auto-initialization first
  const expoConfigFile = checkExpoAutoInitialization(project);
  if (expoConfigFile) {
    logger.success(
      `SDK auto-initialization configured in ${expoConfigFile} (Expo plugin)`
    );
    return;
  }

  // Check for manual CustomerIO.initialize() call
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
      targetFilePatterns: [
        'cio',
        'customerio',
        'init',
        'setup',
        'config',
        'start',
        'main',
        'route',
        'navigation',
        'provider',
        'splash',
      ],
    },
    project.projectPath
  );

  if (sdkInitializationFiles.matchedFiles.length > 0) {
    logger.success(
      `React Native SDK Initialization found in ${sdkInitializationFiles.formattedMatchedFiles}`
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
      logger.failure('React Native SDK Initialization not found');
    } else {
      logger.failure(
        'React Native SDK Initialization not found. For more details, run the script with the -v flag'
      );
    }
  }
}

async function validateSDKVersion(project: ReactNativeProject): Promise<void> {
  const latestSdkVersion = await fetchCachedLatestVersion(
    PACKAGE_NAME_REACT_NATIVE
  );

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
