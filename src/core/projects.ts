import * as path from 'path';
import { runChecksForIOS, runChecksForReactNative } from '../checks';
import { Links } from '../constants';
import { CheckGroup } from '../enums';
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

  projectFiles: {
    file: File;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    xcodeProject: any;
  }[];
  entitlementsFiles: File[];
  appDelegateFiles: File[];
}

// Use mixins to reuse code between classes
const iOSProjectBase = <TBase extends Constructor>(Base: TBase) =>
  class extends Base {
    public projectPath!: string;
    public iOSProjectPath!: string;
    public podfile!: File;
    public podfileLock!: File;
    public isUsingCocoaPods!: boolean;

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

    async runChecks(group: CheckGroup): Promise<void> {
      await runChecksForIOS(group);
    }
  };

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
    this.projectFile?.loadContent();
  }
}

export class ReactNativeProject
  extends iOSProjectBase(Object)
  implements MobileProject, iOSProject
{
  public readonly framework: string = 'React Native';
  public readonly documentation: Links.Documentation =
    Links.ReactNativeDocumentation;

  public readonly packageJsonFile: File;
  public packageLockFile?: File;

  constructor(projectPath: string) {
    super();
    this.projectPath = projectPath;
    this.iOSProjectPath = path.join(projectPath, 'ios');

    this.initIOSProject();
    this.packageJsonFile = new File(projectPath, 'package.json');
  }

  async loadFilesContent(): Promise<void> {
    await this.locateFiles();
    this.findPreferredLockFile();

    this.packageJsonFile.loadContent();
    this.podfile.loadContent();
    this.podfileLock.loadContent();
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
  }
}

export class FlutterProject
  extends iOSProjectBase(Object)
  implements MobileProject, iOSProject
{
  public readonly framework: string = 'Flutter';
  public readonly documentation: Links.Documentation =
    Links.FlutterDocumentation;

  public readonly pubspecYamlFile: File;
  public readonly pubspecLockFile: File;

  constructor(projectPath: string) {
    super();
    this.projectPath = projectPath;
    this.iOSProjectPath = path.join(projectPath, 'ios');

    this.initIOSProject();
    this.pubspecYamlFile = new File(projectPath, 'pubspec.yaml');
    this.pubspecLockFile = new File(projectPath, 'pubspec.lock');
  }

  async loadFilesContent(): Promise<void> {
    await this.locateFiles();

    this.pubspecYamlFile.loadContent();
    this.pubspecLockFile.loadContent();
    this.podfile.loadContent();
    this.podfileLock.loadContent();
  }

  async runChecks(group: CheckGroup): Promise<void> {
    // When added, run Flutter checks first because wrapper frameworks must be validated before native checks
    await super.runChecks(group);
  }
}
