import { promises as fs } from 'fs';
import * as path from 'path';
import xcode from 'xcode';
import { readPlist, run } from '../../core/exec';

export const NSE_EXTENSION_POINT = 'com.apple.usernotifications.service';
const APP_PRODUCT_TYPE = 'com.apple.product-type.application';
const EXTENSION_PRODUCT_TYPE = 'com.apple.product-type.app-extension';

/** dstSubfolderSpec 13 is Xcode's PlugIns folder — where an embedded extension lands. */
const PLUGINS_SUBFOLDER_SPEC = 13;

export interface Target {
  name: string;
  productType?: string;
  /** Resolved where resolution was needed; raw from the pbxproj otherwise. */
  settings: Record<string, string>;
  /** Extension product names this target embeds, e.g. `MyNSE.appex`. */
  embeds: string[];
  dependencies: string[];
}

export interface XcodeProjectModel {
  projectPath: string;
  projectName: string;
  configuration: string;
  targets: Target[];
  /** True when build settings came from xcodebuild rather than the pbxproj alone. */
  resolvedByXcodebuild: boolean;
  /**
   * `pbxproj` is the property-list format every tool has parsed for twenty years;
   * `json` is the `.xcproj` file Xcode 27.2 writes instead. Structure that only the raw
   * file carries — build phases, and therefore embedding — is unavailable in the second
   * case until there is a reader for it.
   */
  format: 'pbxproj' | 'json';
}

export function trimQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, '').trim();
}

export function expandBuildVariables(
  value: string,
  settings: Record<string, string>
): string {
  return value.replace(/\$[({]([A-Za-z0-9_]+)[)}]/g, (whole, name: string) => {
    const resolved = settings[name];
    return resolved !== undefined ? resolved : whole;
  });
}

export function hasUnresolvedVariable(value: string): boolean {
  return /\$[({][A-Za-z0-9_]+[)}]/.test(value);
}

/**
 * Read the project twice over, cheapest first.
 *
 * The pbxproj is parsed directly because it is instant and carries what `xcodebuild
 * -showBuildSettings` will not show at all: build phases, and therefore whether the app
 * actually embeds the extension. But its values are literal, and real projects write
 * `group.$(BUNDLE_ID_PREFIX).app` — comparing that raw reports a mismatch that isn't one.
 * So xcodebuild is asked for resolved settings only when something we care about still
 * holds a variable. That call costs ~15s, which is worth paying once and not by default.
 */
export async function loadProject(
  projectPath: string,
  configuration = 'Debug'
): Promise<XcodeProjectModel> {
  const format = await projectFormat(projectPath);
  const targets =
    format === 'pbxproj' ? readPbxproj(projectPath, configuration) : [];
  const model: XcodeProjectModel = {
    projectPath,
    projectName: path.basename(projectPath, '.xcodeproj'),
    configuration,
    targets,
    resolvedByXcodebuild: false,
    format,
  };

  // Nothing to read locally, so everything has to come from the toolchain — which parses
  // whichever format the project is in and is the only format-agnostic source available.
  if (format === 'json') {
    const resolved = await resolveWithXcodebuild(projectPath, configuration);
    if (resolved) {
      model.targets = [...resolved.entries()].map(([name, settings]) => ({
        name,
        productType: settings.PRODUCT_TYPE,
        settings,
        embeds: [],
        dependencies: [],
      }));
      model.resolvedByXcodebuild = true;
    }
    return model;
  }

  if (targets.some(needsResolution)) {
    const resolved = await resolveWithXcodebuild(projectPath, configuration);
    if (resolved) {
      for (const target of model.targets) {
        const settings = resolved.get(target.name);
        if (settings) target.settings = settings;
      }
      model.resolvedByXcodebuild = true;
    }
  }

  return model;
}

/** Only the settings this tool reads are worth a 15s round trip. */
function needsResolution(target: Target): boolean {
  const watched = [
    'PRODUCT_BUNDLE_IDENTIFIER',
    'CODE_SIGN_ENTITLEMENTS',
    'INFOPLIST_FILE',
    'PRODUCT_NAME',
  ];
  return watched.some((key) => {
    const value = target.settings[key];
    return value !== undefined && hasUnresolvedVariable(value);
  });
}

/**
 * Which configuration file this project uses.
 *
 * Xcode 27.2 writes a JSON `.xcproj` inside the bundle in place of `project.pbxproj`, and a
 * converted project has no pbxproj at all. Reading its absence as "no targets" is how a
 * perfectly good project comes back as unconfigured, so the format is established first
 * and named in the report.
 */
export async function projectFormat(
  projectPath: string
): Promise<'pbxproj' | 'json'> {
  const pbxproj = await fs.stat(path.join(projectPath, 'project.pbxproj')).then(
    () => true,
    () => false
  );
  if (pbxproj) return 'pbxproj';

  const entries = await fs.readdir(projectPath).catch(() => [] as string[]);
  return entries.some((entry) => entry.endsWith('.xcproj'))
    ? 'json'
    : 'pbxproj';
}

function readPbxproj(projectPath: string, configuration: string): Target[] {
  const project = xcode.project(path.join(projectPath, 'project.pbxproj'));
  project.parseSync();

  const objects = project.hash.project.objects;
  const nativeTargets = project.pbxNativeTargetSection();
  const configLists = objects['XCConfigurationList'] ?? {};
  const buildConfigs = objects['XCBuildConfiguration'] ?? {};
  const copyPhases = objects['PBXCopyFilesBuildPhase'] ?? {};
  const targetDependencies = objects['PBXTargetDependency'] ?? {};

  const targets: Target[] = [];

  for (const uuid of Object.keys(nativeTargets)) {
    // The `xcode` parser keeps a `<uuid>_comment` sibling for every object.
    if (uuid.endsWith('_comment')) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const target = nativeTargets[uuid] as any;
    if (!target?.name) continue;

    const name = trimQuotes(target.name);
    targets.push({
      name,
      productType: target.productType
        ? trimQuotes(target.productType)
        : undefined,
      settings: withDerivedVariables(
        name,
        settingsFor(target, configuration, configLists, buildConfigs)
      ),
      embeds: embeddedProducts(target, copyPhases),
      dependencies: dependencyNames(target, targetDependencies, nativeTargets),
    });
  }

  return targets;
}

/**
 * `$(TARGET_NAME)` is in almost every generated project and is knowable from the pbxproj
 * alone. Expanding it here is what keeps the common project off the 15-second xcodebuild
 * path, which should be reserved for variables only the build system can resolve.
 */
function withDerivedVariables(
  targetName: string,
  settings: Record<string, string>
): Record<string, string> {
  const seeded: Record<string, string> = {
    TARGET_NAME: targetName,
    ...settings,
  };
  const expanded: Record<string, string> = {};
  for (const key of Object.keys(seeded)) {
    expanded[key] = expandBuildVariables(seeded[key], seeded);
  }
  return expanded;
}

function settingsFor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  target: any,
  configuration: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configLists: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildConfigs: any
): Record<string, string> {
  const list = configLists[target.buildConfigurationList];
  if (!list?.buildConfigurations) return {};

  const wanted = list.buildConfigurations.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ref: any) => trimQuotes(ref.comment ?? '') === configuration
  );
  const chosen = wanted ?? list.buildConfigurations[0];
  const config = chosen ? buildConfigs[chosen.value] : undefined;
  const raw = config?.buildSettings ?? {};

  const settings: Record<string, string> = {};
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (typeof value === 'string') settings[key] = trimQuotes(value);
  }
  return settings;
}

/**
 * An extension reaches the device only if a copy-files phase puts it in PlugIns. Xcode
 * names that phase "Embed Foundation Extensions" today and "Embed App Extensions"
 * yesterday, and tools like Expo create it unnamed — so the subfolder spec is what is
 * actually checked, with the names kept as a fallback for hand-rolled phases.
 */
function embeddedProducts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  target: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  copyPhases: any
): string[] {
  const products: string[] = [];
  if (!Array.isArray(target.buildPhases)) return products;

  for (const ref of target.buildPhases) {
    const phase = copyPhases[ref.value];
    if (!phase) continue;
    const named = [
      'Embed Foundation Extensions',
      'Embed App Extensions',
    ].includes(trimQuotes(ref.comment ?? ''));
    if (Number(phase.dstSubfolderSpec) !== PLUGINS_SUBFOLDER_SPEC && !named) {
      continue;
    }
    for (const file of phase.files ?? []) {
      const comment = trimQuotes(file.comment ?? '');
      // Comments read `Thing.appex in Embed Foundation Extensions`.
      const product = comment.split(' in ')[0];
      if (product) products.push(product);
    }
  }
  return products;
}

function dependencyNames(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  target: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  targetDependencies: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nativeTargets: any
): string[] {
  const names: string[] = [];
  for (const ref of target.dependencies ?? []) {
    const dependency = targetDependencies[ref.value];
    if (!dependency) continue;
    const named = dependency.target
      ? nativeTargets[dependency.target]?.name
      : undefined;
    const name = named ?? dependency.name ?? ref.comment;
    if (name) names.push(trimQuotes(name));
  }
  return names;
}

async function resolveWithXcodebuild(
  projectPath: string,
  configuration: string
): Promise<Map<string, Record<string, string>> | null> {
  const { stdout, code } = await run(
    'xcodebuild',
    [
      '-showBuildSettings',
      '-alltargets',
      '-json',
      '-project',
      projectPath,
      '-configuration',
      configuration,
    ],
    240_000
  );
  if (code !== 0) return null;

  try {
    const start = stdout.indexOf('[');
    if (start < 0) return null;
    const entries = JSON.parse(stdout.slice(start)) as {
      target?: string;
      buildSettings?: Record<string, string>;
    }[];
    const byTarget = new Map<string, Record<string, string>>();
    for (const entry of entries) {
      // `-alltargets` repeats the default target; first entry wins, they agree anyway.
      if (entry.target && entry.buildSettings && !byTarget.has(entry.target)) {
        byTarget.set(entry.target, entry.buildSettings);
      }
    }
    return byTarget;
  } catch {
    return null;
  }
}

export function appTargets(model: XcodeProjectModel): Target[] {
  return model.targets.filter((t) => t.productType === APP_PRODUCT_TYPE);
}

export function extensionTargets(model: XcodeProjectModel): Target[] {
  return model.targets.filter((t) => t.productType === EXTENSION_PRODUCT_TYPE);
}

/** The product filename an embed phase would reference for a target. */
export function productFilename(target: Target): string {
  const name = target.settings.PRODUCT_NAME;
  const resolved =
    name && !hasUnresolvedVariable(name)
      ? name
      : expandBuildVariables(name ?? '$(TARGET_NAME)', {
          TARGET_NAME: target.name,
        });
  return `${resolved || target.name}.appex`;
}

export function absolutePath(
  projectPath: string,
  relative?: string
): string | undefined {
  if (!relative) return undefined;
  return path.resolve(path.dirname(projectPath), relative);
}

/**
 * A Notification Service Extension is identified by its declared extension point, not by
 * its name — a real project is free to call it anything, and the SDK's own sample apps do.
 */
export async function isNotificationServiceExtension(
  projectPath: string,
  target: Target
): Promise<boolean> {
  const plistPath = absolutePath(projectPath, target.settings.INFOPLIST_FILE);
  if (!plistPath) return false;
  const plist = await readPlist<Record<string, unknown>>(plistPath);
  const extension = plist?.['NSExtension'] as
    | Record<string, unknown>
    | undefined;
  return extension?.['NSExtensionPointIdentifier'] === NSE_EXTENSION_POINT;
}

export async function appGroups(
  projectPath: string,
  target: Target
): Promise<string[]> {
  const entitlements = absolutePath(
    projectPath,
    target.settings.CODE_SIGN_ENTITLEMENTS
  );
  if (!entitlements) return [];
  const plist = await readPlist<Record<string, unknown>>(entitlements);
  const groups = plist?.['com.apple.security.application-groups'];
  if (!Array.isArray(groups)) return [];
  return groups.map((group: string) =>
    expandBuildVariables(group, target.settings)
  );
}

export async function apsEnvironment(
  projectPath: string,
  target: Target
): Promise<string | undefined> {
  const entitlements = absolutePath(
    projectPath,
    target.settings.CODE_SIGN_ENTITLEMENTS
  );
  if (!entitlements) return undefined;
  const plist = await readPlist<Record<string, unknown>>(entitlements);
  const value = plist?.['aps-environment'];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The URL schemes the app declares (`CFBundleURLTypes`), lowercased. A link on one of them
 * that the SDK hands to iOS comes straight back to this app, so iOS opening it proves nothing
 * about where it went.
 */
export async function urlSchemes(
  projectPath: string,
  target: Target
): Promise<string[]> {
  const plistPath = absolutePath(projectPath, target.settings.INFOPLIST_FILE);
  if (!plistPath) return [];
  const plist = await readPlist<Record<string, unknown>>(plistPath);
  const types = plist?.['CFBundleURLTypes'];
  if (!Array.isArray(types)) return [];
  return types.flatMap((type: Record<string, unknown>) =>
    Array.isArray(type?.['CFBundleURLSchemes'])
      ? (type['CFBundleURLSchemes'] as unknown[])
          .filter((scheme): scheme is string => typeof scheme === 'string')
          .map((scheme) =>
            expandBuildVariables(scheme, target.settings).toLowerCase()
          )
      : []
  );
}

export function entitlementsPath(
  projectPath: string,
  target: Target
): string | undefined {
  return absolutePath(projectPath, target.settings.CODE_SIGN_ENTITLEMENTS);
}
