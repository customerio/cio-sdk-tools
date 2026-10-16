import { promises as fs } from 'fs';
import * as path from 'path';
import { fail, pass, skipped, warn } from '../../../core/report/ladder';
import { Check, Rung } from '../../../core/report/types';
import { RUNG_TITLES } from '../types';
import { PushProvider } from '../credentials';
import {
  Target,
  XcodeProjectModel,
  appGroups,
  appTargets,
  apsEnvironment,
  entitlementsPath,
  extensionTargets,
  isNotificationServiceExtension,
  loadProject,
  productFilename,
  absolutePath,
  urlSchemes,
} from '../../../platform/ios/xcode';
import {
  SourceSignals,
  SwiftFile,
  analyzeSources,
  forwardsToSdk,
  readSwiftSources,
} from '../../../platform/ios/source';

export interface WiringInput {
  /** Path to the `.xcodeproj`. */
  projectPath: string;
  /** Where sources are scanned from — the iOS project directory. */
  scanRoot: string;
  configuration?: string;
  /** Needed only when the project builds more than one app. */
  appTargetName?: string;
  /**
   * An already-parsed project. The selection phase has to read the project to offer its
   * app targets, and one `xcodebuild -showBuildSettings` costs 16s — paying it twice for
   * the same answer was not acceptable.
   */
  model?: XcodeProjectModel;
}

export interface WiringResult {
  rung: Rung;
  model: XcodeProjectModel;
  app?: Target;
  nse?: Target;
  signals: SourceSignals;
  /**
   * Which push transport this app was built for, read from the SDK product it links rather
   * than assumed. An iOS app can ship push over Firebase — `MessagingPushFCM` — and then
   * the workspace needs an FCM credential, so assuming APNs convicted a correctly wired
   * app with `workspace.apns_credential_missing`.
   */
  provider: PushProvider;
  /** Carried forward: rung 2 compares it against the workspace credential. */
  apsEnvironment?: string;
  bundleId?: string;
  /** Process names the runtime log can be filtered to. */
  processNames?: string[];
  /** The extension's process: a line from it is the OS's word that the extension ran. */
  extensionName?: string;
  /** The URL schemes the app declares, lowercased. */
  urlSchemes?: string[];
}

/**
 * Rung 1 answers a single question: could this project ever report a push?
 *
 * Everything here is read off disk, so it runs in under a second and needs no device, no
 * workspace and no network. It is also the only rung that can explain a later silence — a
 * missing extension makes "no delivered metric" a certainty rather than a mystery.
 */
/**
 * The transport this app links, not the one we hope it links.
 *
 * `MessagingPushFCM` and `MessagingPushAPN` are mutually exclusive products; an app that
 * links neither still reports APNs, because that is the default an iOS integration is
 * assumed to be and rung 1 already fails it for having no push module at all.
 */
export function providerFrom(sdkImports: string[]): PushProvider {
  const fcm = sdkImports.some((name) => /MessagingPushFCM$/.test(name));
  const apns = sdkImports.some((name) => /MessagingPushAPN$/.test(name));
  return fcm && !apns ? 'fcm' : 'apns';
}

export async function projectWiring(input: WiringInput): Promise<WiringResult> {
  const configuration = input.configuration ?? 'Debug';
  const model =
    input.model ?? (await loadProject(input.projectPath, configuration));
  const rung: Rung = {
    id: 'project_wiring',
    title: RUNG_TITLES.project_wiring,
    checks: [],
  };

  const sources = await readSwiftSources(input.scanRoot);
  const signals = analyzeSources(sources);

  const apps = appTargets(model);
  const app = pickAppTarget(apps, input.appTargetName);
  if (!app) {
    if (apps.length === 0 && model.format === 'json') {
      // The JSON format is new enough that "no targets" here usually means the toolchain
      // could not read the project, not that the project has none.
      rung.skipped =
        `${path.basename(
          model.projectPath
        )} uses the JSON .xcproj format and xcodebuild ` +
        'returned no targets for it — Xcode 27.2 or later is needed to read one';
      return {
        rung,
        model,
        signals,
        provider: providerFrom(signals.sdkImports),
      };
    }
    rung.skipped =
      apps.length === 0
        ? `no application target in ${path.basename(model.projectPath)}`
        : `${apps.length} application targets (${apps
            .map((t) => t.name)
            .join(', ')}); pass --ios-target to choose one`;
    return { rung, model, signals, provider: providerFrom(signals.sdkImports) };
  }

  rung.checks.push(
    pass('app_target', `App target: ${app.name}`, [
      app.settings.PRODUCT_BUNDLE_IDENTIFIER
        ? `bundle id ${app.settings.PRODUCT_BUNDLE_IDENTIFIER}`
        : 'bundle id could not be resolved',
      model.resolvedByXcodebuild
        ? 'build settings resolved with xcodebuild'
        : 'build settings read from project.pbxproj',
    ])
  );

  if (model.format === 'json') {
    rung.checks.push(
      warn(
        'project_format',
        'Project graph is readable',
        'wiring.project_format_json',
        [`${path.basename(model.projectPath)} carries a JSON .xcproj`]
      )
    );
  }

  rung.checks.push(await sdkPresenceCheck(input.scanRoot, signals));
  rung.checks.push(...initializationChecks(signals));

  const push = await pushCapabilityChecks(model, app);
  rung.checks.push(...push.checks);

  const { checks: nseChecks, nse } = await nseChecksFor(model, app);
  rung.checks.push(...nseChecks);

  if (nse) {
    const nseSources = await nseSourcesFor(model, nse, sources);
    rung.checks.push(forwardingCheck(nseSources));
    rung.checks.push(await appGroupCheck(model, app, nse, nseSources));
  } else {
    rung.checks.push(
      skipped(
        'nse_forwards_to_sdk',
        'Extension forwards the request to the SDK',
        'no extension to inspect'
      )
    );
    rung.checks.push(
      skipped(
        'app_group_agreement',
        'App Group agrees across app, extension and code',
        'no extension to inspect'
      )
    );
  }

  rung.summary = `${
    providerFrom(signals.sdkImports) === 'fcm' ? 'FCM' : 'APNs'
  } · ${nse ? `extension ${nse.name}` : 'no extension'}`;
  return {
    rung,
    model,
    app,
    nse,
    signals,
    provider: providerFrom(signals.sdkImports),
    apsEnvironment: push.apsEnvironment,
    bundleId: app.settings.PRODUCT_BUNDLE_IDENTIFIER,
    processNames: [app, nse]
      .filter((target): target is Target => Boolean(target))
      .map((target) => target.settings.PRODUCT_NAME || target.name),
    extensionName: nse ? nse.settings.PRODUCT_NAME || nse.name : undefined,
    urlSchemes: await urlSchemes(model.projectPath, app),
  };
}

function pickAppTarget(apps: Target[], name?: string): Target | undefined {
  if (name) return apps.find((t) => t.name === name);
  if (apps.length === 1) return apps[0];
  return undefined;
}

/**
 * Worth asking before anything else: without the SDK every later finding is a consequence
 * rather than a cause, and "no App Group in code" reads as a misconfiguration when the
 * truth is that the SDK was never added.
 */
async function sdkPresenceCheck(
  scanRoot: string,
  signals: SourceSignals
): Promise<Check> {
  if (signals.sdkImports.length > 0) {
    return pass('sdk_present', 'Customer.io SDK is imported by the sources', [
      signals.sdkImports.sort().join(', '),
    ]);
  }

  // A local package reference leaves no trace in Package.resolved and, as the SDK's own
  // sample app shows, no matching string in project.pbxproj either — so the manifests are
  // the fallback, not the primary evidence.
  for (const manifest of ['Package.resolved', 'Podfile.lock']) {
    const text = await fs
      .readFile(path.join(scanRoot, manifest), 'utf8')
      .catch(() => undefined);
    if (text && /customerio-ios|CustomerIO/i.test(text)) {
      return pass('sdk_present', `Customer.io SDK declared in ${manifest}`);
    }
  }

  return fail(
    'sdk_present',
    'Customer.io SDK is a dependency of this project',
    'wiring.sdk_absent',
    [
      `no Cio*/CustomerIO import in ${signals.files} source files under ${scanRoot}`,
    ]
  );
}

function initializationChecks(signals: SourceSignals): Check[] {
  if (signals.initSites.length === 0) {
    return [
      fail(
        'init_present',
        'CustomerIO.initialize is called',
        'wiring.init_absent',
        [`searched ${signals.files} source files`]
      ),
    ];
  }

  const evidence = signals.initSites.map(
    (site) =>
      `${site.file}:${site.line} in ${site.scope} (runs at launch: ${site.runsAtLaunch})`
  );

  if (signals.initSites.some((site) => site.runsAtLaunch === false)) {
    return [
      fail(
        'init_at_launch',
        'CustomerIO.initialize runs at launch',
        'wiring.init_not_at_launch',
        evidence
      ),
    ];
  }
  if (signals.initSites.some((site) => site.runsAtLaunch === true)) {
    return [
      pass('init_at_launch', 'CustomerIO.initialize runs at launch', evidence),
    ];
  }
  return [
    warn(
      'init_at_launch',
      'CustomerIO.initialize runs at launch',
      'wiring.init_launch_unproven',
      evidence
    ),
  ];
}

async function pushCapabilityChecks(
  model: XcodeProjectModel,
  app: Target
): Promise<{ checks: Check[]; apsEnvironment?: string }> {
  const entitlements = entitlementsPath(model.projectPath, app);
  if (!entitlements) {
    return {
      checks: [
        fail(
          'push_capability',
          'App declares the push notification capability',
          'wiring.entitlements_missing',
          [`no CODE_SIGN_ENTITLEMENTS for target ${app.name}`],
          `no CODE_SIGN_ENTITLEMENTS for target ${app.name}`
        ),
      ],
    };
  }

  const environment = await apsEnvironment(model.projectPath, app);
  const readable = path.relative(path.dirname(model.projectPath), entitlements);
  if (!environment) {
    return {
      checks: [
        fail(
          'push_capability',
          'App declares the push notification capability',
          'wiring.push_capability_missing',
          [`no aps-environment in ${readable}`],
          `no aps-environment in ${readable}`
        ),
      ],
    };
  }

  // The value matters later: a sandbox build against a production credential is a whole
  // class of "sent fine, never arrived", and rung 2 compares the two.
  return {
    apsEnvironment: environment,
    checks: [
      pass('push_capability', 'App declares the push notification capability', [
        `aps-environment: ${environment}`,
        readable,
      ]),
    ],
  };
}

async function nseChecksFor(
  model: XcodeProjectModel,
  app: Target
): Promise<{ checks: Check[]; nse?: Target }> {
  const extensions = extensionTargets(model);
  const serviceExtensions: Target[] = [];
  for (const target of extensions) {
    if (await isNotificationServiceExtension(model.projectPath, target)) {
      serviceExtensions.push(target);
    }
  }

  if (serviceExtensions.length === 0) {
    return {
      checks: [
        fail(
          'nse_present',
          'Notification Service Extension exists',
          'wiring.nse_missing',
          [
            extensions.length > 0
              ? `app extensions found, none of them a service extension: ${extensions
                  .map((t) => t.name)
                  .join(', ')}`
              : 'no app extension targets in the project',
          ]
        ),
      ],
    };
  }

  if (model.format === 'json') {
    // Build phases are the one thing `xcodebuild -showBuildSettings` will not tell us, so
    // embedding is simply unknown here. Reporting "not embedded" would be an invention.
    const nse = serviceExtensions[0];
    return {
      nse,
      checks: [
        pass('nse_present', `Notification Service Extension: ${nse.name}`),
        skipped(
          'nse_embedded',
          'App embeds the extension',
          'the JSON project format exposes no build phases to read'
        ),
      ],
    };
  }

  const embedded = serviceExtensions.filter((target) =>
    app.embeds.includes(productFilename(target))
  );

  if (embedded.length > 1) {
    return {
      checks: [
        fail(
          'nse_present',
          'Exactly one Notification Service Extension is embedded',
          'wiring.nse_multiple',
          embedded.map((t) => `${t.name} (${productFilename(t)})`),
          `embedded: ${embedded.map((t) => t.name).join(', ')}`
        ),
      ],
    };
  }

  if (embedded.length === 0) {
    const nse = serviceExtensions[0];
    return {
      nse,
      checks: [
        pass('nse_present', `Notification Service Extension: ${nse.name}`),
        fail(
          'nse_embedded',
          'App embeds the extension',
          'wiring.nse_not_embedded',
          [
            `${app.name} embeds: ${app.embeds.join(', ') || 'nothing'}`,
            `expected ${productFilename(nse)}`,
            app.dependencies.includes(nse.name)
              ? `${nse.name} is a target dependency but is not copied into PlugIns`
              : `${nse.name} is not even a target dependency of ${app.name}`,
          ]
        ),
      ],
    };
  }

  const nse = embedded[0];
  return {
    nse,
    checks: [
      pass('nse_present', `Notification Service Extension: ${nse.name}`, [
        nse.settings.PRODUCT_BUNDLE_IDENTIFIER
          ? `bundle id ${nse.settings.PRODUCT_BUNDLE_IDENTIFIER}`
          : 'bundle id could not be resolved',
      ]),
      pass('nse_embedded', 'App embeds the extension', [
        `${app.name} → ${productFilename(nse)}`,
      ]),
    ],
  };
}

/**
 * The extension's own sources, so an app-side `didReceive` cannot stand in for one the
 * extension never makes. Its directory is inferred from the Info.plist location, which is
 * where Xcode and every template put it.
 */
async function nseSourcesFor(
  model: XcodeProjectModel,
  nse: Target,
  allSources: SwiftFile[]
): Promise<SwiftFile[]> {
  const plist = absolutePath(model.projectPath, nse.settings.INFOPLIST_FILE);
  if (!plist) return allSources;
  const directory = path.dirname(plist);
  const scoped = allSources.filter((file) =>
    file.absolutePath.startsWith(`${directory}${path.sep}`)
  );
  return scoped.length > 0 ? scoped : allSources;
}

function forwardingCheck(nseSources: SwiftFile[]): Check {
  const result = forwardsToSdk(nseSources);
  if (result.forwards) {
    return pass(
      'nse_forwards_to_sdk',
      'Extension forwards the request to the SDK',
      result.site ? [result.site] : []
    );
  }

  // A warning, not a failure: the runtime matrix proves this one for real, and halting here
  // would skip the very evidence that makes the finding undeniable.
  return warn(
    'nse_forwards_to_sdk',
    'Extension forwards the request to the SDK',
    'wiring.nse_does_not_forward',
    [
      result.declaresEntryPoint
        ? 'didReceive is overridden but never hands the request to the SDK'
        : 'no didReceive override found in the extension sources',
      ...nseSources.map((file) => `searched ${file.path}`),
    ]
  );
}

/**
 * The App Group has to appear in three places — the app entitlements, the extension
 * entitlements, and `appGroupId()` in code. Two out of three is the shape that survives a
 * code review and fails on the device.
 */
async function appGroupCheck(
  model: XcodeProjectModel,
  app: Target,
  nse: Target,
  nseSources: SwiftFile[]
): Promise<Check> {
  const inCode = analyzeSources(nseSources).appGroupIds;
  const inApp = await appGroups(model.projectPath, app);
  const inExtension = await appGroups(model.projectPath, nse);

  const evidence = [
    `code: ${inCode.join(', ') || 'none'}`,
    `app entitlements: ${inApp.join(', ') || 'none'}`,
    `extension entitlements: ${inExtension.join(', ') || 'none'}`,
  ];

  if (inCode.length === 0 && inApp.length === 0 && inExtension.length === 0) {
    return warn(
      'app_group_agreement',
      'App Group agrees across app, extension and code',
      'wiring.app_group_absent',
      evidence
    );
  }

  const declared = inCode.length > 0 ? inCode : inApp;
  const agreed = declared.filter(
    (group) => inApp.includes(group) && inExtension.includes(group)
  );

  if (agreed.length === 0) {
    return fail(
      'app_group_agreement',
      'App Group agrees across app, extension and code',
      'wiring.app_group_mismatch',
      evidence,
      evidence.join('; ')
    );
  }

  return pass(
    'app_group_agreement',
    'App Group agrees across app, extension and code',
    [agreed.join(', ')]
  );
}
