import * as path from "path";
import { runAllChecksForIOS, runAllChecksForReactNative } from "../checks";
import { Patterns } from "../constants";
import {
  readFileContent,
  readFileWithStats,
  searchFileInDirectory,
} from "../utils/file";

type Constructor = new (...args: any[]) => any;

class File {
  readonly args: Map<string, any>;
  readonly path: string;
  content: string | undefined;

  constructor(path: string, args?: Record<string, any>) {
    this.path = path;
    this.args = new Map(Object.entries(args || {}));
  }

  loadContent() {
    if (!this.content) {
      this.content = readFileContent(this.path);
    }
  }
}

export interface MobileProject {
  readonly framework: string;
  readonly projectPath: string;
  readonly summary: string[];

  loadFilesContent(): Promise<void>;
  runAllChecks(): Promise<void>;
}

export interface iOSProject extends MobileProject {
  readonly iOSProjectPath: string;

  podfile: File;
  podfileLock: File;

  projectFiles: File[];
  entitlementsFiles: File[];
  appDelegateFiles: File[];
}

// Use mixins to reuse code between classes
const iOSProjectBase = <TBase extends Constructor>(Base: TBase) =>
  class extends Base {
    public iOSProjectPath!: string;
    public podfile!: File;
    public podfileLock!: File;

    public projectFiles: File[] = [];
    public entitlementsFiles: File[] = [];
    public appDelegateFiles: File[] = [];

    constructor(...args: any[]) {
      super(...args);
    }

    // Must be called from constructor only
    initIOSProject(iOSProjectPath: string) {
      this.iOSProjectPath = iOSProjectPath;
      this.podfile = new File(path.join(iOSProjectPath, "Podfile"));
      this.podfileLock = new File(path.join(iOSProjectPath, "Podfile.lock"));
    }

    async locateFiles(projectPath: string): Promise<void> {
      const ignoreDirs = ["/Pods/"];

      const fileKeys = {
        appDelegateObjectiveC: "AppDelegate.m",
        appDelegateObjectiveCPlusPlus: "AppDelegate.mm",
        appDelegateSwift: "AppDelegate.swift",
        entitlements: "entitlements",
        project: "pbxproj",
      };
      const filters = new Map<string, RegExp>();
      filters.set(fileKeys.project, Patterns.iOS_PROJECT_XCODE);
      filters.set(fileKeys.entitlements, Patterns.iOS_ENTITLEMENTS);
      filters.set(fileKeys.appDelegateSwift, Patterns.iOS_APP_DELEGATE_SWIFT);
      filters.set(
        fileKeys.appDelegateObjectiveC,
        Patterns.iOS_APP_DELEGATE_OBJECTIVE_C,
      );
      filters.set(
        fileKeys.appDelegateObjectiveCPlusPlus,
        Patterns.iOS_APP_DELEGATE_OBJECTIVE_C_PLUS_PLUS,
      );

      const results = await searchFileInDirectory(
        projectPath,
        filters,
        ignoreDirs,
      );

      this.projectFiles = this.projectFiles.concat(
        results[fileKeys.project].map((result) => new File(result)),
      );
      this.entitlementsFiles = this.entitlementsFiles.concat(
        results[fileKeys.entitlements].map((result) => new File(result)),
      );

      this.appDelegateFiles = this.appDelegateFiles.concat(
        results[fileKeys.appDelegateSwift].map(
          (result) => new File(result, { extension: "swift" }),
        ),
      );
      this.appDelegateFiles = this.appDelegateFiles.concat(
        results[fileKeys.appDelegateObjectiveC].map(
          (result) => new File(result, { extension: "Objective-C" }),
        ),
      );
      this.appDelegateFiles = this.appDelegateFiles.concat(
        results[fileKeys.appDelegateObjectiveCPlusPlus].map(
          (result) => new File(result, { extension: "Objective-C++" }),
        ),
      );
    }
  };

export class iOSNativeProject
  extends iOSProjectBase(Object)
  implements MobileProject, iOSProject
{
  public readonly framework: string = "iOS";
  public readonly projectPath: string;
  public readonly summary: string[] = [];

  constructor(projectPath: string) {
    super();
    this.projectPath = projectPath;
    this.initIOSProject(this.projectPath);
  }

  async loadFilesContent(): Promise<void> {
    await this.locateFiles(this.projectPath);

    this.podfile.loadContent();
    this.podfileLock.loadContent();
    this.projectFile?.loadContent();
    this.entitlementsFile?.loadContent();
    this.appDelegateFile?.loadContent();
  }

  async runAllChecks(): Promise<void> {
    await runAllChecksForIOS();
  }
}

export class ReactNativeProject
  extends iOSProjectBase(Object)
  implements MobileProject, iOSProject
{
  public readonly framework: string = "ReactNative";
  public readonly projectPath: string;
  public readonly summary: string[] = [];

  public readonly packageJsonFile: File;
  public packageLockFile?: File;

  constructor(projectPath: string) {
    super();
    this.projectPath = projectPath;
    this.iOSProjectPath = path.join(projectPath, "ios");

    this.initIOSProject(this.iOSProjectPath);
    this.packageJsonFile = new File(path.join(projectPath, "package.json"));
  }

  async loadFilesContent(): Promise<void> {
    await this.locateFiles(this.iOSProjectPath);
    this.findPreferredLockFile();

    this.packageJsonFile.loadContent();
    this.podfile.loadContent();
    this.podfileLock.loadContent();
  }

  findPreferredLockFile() {
    const yarnLockFilePath = path.join(this.projectPath, "yarn.lock");
    const npmLockFilePath = path.join(this.projectPath, "package-lock.json");

    const results = readFileWithStats([yarnLockFilePath, npmLockFilePath]);
    let packageLockFileIndex: number;
    if ((results[0].lastUpdated ?? 0) >= (results[1].lastUpdated ?? 0)) {
      packageLockFileIndex = 0;
    } else {
      packageLockFileIndex = 1;
    }

    const result = results[packageLockFileIndex];
    if (result.content) {
      let type: string;
      if (result.path === yarnLockFilePath) {
        type = "yarn";
      } else {
        type = "npm";
      }

      this.packageLockFile = new File(result.path, { type: type });
      this.packageLockFile.content = result.content;
    }
  }

  async runAllChecks(): Promise<void> {
    await runAllChecksForReactNative();
    await runAllChecksForIOS();
  }
}

export class FlutterProject
  extends iOSProjectBase(Object)
  implements MobileProject, iOSProject
{
  public readonly framework: string = "Flutter";
  public readonly projectPath: string;
  public readonly summary: string[] = [];

  public readonly pubspecYamlFile: File;
  public readonly pubspecLockFile: File;

  constructor(projectPath: string) {
    super();
    this.projectPath = projectPath;
    this.iOSProjectPath = path.join(projectPath, "ios");

    this.initIOSProject(this.iOSProjectPath);
    this.pubspecYamlFile = new File(path.join(projectPath, "pubspec.yaml"));
    this.pubspecLockFile = new File(path.join(projectPath, "pubspec.lock"));
  }

  async loadFilesContent(): Promise<void> {
    await this.locateFiles(this.iOSProjectPath);

    this.pubspecYamlFile.loadContent();
    this.pubspecLockFile.loadContent();
    this.podfile.loadContent();
    this.podfileLock.loadContent();
  }

  async runAllChecks(): Promise<void> {
    await runAllChecksForIOS();
  }
}
