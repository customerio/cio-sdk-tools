import { Conflicts, PACKAGE_NAME_REACT_NATIVE, Patterns } from "../constants";
import { Context, ReactNativeProject } from "../core";
import { logger, runCatching } from "../utils";

export async function runAllChecks(): Promise<void> {
  const context = Context.get();
  const project = context.project as ReactNativeProject;

  await runCatching(validateNoConflictingSDKs)(project);
  await runCatching(collectSummary)(project);
}

async function validateNoConflictingSDKs(
  project: ReactNativeProject,
): Promise<void> {
  const packageFile = project.packageJsonFile;
  console.log(`🔎 Checking for conflicting libraries in: ${packageFile.path}`);

  const packageJson = JSON.parse(packageFile.content!);
  const dependencies = [...Object.keys(packageJson.dependencies || {})];

  const sdkVersionInPackageJson =
    packageJson.dependencies[PACKAGE_NAME_REACT_NATIVE];
  project.summary.push(
    `👉 ${PACKAGE_NAME_REACT_NATIVE} version in package.json: ${sdkVersionInPackageJson}`,
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

async function collectSummary(project: ReactNativeProject): Promise<void> {
  try {
    const packageLockFile = project.packageLockFile;
    if (!packageLockFile || !packageLockFile.content) {
      project.summary.push(`❌ No lock file found for package.json`);
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
          `👉 ${PACKAGE_NAME_REACT_NATIVE} version in ${packageLockFile.path} file set to ${sdkVersionInLockFile}`,
        );
      } else {
        project.summary.push(
          `❌ ${PACKAGE_NAME_REACT_NATIVE} not found in ${packageLockFile.path}`,
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
        `👉 ${PACKAGE_NAME_REACT_NATIVE} version in ${podfileLock.path} set to ${reactNativePodMatch[1]}`,
      );
    } else {
      project.summary.push(
        `❌ ${PACKAGE_NAME_REACT_NATIVE} not found in ${podfileLock.path}`,
      );
    }
  } catch (err) {
    logger.error(
      `Unable to read Podfile.lock at ${project.podfileLock.path}: %s`,
      err,
    );
  }
}