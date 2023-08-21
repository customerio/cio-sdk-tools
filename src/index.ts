import * as fs from "fs";
import * as path from "path";
import {
  Context,
  FlutterProject,
  MobileProject,
  ReactNativeProject,
  iOSNativeProject,
} from "./core";
import { isDirectoryNonEmpty, logger } from "./utils";

diagnose().catch((err) => console.error("Error running diagnostics:", err));

async function diagnose() {
  const projectPath = process.argv[2];
  if (!isDirectoryNonEmpty(projectPath)) {
    logger.logWithFormat((formatter) =>
      formatter.error(
        `Project directory is not valid or is empty at ${projectPath}`,
      ),
    );
    process.exit(1);
  }

  const project = identifyProject(projectPath);
  if (!project) {
    logger.logWithFormat((formatter) =>
      formatter.error(`Unable to identify project framework in ${projectPath}`),
    );
    process.exit(1);
  }

  logger.logWithFormat((formatter) =>
    formatter.info(
      `Detected framework: ${project.framework} in ${projectPath}`,
    ),
  );
  Context.create(project);

  await project.loadFilesContent();
  await project.runAllChecks();

  logger.logWithFormat((formatter) =>
    formatter.result(`Collecting more information on project`),
  );
  for (const summary of project.summary) {
    logger.log(summary);
  }
}

function identifyProject(projectDirectory: string): MobileProject | undefined {
  // Check for React Native (e.g., looking for 'react-native' in package.json)
  if (fs.existsSync(path.join(projectDirectory, "package.json"))) {
    const packageContent = fs.readFileSync(
      path.join(projectDirectory, "package.json"),
      "utf8",
    );
    if (packageContent.includes('"react-native"')) {
      return new ReactNativeProject(projectDirectory);
    }
  }

  // Check for Flutter (e.g., looking for a pubspec.yaml file)
  if (fs.existsSync(path.join(projectDirectory, "pubspec.yaml"))) {
    return new FlutterProject(projectDirectory);
  }

  // Check for iOS Native (e.g., looking for a .xcodeproj directory)
  if (fs.existsSync(path.join(projectDirectory, "*.xcodeproj"))) {
    return new iOSNativeProject(projectDirectory);
  }

  return undefined;
}
