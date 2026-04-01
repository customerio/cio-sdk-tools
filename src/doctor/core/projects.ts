import * as fs from 'fs';
import * as path from 'path';
import { runChecksForIOS, runChecksForReactNative } from '../checks';
import { Links } from '../constants';
import { CheckGroup } from '../types';
import { createFilePattern } from '../utils';
import {
  doesExists,
  getAbsolutePath,
  getFilename,
  getReadablePath,
  readFileContent,
  readFileWithStats,
  searchFileInDirectory,
} from '../utils/file';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import xcode from 'xcode';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Constructor = new (...args: any[]) => any;

class File {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly args: Map<string, any>;
  readonly filename: string;
  readonly absolutePath: string;
  readonly readablePath: string;
  content: string | undefined;

  constructor(
    projectRoot: string,
    filepath: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args?: Record<string, any>,
    loadContent: boolean = false
  ) {
    this.absolutePath = getAbsolutePath(projectRoot, filepath);
    this.args = new Map(Object.entries(args || {}));
    this.filename = getFilename(this.absolutePath);
    this.readablePath = getReadablePath(projectRoot, this.absolutePath);
    if (loadContent) {
      this.loadContent();
    }
  }

  loadContent() {
    if (!this.content) {
      this.content = readFileContent(this.absolutePath);
    }
  }
}

export interface MobileProject {
  readonly framework: string;
  readonly projectPath: string;
  readonly documentation: Links.Documentation;

  loadFilesContent(): Promise<void>;
  runChecks(group: CheckGroup): Promise<void>;
}

export interface iOSProject extends MobileProject {
  readonly iOSProjectPath: string;

  podfile: File;
  podfileLock: File;
  isUsingCocoaPods: boolean;

  packageResolved: File;
  isUsingSPM: boolean;

  projectFiles: {
    file: File;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    xcodeProject: any;
  }[];
  entitlementsFiles: File[];
  appDelegateFiles: File[];
}

export interface AndroidProject extends MobileProject {
  readonly androidProjectPath: string;
  appBuildGradle: File;
  rootBuildGradle: File;
  googleServicesJson: File;
  androidManifest: File;
  isWrapperFramework: boolean;
}

// Use mixins to reuse code between classes
const iOSProjectBase = <TBase extends Constructor>(Base: TBase) =>
  class extends Base {
    public projectPath!: string;
    public iOSProjectPath!: string;
    public podfile!: File;
    public podfileLock!: File;
    public isUsingCocoaPods!: boolean;
    public packageResolved!: File;
    public isUsingSPM!: boolean;

    projectFiles: {
      file: File;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      xcodeProject: any;
    }[];
    public entitlementsFiles: File[] = [];
    public appDelegateFiles: File[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(...args: any[]) {
      super(...args);
      this.projectFiles = [];
    }

    // Must be called from constructor only
    initIOSProject() {
      // Pass project path to File constructor for relative path calculation
      this.podfile = new File(
        this.projectPath,
        path.join(this.iOSProjectPath, 'Podfile')
      );
      this.podfileLock = new File(
        this.projectPath,
        path.join(this.iOSProjectPath, 'Podfile.lock')
      );
      this.isUsingCocoaPods = doesExists(this.podfile.absolutePath);

      this.packageResolved = new File(
        this.projectPath,
        this.findPackageResolved()
      );
      this.isUsingSPM = doesExists(this.packageResolved.absolutePath);
    }

    async locateFiles(): Promise<void> {
      const filesRecord: Record<string, string> = {
        appDelegateObjectiveC: 'AppDelegate.m',
        appDelegateObjectiveCPlusPlus: 'AppDelegate.mm',
        appDelegateSwift: 'AppDelegate.swift',
        entitlements: '.entitlements',
        project: '.pbxproj',
      };

      const filters = new Map<string, RegExp>();
      for (const key in filesRecord) {
        const filename = filesRecord[key];
        filters.set(filename, createFilePattern(filename));
      }

      const results = await searchFileInDirectory(this.iOSProjectPath, filters);

      this.projectFiles = this.projectFiles.concat(
        results[filesRecord.project].map((result) => {
          const xcodeProject = xcode.project(result);
          xcodeProject.parseSync();
          return {
            file: new File(this.projectPath, result, {}, true),
            xcodeProject: xcodeProject,
          };
        })
      );
      this.entitlementsFiles = this.entitlementsFiles.concat(
        results[filesRecord.entitlements].map(
          (result) => new File(this.projectPath, result, {}, true)
        )
      );

      this.appDelegateFiles = this.appDelegateFiles.concat(
        results[filesRecord.appDelegateSwift].map(
          (result) =>
            new File(this.projectPath, result, { extension: 'swift' }, true)
        )
      );
      this.appDelegateFiles = this.appDelegateFiles.concat(
        results[filesRecord.appDelegateObjectiveC].map(
          (result) =>
            new File(
              this.projectPath,
              result,
              { extension: 'Objective-C' },
              true
            )
        )
      );
      this.appDelegateFiles = this.appDelegateFiles.concat(
        results[filesRecord.appDelegateObjectiveCPlusPlus].map(
          (result) =>
            new File(
              this.projectPath,
              result,
              { extension: 'Objective-C++' },
              true
            )
        )
      );
    }

    /** Finds Package.resolved in common SPM locations, returns default if not found */
    findPackageResolved(): string {
      // SPM Package.resolved can be in several locations:
      // 1. <project>.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
      // 2. <project>.xcworkspace/xcshareddata/swiftpm/Package.resolved
      // 3. .swiftpm/xcode/Package.resolved (for package projects)
      // 4. Package.resolved (root level)

      try {
        const entries = fs.readdirSync(this.iOSProjectPath);

        // Look for .xcodeproj first
        for (const entry of entries) {
          if (entry.endsWith('.xcodeproj')) {
            const packageResolvedPath = path.join(
              this.iOSProjectPath,
              entry,
              'project.xcworkspace',
              'xcshareddata',
              'swiftpm',
              'Package.resolved'
            );
            if (doesExists(packageResolvedPath)) {
              return packageResolvedPath;
            }
          }
        }

        // Look for .xcworkspace
        for (const entry of entries) {
          if (entry.endsWith('.xcworkspace')) {
            const packageResolvedPath = path.join(
              this.iOSProjectPath,
              entry,
              'xcshareddata',
              'swiftpm',
              'Package.resolved'
            );
            if (doesExists(packageResolvedPath)) {
              return packageResolvedPath;
            }
          }
        }

        // Check .swiftpm/xcode location
        const swiftpmPath = path.join(
          this.iOSProjectPath,
          '.swiftpm',
          'xcode',
          'Package.resolved'
        );
        if (doesExists(swiftpmPath)) {
          return swiftpmPath;
        }

        // Check root level
        const rootPath = path.join(this.iOSProjectPath, 'Package.resolved');
        if (doesExists(rootPath)) {
          return rootPath;
        }
      } catch (error) {
        // If we can't read the directory, fall through to default
      }

      // Return default path - will be used to check if SPM is present
      return path.join(this.iOSProjectPath, 'Package.resolved');
    }

    async runChecks(group: CheckGroup): Promise<void> {
      await runChecksForIOS(group);
    }
  };

// Android mixin for code reuse between Android projects
const AndroidProjectBase = <TBase extends Constructor>(Base: TBase) =>
  class extends Base {
    public projectPath!: string;
    public androidProjectPath!: string;
    public appBuildGradle!: File;
    public rootBuildGradle!: File;
    public googleServicesJson!: File;
    public androidManifest!: File;
    public isWrapperFramework: boolean = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(...args: any[]) {
      super(...args);
    }

    // Must be called from constructor only
    initAndroidProject() {
      // Determine app build.gradle path
      // Two possible structures:
      // 1. Multi-module: android/app/build.gradle (wrapper frameworks) or app/build.gradle (native)
      // 2. Single-module: build.gradle at root (sample apps)

      const appBuildPaths = [
        path.join(this.androidProjectPath, 'app', 'build.gradle'),
        path.join(this.androidProjectPath, 'app', 'build.gradle.kts'),
      ];

      const rootBuildPaths = [
        path.join(this.androidProjectPath, 'build.gradle'),
        path.join(this.androidProjectPath, 'build.gradle.kts'),
      ];

      // Find app build.gradle (Groovy or Kotlin DSL)
      let appBuildPath = appBuildPaths[0]; // default
      let isSingleModule = false;

      for (const buildPath of appBuildPaths) {
        if (doesExists(buildPath)) {
          appBuildPath = buildPath;
          break;
        }
      }

      // If app/build.gradle doesn't exist, check if root build.gradle is the app module
      if (!doesExists(appBuildPath)) {
        for (const buildPath of rootBuildPaths) {
          if (doesExists(buildPath)) {
            const content = fs.readFileSync(buildPath, 'utf8');
            if (content.includes('com.android.application')) {
              appBuildPath = buildPath;
              isSingleModule = true;
              break;
            }
          }
        }
      }

      // Find root build.gradle (Groovy or Kotlin DSL)
      let rootBuildPath = rootBuildPaths[0]; // default
      for (const buildPath of rootBuildPaths) {
        if (doesExists(buildPath)) {
          rootBuildPath = buildPath;
          break;
        }
      }

      this.appBuildGradle = new File(this.projectPath, appBuildPath);
      this.rootBuildGradle = new File(this.projectPath, rootBuildPath);

      // For single-module projects, files are at root level
      // For multi-module projects, files are in app/ subdirectory
      const appSubdir = isSingleModule ? '' : 'app';

      this.googleServicesJson = new File(
        this.projectPath,
        path.join(this.androidProjectPath, appSubdir, 'google-services.json')
      );
      this.androidManifest = new File(
        this.projectPath,
        path.join(
          this.androidProjectPath,
          appSubdir,
          'src',
          'main',
          'AndroidManifest.xml'
        )
      );
    }

    async loadAndroidFilesContent(): Promise<void> {
      this.appBuildGradle.loadContent();
      this.rootBuildGradle.loadContent();
      this.googleServicesJson.loadContent();
      this.androidManifest.loadContent();
    }

    async runAndroidChecks(group: CheckGroup): Promise<void> {
      const { runChecks } = await import('../checks/android.js');
      await runChecks(group);
    }
  };

export class AndroidNativeProject
  extends AndroidProjectBase(Object)
  implements MobileProject, AndroidProject
{
  public readonly framework: string = 'Android';
  public readonly documentation: Links.Documentation =
    Links.AndroidDocumentation;

  constructor(projectPath: string) {
    super();
    this.projectPath = projectPath;
    this.androidProjectPath = projectPath;
    this.isWrapperFramework = false;
    this.initAndroidProject();
  }

  async loadFilesContent(): Promise<void> {
    await this.loadAndroidFilesContent();
  }

  async runChecks(group: CheckGroup): Promise<void> {
    await this.runAndroidChecks(group);
  }
}

export class iOSNativeProject
  extends iOSProjectBase(Object)
  implements MobileProject, iOSProject
{
  public readonly framework: string = 'iOS';
  public readonly documentation: Links.Documentation = Links.iOSDocumentation;

  constructor(projectPath: string) {
    super();
    this.projectPath = projectPath;
    this.iOSProjectPath = projectPath;
    this.initIOSProject();
  }

  async loadFilesContent(): Promise<void> {
    await this.locateFiles();

    this.podfile.loadContent();
    this.podfileLock.loadContent();
    this.packageResolved.loadContent();
    this.projectFile?.loadContent();
  }
}

export class ReactNativeProject
  extends iOSProjectBase(AndroidProjectBase(Object))
  implements MobileProject, iOSProject, AndroidProject
{
  public readonly framework: string = 'React Native';
  public readonly documentation: Links.Documentation =
    Links.ReactNativeDocumentation;

  public readonly packageJsonFile: File;
  public packageLockFile?: File;
  public isWrapperFramework: boolean = true;

  constructor(projectPath: string) {
    super();
    this.projectPath = projectPath;
    this.iOSProjectPath = path.join(projectPath, 'ios');

    this.initIOSProject();

    // Check if android directory exists
    const androidPath = path.join(projectPath, 'android');
    if (doesExists(androidPath)) {
      this.androidProjectPath = androidPath;
      this.initAndroidProject();
    }

    this.packageJsonFile = new File(projectPath, 'package.json');
  }

  async loadFilesContent(): Promise<void> {
    await this.locateFiles();
    this.findPreferredLockFile();

    this.packageJsonFile.loadContent();
    this.podfile.loadContent();
    this.podfileLock.loadContent();
    this.packageResolved.loadContent();

    // Load Android files if android directory exists
    if (this.androidProjectPath) {
      await this.loadAndroidFilesContent();
    }
  }

  findPreferredLockFile() {
    const yarnLockFilePath = path.join(this.projectPath, 'yarn.lock');
    const npmLockFilePath = path.join(this.projectPath, 'package-lock.json');

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
        type = 'yarn';
      } else {
        type = 'npm';
      }

      this.packageLockFile = new File(this.projectPath, result.path, {
        type: type,
      });
      this.packageLockFile.content = result.content;
    }
  }

  async runChecks(group: CheckGroup): Promise<void> {
    // Run React Native checks first because wrapper frameworks must be validated before native checks
    await runChecksForReactNative(group);
    await super.runChecks(group);

    // Run Android checks if android directory exists
    if (this.androidProjectPath) {
      await this.runAndroidChecks(group);
    }
  }
}

export class FlutterProject
  extends iOSProjectBase(AndroidProjectBase(Object))
  implements MobileProject, iOSProject, AndroidProject
{
  public readonly framework: string = 'Flutter';
  public readonly documentation: Links.Documentation =
    Links.FlutterDocumentation;

  public readonly pubspecYamlFile: File;
  public readonly pubspecLockFile: File;
  public isWrapperFramework: boolean = true;

  constructor(projectPath: string) {
    super();
    this.projectPath = projectPath;
    this.iOSProjectPath = path.join(projectPath, 'ios');

    this.initIOSProject();

    // Check if android directory exists
    const androidPath = path.join(projectPath, 'android');
    if (doesExists(androidPath)) {
      this.androidProjectPath = androidPath;
      this.initAndroidProject();
    }

    this.pubspecYamlFile = new File(projectPath, 'pubspec.yaml');
    this.pubspecLockFile = new File(projectPath, 'pubspec.lock');
  }

  async loadFilesContent(): Promise<void> {
    await this.locateFiles();

    this.pubspecYamlFile.loadContent();
    this.pubspecLockFile.loadContent();
    this.podfile.loadContent();
    this.podfileLock.loadContent();
    this.packageResolved.loadContent();

    // Load Android files if android directory exists
    if (this.androidProjectPath) {
      await this.loadAndroidFilesContent();
    }
  }

  async runChecks(group: CheckGroup): Promise<void> {
    // When added, run Flutter checks first because wrapper frameworks must be validated before native checks
    await super.runChecks(group);

    // Run Android checks if android directory exists
    if (this.androidProjectPath) {
      await this.runAndroidChecks(group);
    }
  }
}
