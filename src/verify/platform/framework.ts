import { promises as fs } from 'fs';
import * as path from 'path';
import { Framework } from '../core/report/types';

/** How each framework is named to a person. */
export const FRAMEWORK_NAMES: Record<Framework, string> = {
  'native': 'native',
  'react-native': 'React Native',
  'expo': 'Expo',
  'flutter': 'Flutter',
};

/**
 * What the app is built with, read from the folders around its native project.
 *
 * React Native, Expo and Flutter apps keep their native projects under `ios/` and `android/`,
 * with the framework's own manifest beside those folders. The run verifies the native half
 * either way; this only names the app for whoever reads the report. The native project's
 * folder and two above it are enough: an Xcode project sits in `ios/`, an Android app
 * module in `android/app/`.
 */
export async function detectFramework(nativePath: string): Promise<Framework> {
  return (await wrapperRoot(nativePath))?.framework ?? 'native';
}

/** The Customer.io package each wrapper framework installs. */
const WRAPPER_PACKAGES: Record<Exclude<Framework, 'native'>, string> = {
  'react-native': 'customerio-reactnative',
  'expo': 'customerio-reactnative',
  'flutter': 'customer_io',
};

export interface WrapperInitSite {
  /** Relative to the wrapper app's root. */
  file: string;
  line: number;
}

export interface WrapperSdk {
  framework: Exclude<Framework, 'native'>;
  /** `customerio-reactnative` or `customer_io`. */
  name: string;
  /** The folder holding the app's package.json or pubspec.yaml. */
  root: string;
  /** The app's own manifest names the package. */
  declared: boolean;
  /** Where the package is installed, once `npm install` or `flutter pub get` has run. */
  directory?: string;
  version?: string;
  /** `CustomerIO.initialize` calls in the app's JavaScript, TypeScript or Dart. */
  initSites: WrapperInitSite[];
  /** How many files the search read, for the evidence. */
  searchedFiles: number;
}

/**
 * The Customer.io package behind a wrapper app, or nothing for a native one.
 *
 * A wrapper app gets the native SDK through that package: its Gradle files and manifest are
 * merged into the app's, and the app calls `CustomerIO.initialize` from JavaScript or Dart.
 * Reading only the native project reports a working app as having no SDK at all.
 */
export async function loadWrapper(
  nativePath: string
): Promise<WrapperSdk | undefined> {
  const found = await wrapperRoot(nativePath);
  if (!found) return undefined;
  const { framework, root } = found;
  const name = WRAPPER_PACKAGES[framework];

  const declared =
    framework === 'flutter'
      ? new RegExp(`^\\s+${name}\\s*:`, 'm').test(
          await fs
            .readFile(path.join(root, 'pubspec.yaml'), 'utf8')
            .catch(() => '')
        )
      : Boolean(
          (await readPackageJson(path.join(root, 'package.json')))?.has(name)
        );
  const installed =
    framework === 'flutter'
      ? await installedDartPackage(root, name)
      : await installedNodePackage(root, name);
  const search = await searchInitSites(root, framework);

  return {
    framework,
    name,
    root,
    declared,
    directory: installed?.directory,
    version: installed?.version,
    initSites: search.sites,
    searchedFiles: search.files,
  };
}

/** The framework, and the folder its own manifest sits in. */
async function wrapperRoot(
  nativePath: string
): Promise<
  { framework: Exclude<Framework, 'native'>; root: string } | undefined
> {
  let dir = path.extname(nativePath) ? path.dirname(nativePath) : nativePath;
  for (let level = 0; level < 3; level++) {
    if (await exists(path.join(dir, 'pubspec.yaml'))) {
      return { framework: 'flutter', root: dir };
    }
    const manifest = await readPackageJson(path.join(dir, 'package.json'));
    if (manifest?.has('expo')) return { framework: 'expo', root: dir };
    if (manifest?.has('react-native')) {
      return { framework: 'react-native', root: dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Node resolves a package by walking up, and a monorepo hoists it to a parent. */
async function installedNodePackage(
  root: string,
  name: string
): Promise<{ directory: string; version?: string } | undefined> {
  let dir = root;
  for (let level = 0; level < 4; level++) {
    const directory = path.join(dir, 'node_modules', name);
    const text = await fs
      .readFile(path.join(directory, 'package.json'), 'utf8')
      .catch(() => undefined);
    if (text !== undefined) {
      try {
        return { directory, version: JSON.parse(text).version };
      } catch {
        return { directory };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** `flutter pub get` writes where each package lives to `.dart_tool/package_config.json`. */
async function installedDartPackage(
  root: string,
  name: string
): Promise<{ directory: string; version?: string } | undefined> {
  const configPath = path.join(root, '.dart_tool', 'package_config.json');
  const text = await fs.readFile(configPath, 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  let rootUri: string | undefined;
  try {
    const parsed = JSON.parse(text) as {
      packages?: { name?: string; rootUri?: string }[];
    };
    rootUri = parsed.packages?.find((entry) => entry.name === name)?.rootUri;
  } catch {
    return undefined;
  }
  if (!rootUri) return undefined;
  // Relative URIs are relative to the config file's own folder.
  const directory = rootUri.startsWith('file://')
    ? decodeURIComponent(new URL(rootUri).pathname)
    : path.resolve(path.dirname(configPath), rootUri);
  const pubspec = await fs
    .readFile(path.join(directory, 'pubspec.yaml'), 'utf8')
    .catch(() => '');
  return {
    directory,
    version: pubspec.match(/^version:\s*([^\s#]+)/m)?.[1],
  };
}

const INIT_CALL = /\bCustomerIO\.initialize\s*\(/g;

/** Folders that hold no app code, or another platform's. */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'android',
  'ios',
  'build',
  'dist',
  'Pods',
]);

/**
 * `CustomerIO.initialize` in the app's own code: JavaScript and TypeScript for React Native
 * and Expo, Dart under `lib/` for Flutter. The call only has to exist. A wrapper's native
 * SDK handles a push before any JavaScript or Dart runs, so where the call sits does not
 * decide whether a push is received.
 */
async function searchInitSites(
  root: string,
  framework: Exclude<Framework, 'native'>
): Promise<{ sites: WrapperInitSite[]; files: number }> {
  const extensions =
    framework === 'flutter' ? /\.dart$/ : /\.(?:js|jsx|ts|tsx)$/;
  const start = framework === 'flutter' ? path.join(root, 'lib') : root;
  const sites: WrapperInitSite[] = [];
  let files = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) return;
    const entries = await fs
      .readdir(dir, { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!extensions.test(entry.name)) continue;
      files += 1;
      const text = await fs.readFile(full, 'utf8').catch(() => '');
      for (const match of text.matchAll(INIT_CALL)) {
        sites.push({
          file: path.relative(root, full),
          line: text.slice(0, match.index ?? 0).split('\n').length,
        });
      }
    }
  };
  await walk(start, 0);
  return { sites, files };
}

async function exists(file: string): Promise<boolean> {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false);
}

/** The package names a package.json depends on, or nothing when there is none to read. */
async function readPackageJson(file: string): Promise<Set<string> | undefined> {
  const text = await fs.readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const names = new Set<string>();
    for (const field of ['dependencies', 'devDependencies']) {
      const deps = parsed[field];
      if (deps && typeof deps === 'object') {
        Object.keys(deps).forEach((name) => names.add(name));
      }
    }
    return names;
  } catch {
    return undefined;
  }
}
