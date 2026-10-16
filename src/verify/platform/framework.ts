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
  let dir = path.extname(nativePath) ? path.dirname(nativePath) : nativePath;
  for (let level = 0; level < 3; level++) {
    if (await exists(path.join(dir, 'pubspec.yaml'))) return 'flutter';
    const manifest = await readPackageJson(path.join(dir, 'package.json'));
    if (manifest) {
      if (manifest.has('expo')) return 'expo';
      if (manifest.has('react-native')) return 'react-native';
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'native';
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
