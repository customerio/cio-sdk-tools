import { Command, Option } from "commander";
import * as fs from "fs";
import * as path from "path";
import {
  Context,
  FlutterProject,
  MobileProject,
  ReactNativeProject,
  iOSNativeProject,
} from "./core";
import {
  getFilename,
  isDirectoryNonEmpty,
  logger,
  readFileContent,
} from "./utils";
import { configureLogger } from "./utils/logger";

const program = new Command();

async function doctor(projectPath: string) {
  if (!isDirectoryNonEmpty(projectPath)) {
    logger.error(
      `Project directory is not valid or is empty at ${projectPath}`,
    );
    process.exit(1);
  }

  const project = identifyProject(projectPath);
  if (!project) {
    logger.error(`Unable to identify project framework in ${projectPath}`);
    process.exit(1);
  }

  logger.info(
    `Detected framework: ${project.framework} in ${getFilename(projectPath)}`,
  );
  Context.create(project);

  await project.loadFilesContent();
  await project.runAllChecks();

  logger.result(`Collecting more information on project`);
  for (const summary of project.summary) {
    logger.log(summary);
  }
}

function identifyProject(projectDirectory: string): MobileProject | undefined {
  // Check for React Native (looking for 'react-native' in package.json)
  if (fs.existsSync(path.join(projectDirectory, "package.json"))) {
    const packageContent = fs.readFileSync(
      path.join(projectDirectory, "package.json"),
      "utf8",
    );
    if (packageContent.includes('"react-native"')) {
      return new ReactNativeProject(projectDirectory);
    }
  }

  // Check for Flutter (looking for a pubspec.yaml file)
  if (fs.existsSync(path.join(projectDirectory, "pubspec.yaml"))) {
    return new FlutterProject(projectDirectory);
  }

  // Check for iOS Native (looking for a .xcodeproj directory)
  const files = fs.readdirSync(projectDirectory);
  const xcodeProjectExists = files.some((file) => file.endsWith(".xcodeproj"));
  if (xcodeProjectExists) {
    return new iOSNativeProject(projectDirectory);
  }

  return undefined;
}

const packageJson = JSON.parse(
  readFileContent(path.join(__dirname, "../package.json"))!,
);

program
  .name(packageJson.name)
  .version(packageJson.version, "--version")
  .description(packageJson.description);

program
  .command("doctor")
  .description(
    "Analyzes the project at the given path, performs diagnostics, and provides recommendations for improvements",
  )
  .argument("[path]", "Path to project directory", ".")
  .addOption(
    new Option(
      "-v, --verbose",
      "Enable verbose mode, providing detailed information about the operations",
    ).default(true),
  )
  .addOption(new Option("-r, --report <filename>", "Output report to file"))
  .action((path, options) => {
    configureLogger({
      verbose: options.verbose,
      saveReport: options.report,
    });
    doctor(path).catch((err) => logger.error("Error running doctor:", err));
  });

program.parse();
