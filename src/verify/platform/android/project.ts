import { promises as fs } from 'fs';
import * as path from 'path';
import { WrapperSdk, loadWrapper } from '../framework';
import { SdkVersion } from '../sdk_version';

const SKIP_DIRECTORIES = new Set([
  'build',
  'node_modules',
  '.gradle',
  '.idea',
  'Pods',
]);

export interface SourceFile {
  path: string;
  absolutePath: string;
  text: string;
}

export interface InitSite {
  file: string;
  line: number;
  /** The class the call sits inside, as declared. */
  scope: string;
}

export interface AndroidProjectModel {
  projectPath: string;
  /** The module that builds the app — where the manifest and applicationId live. */
  appModulePath: string;
  appModuleName: string;
  applicationId?: string;
  applicationClass?: string;
  manifest?: string;
  manifestPath?: string;
  gradle: string;
  /** `io.customer.android` modules declared anywhere in the build files. */
  sdkModules: string[];
  googleServices?: { path: string; packageNames: string[] };
  sources: SourceFile[];
  initSites: InitSite[];
  /** A `FirebaseMessagingService` the app declares itself, if any. */
  customMessagingService?: { className: string; forwardsToSdk?: boolean };
  /** The wrapper package that brings the SDK, in a React Native, Expo or Flutter app. */
  wrapper?: AndroidWrapper;
}

/**
 * A wrapper package's own Android build. Gradle adds its dependencies to the app's, and the
 * build merges its manifest into the app's, so the app module's files alone tell half of it.
 */
export interface AndroidWrapper extends WrapperSdk {
  /** `io.customer.android` modules the package ships with the app. */
  sdkModules: string[];
  /**
   * The package's Gradle files name the SDK at all. When they don't, the package declares its
   * modules some other way (a version catalog, a nested script) that is read nowhere here, and
   * an empty `sdkModules` says nothing about what it ships.
   */
  sdkModulesRead: boolean;
  /** The native SDK version the package builds against, unless the app overrides it. */
  nativeVersion?: string;
  manifest?: string;
}

export async function loadAndroidProject(
  root: string,
  appModuleName?: string
): Promise<AndroidProjectModel | undefined> {
  const projectPath = await findGradleRoot(root);
  if (!projectPath) return undefined;

  // The path handed in is usually the module itself — a sample app inside a bigger build
  // is the normal shape here, and searching the whole root would pick a sibling instead.
  const here = (await isAppModule(root)) ? root : undefined;
  const modules = here ? [here] : await findAppModules(projectPath);
  const chosen = appModuleName
    ? modules.find((module) => path.basename(module) === appModuleName)
    : modules.length === 1
    ? modules[0]
    : modules.find((module) => path.basename(module) === 'app') ?? modules[0];
  if (!chosen) return undefined;

  const gradle = await readGradleFiles(projectPath, chosen);
  const manifestPath = path.join(chosen, 'src', 'main', 'AndroidManifest.xml');
  const manifest = await fs
    .readFile(manifestPath, 'utf8')
    .catch(() => undefined);
  const sources = await readSources(chosen);

  const model: AndroidProjectModel = {
    projectPath,
    appModulePath: chosen,
    appModuleName: path.basename(chosen),
    applicationId: applicationIdFrom(gradle),
    applicationClass: applicationClassFrom(manifest),
    manifest,
    manifestPath: manifest ? manifestPath : undefined,
    gradle,
    sdkModules: sdkModulesFrom(gradle),
    googleServices: await readGoogleServices(chosen),
    sources,
    initSites: initSitesFrom(sources),
    wrapper: await loadAndroidWrapper(chosen),
  };

  model.customMessagingService = messagingServiceFrom(model);
  return model;
}

async function loadAndroidWrapper(
  appModulePath: string
): Promise<AndroidWrapper | undefined> {
  const wrapper = await loadWrapper(appModulePath);
  if (!wrapper) return undefined;
  if (!wrapper.directory) {
    return { ...wrapper, sdkModules: [], sdkModulesRead: false };
  }

  const androidDirectory = path.join(wrapper.directory, 'android');
  const entries = await fs.readdir(androidDirectory).catch(() => []);
  const gradle = (
    await Promise.all(
      entries
        .filter((entry) => /\.(?:gradle(?:\.kts)?|properties)$/.test(entry))
        .map((entry) =>
          fs
            .readFile(path.join(androidDirectory, entry), 'utf8')
            .catch(() => '')
        )
    )
  ).join('\n');
  return {
    ...wrapper,
    sdkModules: sdkModulesFrom(gradle),
    sdkModulesRead: /io\.customer\.android:/.test(gradle),
    nativeVersion: wrapperNativeVersion(gradle),
    manifest: await fs
      .readFile(
        path.join(androidDirectory, 'src', 'main', 'AndroidManifest.xml'),
        'utf8'
      )
      .catch(() => undefined),
  };
}

async function isAppModule(dir: string): Promise<boolean> {
  for (const name of ['build.gradle', 'build.gradle.kts']) {
    const text = await fs
      .readFile(path.join(dir, name), 'utf8')
      .catch(() => '');
    if (/com\.android\.application/.test(text)) return true;
  }
  return false;
}

/**
 * Gradle's root is the directory holding `settings.gradle`, and a module lives *inside* it —
 * so the search goes up before it goes down. Only descending finds nothing at all when the
 * path handed in is the sample app of a larger build, which is the common case here.
 */
async function findGradleRoot(root: string): Promise<string | undefined> {
  let current = root;
  for (let depth = 0; depth < 6; depth++) {
    const entries: string[] = await fs.readdir(current).catch(() => []);
    if (
      entries.includes('settings.gradle') ||
      entries.includes('settings.gradle.kts')
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const candidates: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    const entries: string[] = await fs.readdir(dir).catch(() => []);
    if (
      entries.includes('settings.gradle') ||
      entries.includes('settings.gradle.kts')
    ) {
      candidates.push(dir);
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith('.') || SKIP_DIRECTORIES.has(entry)) continue;
      const full = path.join(dir, entry);
      const stat = await fs.stat(full).catch(() => undefined);
      if (stat?.isDirectory()) await walk(full, depth + 1);
    }
  };
  await walk(root, 0);
  candidates.sort(
    (a, b) => a.split(path.sep).length - b.split(path.sep).length
  );
  return candidates[0];
}

/** An app module is one whose build file applies the Android application plugin. */
async function findAppModules(projectPath: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    const entries: string[] = await fs.readdir(dir).catch(() => []);
    for (const name of ['build.gradle', 'build.gradle.kts']) {
      if (!entries.includes(name)) continue;
      const text = await fs
        .readFile(path.join(dir, name), 'utf8')
        .catch(() => '');
      if (
        /com\.android\.application|id\s*\(?\s*['"]com\.android\.application/.test(
          text
        )
      ) {
        found.push(dir);
      }
    }
    for (const entry of entries) {
      if (entry.startsWith('.') || SKIP_DIRECTORIES.has(entry)) continue;
      const full = path.join(dir, entry);
      const stat = await fs.stat(full).catch(() => undefined);
      if (stat?.isDirectory()) await walk(full, depth + 1);
    }
  };
  await walk(projectPath, 0);
  return found;
}

async function readGradleFiles(
  projectPath: string,
  appModulePath: string
): Promise<string> {
  const files = [
    path.join(projectPath, 'build.gradle'),
    path.join(projectPath, 'build.gradle.kts'),
    path.join(projectPath, 'settings.gradle'),
    path.join(projectPath, 'settings.gradle.kts'),
    path.join(projectPath, 'gradle', 'libs.versions.toml'),
    path.join(appModulePath, 'build.gradle'),
    path.join(appModulePath, 'build.gradle.kts'),
  ];
  const contents = await Promise.all(
    files.map((file) => fs.readFile(file, 'utf8').catch(() => ''))
  );
  // Sample apps and real projects both hide dependencies in shared script files, so
  // anything applied from the module is folded in as well.
  const applied = await readAppliedScripts(projectPath, appModulePath);
  return [...contents, ...applied].join('\n');
}

async function readAppliedScripts(
  projectPath: string,
  appModulePath: string
): Promise<string[]> {
  const module = await Promise.all(
    ['build.gradle', 'build.gradle.kts'].map((name) =>
      fs.readFile(path.join(appModulePath, name), 'utf8').catch(() => '')
    )
  );
  const out: string[] = [];
  for (const text of module) {
    for (const match of text.matchAll(
      /apply\s+from:?\s*\(?["']([^"']+)["']/g
    )) {
      // `apply from: "${rootDir}/samples/sample-app.gradle"` is how a sample app inherits
      // its SDK dependencies, so the usual root variables have to be substituted or the
      // dependency list comes back empty.
      const resolved = match[1]
        .replace(/\$\{?rootDir\}?/g, projectPath)
        .replace(/\$\{project\.rootDir\}/g, projectPath)
        .replace(/\$\{rootProject\.projectDir\}/g, projectPath);
      const candidate = path.resolve(appModulePath, resolved);
      const inProject = candidate.startsWith(projectPath);
      if (!inProject) continue;
      out.push(await fs.readFile(candidate, 'utf8').catch(() => ''));
    }
  }
  return out;
}

export function applicationIdFrom(gradle: string): string | undefined {
  const direct = gradle.match(
    /applicationId\s*(?:=|\s)\s*["']([A-Za-z0-9_.]+)["']/
  );
  if (direct) return direct[1];
  const namespace = gradle.match(
    /namespace\s*(?:=|\s)\s*["']([A-Za-z0-9_.]+)["']/
  );
  return namespace?.[1];
}

/**
 * The SDK's own module names, in both spellings.
 *
 * A published dependency reads `io.customer.android:messaging-push-fcm:x.y.z`; the same
 * module inside a composite build reads `project(":messagingpush")`. Matching only one of
 * them reports the SDK as absent from a project built against it, and matching any
 * `project(":…")` would report somebody's own module as the SDK.
 */
const SDK_MODULE_NAMES = new Set([
  // Not `core`: plenty of apps have a `:core` module of their own, and the SDK's composite
  // builds always include one of the others as well.
  'datapipelines',
  'messagingpush',
  'messaging-push',
  'messaging-push-fcm',
  'messaginginapp',
  'messaging-in-app',
  'messaginginapp-compose',
  'messaging-in-app-compose',
  'messaginginbox',
  'messaging-inbox',
  'location',
  'geofence',
]);

export const PUSH_MODULE_NAMES = [
  'messaging-push-fcm',
  'messaging-push',
  'messagingpush',
];

export function sdkModulesFrom(gradle: string): string[] {
  const modules = new Set<string>();
  // Compiled against, never shipped. The wrappers declare their optional modules this way,
  // with an `api` line for the same module behind a Gradle property, so a module declared
  // compileOnly anywhere is optional and is left out.
  const lines = gradle.split('\n');
  const compileOnly = (line: string) => /^\s*compileOnly\b/.test(line);
  const optional = new Set(
    lines
      .filter(compileOnly)
      .flatMap((line) =>
        [...line.matchAll(/io\.customer\.android:([a-z0-9-]+):/g)].map(
          (match) => match[1]
        )
      )
  );
  const shipped = lines.filter((line) => !compileOnly(line)).join('\n');
  // The trailing colon matters: without it the plugin id `io.customer.android.publish-root`
  // is read as a module named `publish-root`.
  for (const match of shipped.matchAll(
    /io\.customer\.android:([a-z0-9-]+):/g
  )) {
    if (!optional.has(match[1])) modules.add(match[1]);
  }
  for (const match of shipped.matchAll(
    /project\s*\(?\s*["']:([a-z0-9-]+)["']/g
  )) {
    if (SDK_MODULE_NAMES.has(match[1])) modules.add(match[1]);
  }
  return [...modules];
}

/**
 * The native Android SDK's version this app builds with: what the app's own build files pin,
 * or, under a wrapper, the version the package pins unless the app overrides it.
 */
export async function androidSdkVersion(
  model: AndroidProjectModel
): Promise<SdkVersion | undefined> {
  const properties = await fs
    .readFile(path.join(model.projectPath, 'gradle.properties'), 'utf8')
    .catch(() => '');
  const appText = `${model.gradle}\n${properties}`;
  if (model.wrapper) {
    // React Native's `cioSDKVersionAndroid` and Flutter's `cioVersion`, set by the app.
    const override = appText.match(
      /(?:cioSDKVersionAndroid|\bcioVersion)\s*[=:]\s*["']?(\d+\.\d+\.\d+)/
    )?.[1];
    if (override)
      return { version: override, source: "the app's Gradle files" };
    return model.wrapper.nativeVersion
      ? {
          version: model.wrapper.nativeVersion,
          source: `${model.wrapper.name}'s Gradle files`,
        }
      : undefined;
  }
  const version = gradleSdkVersion(appText);
  return version ? { version, source: "the app's Gradle files" } : undefined;
}

/**
 * `io.customer.android:<module>:<version>`, with the version written out, held in a variable,
 * or referenced from a version catalog.
 */
export function gradleSdkVersion(gradle: string): string | undefined {
  const coordinate = gradle.match(
    /io\.customer\.android:[a-z0-9-]+:(?:(\d+\.\d+\.\d+)|\$\{?([A-Za-z_][\w.]*)\}?)/
  );
  if (coordinate?.[1]) return coordinate[1];
  if (coordinate?.[2]) {
    const name = coordinate[2].split('.').pop() ?? '';
    const assigned = gradle.match(
      new RegExp(`\\b${name}\\s*=\\s*["'](\\d+\\.\\d+\\.\\d+)["']`)
    );
    if (assigned) return assigned[1];
  }
  // A catalog library: `{ module = "io.customer.android:…", version.ref = "cio" }`, or one
  // with the version inline.
  for (const line of gradle.split('\n')) {
    if (!/io\.customer\.android/.test(line)) continue;
    const inline = line.match(/\bversion\s*=\s*"(\d+\.\d+\.\d+)"/);
    if (inline) return inline[1];
    const ref = line.match(/version\.ref\s*=\s*"([^"]+)"/)?.[1];
    if (!ref) continue;
    const pinned = gradle.match(
      new RegExp(
        `^\\s*${ref.replace(/[.-]/g, '\\$&')}\\s*=\\s*"(\\d+\\.\\d+\\.\\d+)"`,
        'm'
      )
    );
    if (pinned) return pinned[1];
  }
  return undefined;
}

/**
 * The native version a wrapper package pins: React Native's
 * `customerio.reactnative.cioSDKVersionAndroid` property, Flutter's default `cioVersion`, or a
 * version written into the dependency itself.
 */
export function wrapperNativeVersion(gradle: string): string | undefined {
  return (
    gradle.match(/cioSDKVersionAndroid\s*=\s*(\d+\.\d+\.\d+)/)?.[1] ??
    gradle.match(/cioVersion["')\s]*\?:\s*["'](\d+\.\d+\.\d+)["']/)?.[1] ??
    gradleSdkVersion(gradle)
  );
}

export function applicationClassFrom(manifest?: string): string | undefined {
  const match = manifest?.match(/<application[^>]*android:name="([^"]+)"/);
  return match?.[1];
}

async function readGoogleServices(
  appModulePath: string
): Promise<AndroidProjectModel['googleServices']> {
  for (const candidate of [
    path.join(appModulePath, 'google-services.json'),
    path.join(appModulePath, 'src', 'main', 'google-services.json'),
  ]) {
    const text = await fs.readFile(candidate, 'utf8').catch(() => undefined);
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as {
        client?: {
          client_info?: { android_client_info?: { package_name?: string } };
        }[];
      };
      const packageNames = (parsed.client ?? [])
        .map((client) => client.client_info?.android_client_info?.package_name)
        .filter((name): name is string => Boolean(name));
      return { path: candidate, packageNames };
    } catch {
      return { path: candidate, packageNames: [] };
    }
  }
  return undefined;
}

async function readSources(appModulePath: string): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 10) return;
    const entries: string[] = await fs.readdir(dir).catch(() => []);
    for (const entry of entries) {
      if (entry.startsWith('.') || SKIP_DIRECTORIES.has(entry)) continue;
      const full = path.join(dir, entry);
      const stat = await fs.stat(full).catch(() => undefined);
      if (stat?.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!/\.(kt|java)$/.test(entry)) continue;
      const text = await fs.readFile(full, 'utf8').catch(() => '');
      out.push({
        path: path.relative(appModulePath, full),
        absolutePath: full,
        text,
      });
    }
  };
  await walk(path.join(appModulePath, 'src'), 0);
  return out;
}

const INIT_CALL =
  /\b(?:CustomerIOBuilder\s*\(|CustomerIO\.Builder\s*\(|CustomerIO\.initialize\s*\()/g;

export function initSitesFrom(sources: SourceFile[]): InitSite[] {
  const sites: InitSite[] = [];
  for (const source of sources) {
    for (const match of source.text.matchAll(INIT_CALL)) {
      const before = source.text.slice(0, match.index ?? 0);
      sites.push({
        file: source.path,
        line: before.split('\n').length,
        scope: enclosingClass(before) ?? '(unknown)',
      });
    }
  }
  return sites;
}

/** The nearest class declaration above a call, with whatever it extends. */
export function enclosingClass(textBefore: string): string | undefined {
  const declaration =
    /(?:^|\n)\s*(?:public\s+|final\s+|open\s+|abstract\s+|internal\s+)*class\s+(\w+)([^{\n]*)/g;
  let last: string | undefined;
  for (const match of textBefore.matchAll(declaration)) {
    last = `class ${match[1]}${match[2].trimEnd()}`;
  }
  return last;
}

export function extendsApplication(scope: string): boolean {
  return /:\s*(?:\w+\.)*Application\b|extends\s+(?:\w+\.)*Application\b/.test(
    scope
  );
}

/**
 * A `FirebaseMessagingService` the app declares for itself.
 *
 * The SDK ships its own and merges it in, so the common case is no declaration at all. When
 * an app does declare one, it owns every message — and unless it forwards to the SDK, every
 * delivery goes uncounted while the notification still displays. That is the Android shape
 * of the invisible failure, and the direct analogue of the iOS extension that never calls
 * `didReceive`.
 */
function messagingServiceFrom(
  model: AndroidProjectModel
): AndroidProjectModel['customMessagingService'] {
  const manifest = model.manifest;
  if (!manifest) return undefined;

  for (const match of manifest.matchAll(
    /<service[^>]*android:name="([^"]+)"[\s\S]*?<\/service>/g
  )) {
    const block = match[0];
    if (!/com\.google\.firebase\.MESSAGING_EVENT/.test(block)) continue;
    const className = match[1];
    if (/io\.customer\./.test(className)) continue;

    const simpleName = className.split('.').pop() ?? className;
    const source = model.sources.find((file) =>
      new RegExp(`class\\s+${simpleName}\\b`).test(file.text)
    );
    return {
      className,
      forwardsToSdk: source
        ? /CustomerIOFirebaseMessagingService|MessagingPushFCM|onMessageReceived\s*\([^)]*\)\s*\{[\s\S]{0,400}?(?:handleMessage|super\.onMessageReceived)/.test(
            source.text
          )
        : undefined,
    };
  }
  return undefined;
}

export type LaunchVerdict = true | false | 'unknown';

export interface LaunchResolution {
  verdict: LaunchVerdict;
  evidence: string[];
}

const ANDROID_UI_CLASS =
  /extends\s+(?:\w+\.)*(?:AppCompatActivity|Activity|Fragment)\b|:\s*(?:\w+\.)*(?:AppCompatActivity|Activity|Fragment)\b/;

/**
 * Does initialization run before a push can arrive?
 *
 * A push wakes the app *process*, not an Activity — Firebase starts the messaging service
 * and nothing else. So initialization belongs in `Application`, and an app that initializes
 * from its first Activity loses every delivery that arrives while it is closed, which is
 * most of them.
 *
 * Almost no real app calls the builder directly in `onCreate` though: it calls a helper, a
 * repository, a DI module. Judging the immediately-enclosing class alone reports the SDK's
 * own sample app as broken, so references are followed out of the Application class to a
 * bounded depth.
 */
export function resolveInitAtLaunch(
  model: AndroidProjectModel
): LaunchResolution {
  if (model.initSites.length === 0) {
    return { verdict: false, evidence: ['no CustomerIO initialization found'] };
  }

  const appClass = model.applicationClass?.split('.').pop();
  const appSource = appClass
    ? model.sources.find((file) =>
        new RegExp(`class\\s+${appClass}\\b`).test(file.text)
      )
    : undefined;

  const evidence = model.initSites.map(
    (site) => `${site.file}:${site.line} in ${site.scope}`
  );

  if (!appSource) {
    return {
      verdict: 'unknown',
      evidence: [
        ...evidence,
        appClass
          ? `no source found for the Application class ${appClass}`
          : 'the manifest names no Application class',
      ],
    };
  }

  const initFiles = new Set(model.initSites.map((site) => site.file));
  if (initFiles.has(appSource.path)) {
    return {
      verdict: true,
      evidence: [...evidence, `initialized from ${appSource.path}`],
    };
  }

  for (const file of reachableFrom(appSource, model.sources, 3)) {
    if (initFiles.has(file.path)) {
      return {
        verdict: true,
        evidence: [
          ...evidence,
          `reached from ${appSource.path} via ${file.path}`,
        ],
      };
    }
  }

  if (model.initSites.some((site) => ANDROID_UI_CLASS.test(site.scope))) {
    return {
      verdict: false,
      evidence: [
        ...evidence,
        'initialization sits in an Activity or Fragment, which a push does not start',
      ],
    };
  }

  return {
    verdict: 'unknown',
    evidence: [
      ...evidence,
      `no path found from ${appSource.path} to any initialization`,
    ],
  };
}

/** Files whose class names the starting file mentions, transitively, within `depth`. */
function reachableFrom(
  start: SourceFile,
  sources: SourceFile[],
  depth: number
): SourceFile[] {
  const byClass = new Map<string, SourceFile>();
  for (const file of sources) {
    for (const match of file.text.matchAll(/\bclass\s+(\w+)/g)) {
      if (!byClass.has(match[1])) byClass.set(match[1], file);
    }
  }

  const seen = new Set<string>([start.path]);
  let frontier = [start];
  const out: SourceFile[] = [];

  for (let level = 0; level < depth; level++) {
    const next: SourceFile[] = [];
    for (const file of frontier) {
      for (const [className, source] of byClass) {
        if (seen.has(source.path)) continue;
        if (!new RegExp(`\\b${className}\\b`).test(file.text)) continue;
        seen.add(source.path);
        out.push(source);
        next.push(source);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  return out;
}

export interface BuildVariant {
  /** The id the build actually produced, suffixes and flavour overrides included. */
  applicationId: string;
  variantName: string;
  /** When this variant was last built, so the newest is offered first. */
  builtAt?: Date;
  source: 'output-metadata' | 'build script';
}

/**
 * Which application ids can this module produce?
 *
 * Read from AGP's own output rather than the build script. `applicationIdSuffix`, flavour
 * overrides and anything computed in the DSL are invisible to a regex, and asking Gradle
 * costs a JVM start and still cannot say which variant was installed. AGP writes the
 * answer to `build/outputs/apk/<variant>/output-metadata.json` on every build, so the
 * artifact is both cheaper and more truthful than the script that produced it.
 *
 * A module that has never been built yields nothing here, which is the honest answer:
 * nothing is installed either, and the remedy is to build it.
 */
export async function buildVariants(
  moduleDirectory: string
): Promise<BuildVariant[]> {
  const roots = [path.join(moduleDirectory, 'build', 'outputs', 'apk')];
  // Flutter moves every module's build folder to the project's own `build/`, beside
  // pubspec.yaml: `android/app` builds into `build/app`.
  const flutterProject = path.dirname(path.dirname(moduleDirectory));
  if (await fileExists(path.join(flutterProject, 'pubspec.yaml'))) {
    roots.push(
      path.join(
        flutterProject,
        'build',
        path.basename(moduleDirectory),
        'outputs',
        'apk'
      )
    );
  }
  const files = (
    await Promise.all(roots.map((root) => findOutputMetadata(root, 0)))
  ).flat();
  const variants: BuildVariant[] = [];

  for (const file of files) {
    const text = await fs.readFile(file, 'utf8').catch(() => undefined);
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as {
        applicationId?: string;
        variantName?: string;
      };
      if (!parsed.applicationId) continue;
      const stat = await fs.stat(file).catch(() => undefined);
      variants.push({
        applicationId: parsed.applicationId,
        variantName: parsed.variantName ?? path.basename(path.dirname(file)),
        builtAt: stat?.mtime,
        source: 'output-metadata',
      });
    } catch {
      continue;
    }
  }

  // Newest first: the one just built is nearly always the one under test.
  variants.sort(
    (a, b) => (b.builtAt?.getTime() ?? 0) - (a.builtAt?.getTime() ?? 0)
  );
  return dedupeVariants(variants);
}

function dedupeVariants(variants: BuildVariant[]): BuildVariant[] {
  const seen = new Set<string>();
  return variants.filter((variant) => {
    const key = `${variant.applicationId}·${variant.variantName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Flavour dimensions nest, so the metadata can sit a level or two down. */
async function findOutputMetadata(
  directory: string,
  depth: number
): Promise<string[]> {
  if (depth > 2) return [];
  const entries = await fs
    .readdir(directory, { withFileTypes: true })
    .catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findOutputMetadata(full, depth + 1)));
    } else if (entry.name === 'output-metadata.json') {
      found.push(full);
    }
  }
  return found;
}

async function fileExists(file: string): Promise<boolean> {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false);
}
