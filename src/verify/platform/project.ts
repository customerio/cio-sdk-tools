import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * Which platform is this?
 *
 * A wrapper project has both an `.xcodeproj` and a Gradle build, and guessing between them
 * would verify the half the developer did not mean. So both being present is a question,
 * not a coin toss.
 */
export async function detectPlatform(
  root: string,
  explicit?: string
): Promise<{ platform: 'ios' | 'android'; path: string } | { error: string }> {
  if (explicit && !['ios', 'android'].includes(explicit)) {
    return { error: `unknown platform: ${explicit}` };
  }

  const iosProject = await locateProject(root);
  const androidProject = await locateAndroidProject(root);

  if (explicit === 'ios' || (!explicit && iosProject && !androidProject)) {
    if (!iosProject)
      return { error: `No .xcodeproj found at or under ${root}` };
    if (process.platform !== 'darwin') {
      return {
        error:
          'iOS verification needs macOS: it reads the project with Xcode tooling and the device with simctl.',
      };
    }
    return { platform: 'ios', path: iosProject };
  }

  if (explicit === 'android' || (!explicit && androidProject && !iosProject)) {
    if (!androidProject) {
      return { error: `No Gradle project found at or above ${root}` };
    }
    return { platform: 'android', path: androidProject };
  }

  if (iosProject && androidProject) {
    return {
      error:
        'this path has both an Xcode project and a Gradle build; pass --platform ios or --platform android',
    };
  }
  return { error: `No Xcode or Gradle project found at or under ${root}` };
}

/** The module directory, not the Gradle root: the app module is what gets verified. */
async function locateAndroidProject(root: string): Promise<string | undefined> {
  const isModule = async (dir: string): Promise<boolean> => {
    for (const name of ['build.gradle', 'build.gradle.kts']) {
      const text = await fs
        .readFile(path.join(dir, name), 'utf8')
        .catch(() => '');
      if (/com\.android\.application/.test(text)) return true;
    }
    return false;
  };

  if (await isModule(root)) return root;

  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    const entries: string[] = await fs.readdir(dir).catch(() => []);
    for (const entry of entries) {
      if (
        entry.startsWith('.') ||
        ['node_modules', 'build', 'Pods', '.gradle'].includes(entry)
      ) {
        continue;
      }
      const full = path.join(dir, entry);
      const stat = await fs.stat(full).catch(() => undefined);
      if (!stat?.isDirectory()) continue;
      if (await isModule(full)) {
        found.push(full);
        continue;
      }
      await walk(full, depth + 1);
    }
  };
  await walk(root, 0);
  found.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
  return found[0];
}

/** Accept either a project directory or the `.xcodeproj` itself. */
async function locateProject(root: string): Promise<string | undefined> {
  if (root.endsWith('.xcodeproj')) return root;

  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        entry.startsWith('.') ||
        entry === 'node_modules' ||
        entry === 'Pods'
      ) {
        continue;
      }
      const full = path.join(dir, entry);
      if (entry.endsWith('.xcodeproj')) {
        found.push(full);
        continue;
      }
      const stat = await fs.stat(full).catch(() => undefined);
      if (stat?.isDirectory()) await walk(full, depth + 1);
    }
  };

  await walk(root, 0);
  if (found.length === 0) return undefined;
  // The shallowest project: a sample app nested under a package is the common shape.
  found.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
  return found[0];
}
