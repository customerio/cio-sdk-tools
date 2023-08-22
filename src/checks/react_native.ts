import * as path from "path";
import { Conflicts, PACKAGE_NAME_REACT_NATIVE, Patterns } from "../constants";
import { Context, ReactNativeProject } from "../core";
import {
  getFileLinkStats,
  logger,
  readDirectory,
  readFileContent,
  runCatching,
} from "../utils";

export async function runAllChecks(): Promise<void> {
  const context = Context.get();
  const project = context.project as ReactNativeProject;

  await runCatching(validateSDKInitialization)(project);
  await runCatching(validateNoConflictingSDKs)(project);
  await runCatching(collectSummary)(project);
}

async function validateNoConflictingSDKs(
  project: ReactNativeProject,
): Promise<void> {
  const packageFile = project.packageJsonFile;
  logger.searching(
    `Checking for conflicting libraries in: ${packageFile.path}`,
  );

  const packageJson = JSON.parse(packageFile.content!);
  const dependencies = [...Object.keys(packageJson.dependencies || {})];

  const sdkVersionInPackageJson =
    packageJson.dependencies[PACKAGE_NAME_REACT_NATIVE];
  project.summary.push(
    logger.formatter.info(
      `${PACKAGE_NAME_REACT_NATIVE} version in package.json: ${sdkVersionInPackageJson}`,
    ),
  );

  const conflictingLibraries = Conflicts.reactNativePackages.filter((lib) =>
    dependencies.includes(lib),
  );

  if (conflictingLibraries.length === 0) {
    logger.success("No conflicting libraries found in package.json");
  } else {
    logger.warning(
      "More than one libraries found in package.json for handling push notifications",
      conflictingLibraries,
    );
  }
}

async function validateSDKInitialization(
  project: ReactNativeProject,
): Promise<void> {
  console.log(`🔎 Checking for SDK Initialization in React Native`);
  const sdkInitializationFile = searchFilesForSDKInitialization(
    project.projectPath,
  );
  if (sdkInitializationFile) {
    logger.success("SDK Initialization found in", sdkInitializationFile);
  } else {
    logger.warning(
      "SDK Initialization not found in suggested files",
      sdkInitializationFile,
    );
  }
}

const allowedExtensions = [".js", ".jsx", ".ts", ".tsx"];
const filesForCodeInspection = [
  "App.js",
  "App.jsx",
  "App.ts",
  "App.tsx",
  "FeaturesUpdate.js",
  "CustomerIOService.js",
  "CustomerIOService.ts",
];

function searchFilesForSDKInitialization(
  directoryPath: string,
): string | undefined {
  let fileNameForSDKInitialization = undefined;
  const files = readDirectory(directoryPath);
  if (!files || files.length === 0) return undefined;

  for (const file of files) {
    const filePath = path.join(directoryPath, file);
    const linkStat = getFileLinkStats(filePath);
    if (
      file.startsWith(".") ||
      file.startsWith("_") ||
      file.startsWith("node_modules") ||
      !linkStat ||
      linkStat?.isSymbolicLink === true
    ) {
      continue;
    }

    if (
      !linkStat.isDirectory &&
      !linkStat.isFile &&
      !allowedExtensions.includes(path.extname(file))
    ) {
      continue;
    }

    if (linkStat.isDirectory) {
      fileNameForSDKInitialization = searchFilesForSDKInitialization(filePath);
      if (fileNameForSDKInitialization) {
        break;
      }
    } else if (linkStat.isFile && filesForCodeInspection.includes(file)) {
      const fileContent = readFileContent(filePath);
      if (fileContent && fileContent.includes("CustomerIO.initialize")) {
        return file;
      }
    }
  }

  return fileNameForSDKInitialization;
}

async function collectSummary(project: ReactNativeProject): Promise<void> {
  try {
    const packageLockFile = project.packageLockFile;
    if (!packageLockFile || !packageLockFile.content) {
      project.summary.push(
        logger.formatter.warning(`No lock file found for package.json`),
      );
    } else {
      let sdkVersionInLockFile: string | undefined;
      const lockFileType = packageLockFile.args.get("type");

      if (lockFileType === "yarn") {
        const yarnLockVersionMatch = packageLockFile.content.match(
          new RegExp(
            `${PACKAGE_NAME_REACT_NATIVE}@[^:]+:\\s*\\n\\s*version\\s*"([^"]+)"`,
          ),
        );
        sdkVersionInLockFile = yarnLockVersionMatch
          ? yarnLockVersionMatch[1]
          : undefined;
      } else if (lockFileType === "npm") {
        const npmLockJson = JSON.parse(packageLockFile.content);
        sdkVersionInLockFile =
          npmLockJson.dependencies[PACKAGE_NAME_REACT_NATIVE].version;
      }

      if (sdkVersionInLockFile) {
        project.summary.push(
          logger.formatter.info(
            `${PACKAGE_NAME_REACT_NATIVE} version in ${packageLockFile.path} file set to ${sdkVersionInLockFile}`,
          ),
        );
      } else {
        project.summary.push(
          logger.formatter.warning(
            `${PACKAGE_NAME_REACT_NATIVE} not found in ${packageLockFile.path}`,
          ),
        );
      }
    }
  } catch (err) {
    logger.error("Unable to read lock files for package.json: %s", err);
  }

  try {
    const podfileLock = project.podfileLock;
    const podfileLockContent = podfileLock.content!;

    const reactNativePodMatch = podfileLockContent.match(
      Patterns.iOS_POD_CIO_REACT_NATIVE,
    );
    if (reactNativePodMatch && reactNativePodMatch[1]) {
      project.summary.push(
        logger.formatter.info(
          `${PACKAGE_NAME_REACT_NATIVE} version in ${podfileLock.path} set to ${reactNativePodMatch[1]}`,
        ),
      );
    } else {
      project.summary.push(
        logger.formatter.warning(
          `${PACKAGE_NAME_REACT_NATIVE} not found in ${podfileLock.path}`,
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
