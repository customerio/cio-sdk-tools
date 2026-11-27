import { promises as fs } from 'fs';
import * as path from 'path';

const APPLICATION_PLUGIN = 'com.android.application';

/** Gradle turns `android-application`, `android_application` and `android.application` into one accessor. */
const normalise = (name: string): string => name.replace(/[-_]/g, '.');

/**
 * Whether a module's build file applies the Android application plugin: by its id, or through
 * a version-catalog alias such as `alias(libs.plugins.android.application)`, which is what a
 * new Android Studio project writes. The id then appears only in `gradle/libs.versions.toml`,
 * so a literal search of the module's own file never finds it.
 *
 * An alias followed by `apply false` only declares the plugin for the modules below it (the
 * root build file does this), so it does not make the file an app module.
 */
export async function appliesApplicationPlugin(
  moduleDir: string,
  buildFileText: string
): Promise<boolean> {
  // A line that declares the id and ends in `apply false` only makes the plugin available to
  // the modules below (the root build file does this), as the alias form does below.
  const applied = buildFileText
    .split('\n')
    .filter(
      (line) =>
        !(line.includes(APPLICATION_PLUGIN) && /\bapply\s+false\b/.test(line))
    )
    .join('\n');
  if (applied.includes(APPLICATION_PLUGIN)) return true;

  const used = [
    ...buildFileText.matchAll(
      /alias\s*\(\s*\w+\.plugins\.([A-Za-z0-9_.]+)\s*\)(?!\s*apply\s+false)/g
    ),
  ].map((match) => normalise(match[1]));
  if (used.length === 0) return false;

  const catalog = await readCatalog(moduleDir);
  if (!catalog) return false;
  const applications = catalogApplicationPlugins(catalog);
  return used.some((name) => applications.has(name));
}

/** The catalog keys, normalised, whose plugin id is the application plugin. */
function catalogApplicationPlugins(catalog: string): Set<string> {
  const keys = new Set<string>();
  const section = /\[plugins\]([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/m.exec(catalog);
  for (const line of (section?.[1] ?? '').split('\n')) {
    const entry = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!entry) continue;
    const value = entry[2];
    const isApplication =
      new RegExp(`\\bid\\s*=\\s*["']${escape(APPLICATION_PLUGIN)}["']`).test(
        value
      ) || value.trim().startsWith(`"${APPLICATION_PLUGIN}:`);
    if (isApplication) keys.add(normalise(entry[1]));
  }
  return keys;
}

const escape = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The nearest `gradle/libs.versions.toml` at or above the module. */
async function readCatalog(moduleDir: string): Promise<string | undefined> {
  let dir = path.resolve(moduleDir);
  for (let depth = 0; depth < 6; depth += 1) {
    const text = await fs
      .readFile(path.join(dir, 'gradle', 'libs.versions.toml'), 'utf8')
      .catch(() => undefined);
    if (text !== undefined) return text;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
