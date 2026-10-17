import {
  AndroidProjectModel,
  AndroidWrapper,
  PUSH_MODULE_NAMES,
  loadAndroidProject,
  resolveInitAtLaunch,
} from '../../../platform/android/project';
import { fail, pass, skipped, warn } from '../../../core/report/ladder';
import { Check, Rung } from '../../../core/report/types';
import { RUNG_TITLES } from '../types';

export interface AndroidWiringResult {
  rung: Rung;
  model?: AndroidProjectModel;
  applicationId?: string;
}

/**
 * Rung 1 for Android.
 *
 * The same question as on iOS — could this project ever report a push? — with different
 * furniture. There is no extension to find, and in its place sit the two things Android
 * gets wrong most often: a google-services.json that belongs to a different app, and
 * initialization that happens in an Activity a push will never start.
 */
export async function androidWiring(input: {
  projectPath: string;
  appModuleName?: string;
  /** Already parsed by the selection phase, which needed it to list the variants. */
  model?: AndroidProjectModel;
}): Promise<AndroidWiringResult> {
  const rung: Rung = {
    id: 'project_wiring',
    title: RUNG_TITLES.project_wiring,
    checks: [],
  };

  const model =
    input.model ??
    (await loadAndroidProject(input.projectPath, input.appModuleName));
  if (!model) {
    rung.skipped = `no Gradle app module found at or above ${input.projectPath}`;
    return { rung };
  }

  rung.checks.push(
    pass('app_module', `App module: ${model.appModuleName}`, [
      model.applicationId
        ? `applicationId ${model.applicationId}`
        : 'applicationId could not be resolved from the build files',
      `${model.sources.length} source files`,
    ])
  );

  rung.checks.push(sdkCheck(model));
  rung.checks.push(pushModuleCheck(model));
  rung.checks.push(initCheck(model));
  rung.checks.push(googleServicesCheck(model));
  rung.checks.push(notificationPermissionCheck(model));

  const forwarding = messagingServiceCheck(model);
  if (forwarding) rung.checks.push(forwarding);

  rung.summary = `${model.appModuleName} · ${
    shippedModules(model).find((name) => name.includes('push')) ??
    'no push module'
  }`;
  return { rung, model, applicationId: model.applicationId };
}

/** The app's own SDK modules, and those its wrapper package brings. */
function shippedModules(model: AndroidProjectModel): string[] {
  return [
    ...new Set([...model.sdkModules, ...(model.wrapper?.sdkModules ?? [])]),
  ];
}

function describeWrapper(wrapper: AndroidWrapper): string {
  return wrapper.version ? `${wrapper.name} ${wrapper.version}` : wrapper.name;
}

function sdkCheck(model: AndroidProjectModel): Check {
  const wrapper = model.wrapper;
  if (model.sdkModules.length === 0 && wrapper?.declared) {
    return pass('sdk_present', 'Customer.io SDK is a dependency', [
      wrapper.sdkModules.length > 0
        ? `through ${describeWrapper(wrapper)}: ${wrapper.sdkModules
            .sort()
            .join(', ')}`
        : `${wrapper.name} is declared`,
    ]);
  }
  return model.sdkModules.length > 0
    ? pass('sdk_present', 'Customer.io SDK is a dependency', [
        model.sdkModules.sort().join(', '),
      ])
    : fail(
        'sdk_present',
        'Customer.io SDK is a dependency',
        'wiring.sdk_absent',
        ['no io.customer.android dependency in the build files']
      );
}

function pushModuleCheck(model: AndroidProjectModel): Check {
  const modules = shippedModules(model);
  const found = PUSH_MODULE_NAMES.filter((name) => modules.includes(name));
  const wrapper = model.wrapper;
  if (found.length === 0 && wrapper?.declared && !wrapper.directory) {
    return skipped(
      'push_module',
      'Push module is a dependency',
      `${wrapper.name} is not installed, so the modules it brings could not be read`
    );
  }
  return found.length > 0
    ? pass(
        'push_module',
        'Push module is a dependency',
        found.map((name) =>
          wrapper && !model.sdkModules.includes(name)
            ? `${name}, through ${describeWrapper(wrapper)}`
            : name
        )
      )
    : fail(
        'push_module',
        'Push module is a dependency',
        'wiring.push_module_missing',
        [`modules found: ${model.sdkModules.join(', ') || 'none'}`],
        `Customer.io modules found: ${model.sdkModules.join(', ') || 'none'}`
      );
}

function initCheck(model: AndroidProjectModel): Check {
  if (model.wrapper) return wrapperInitCheck(model, model.wrapper);
  const resolution = resolveInitAtLaunch(model);
  if (resolution.verdict === true) {
    return pass(
      'init_at_launch',
      'SDK initialization runs from Application',
      resolution.evidence
    );
  }
  if (resolution.verdict === false) {
    return fail(
      'init_at_launch',
      'SDK initialization runs from Application',
      model.initSites.length === 0
        ? 'wiring.init_absent'
        : 'wiring.init_not_at_launch',
      resolution.evidence
    );
  }
  return warn(
    'init_at_launch',
    'SDK initialization runs from Application',
    'wiring.init_launch_unproven',
    resolution.evidence
  );
}

/**
 * A wrapper app calls `CustomerIO.initialize` from JavaScript or Dart, and only the call has
 * to be there. The native SDK starts with the app's process and handles a push before any of
 * that code runs, so the rule that initialization belongs in Application is not the
 * wrapper's to follow. Expo's plugin writes a native call instead, which counts the same.
 */
function wrapperInitCheck(
  model: AndroidProjectModel,
  wrapper: AndroidWrapper
): Check {
  const sites = [
    ...wrapper.initSites.map((site) => `${site.file}:${site.line}`),
    ...model.initSites.map(
      (site) => `${site.file}:${site.line} in ${site.scope}`
    ),
  ];
  const language =
    wrapper.framework === 'flutter' ? 'Dart' : 'JavaScript and TypeScript';
  return sites.length > 0
    ? pass('init_present', 'CustomerIO.initialize is called', sites)
    : fail(
        'init_present',
        'CustomerIO.initialize is called',
        'wiring.init_absent',
        [
          `searched ${wrapper.searchedFiles} ${language} files under ${wrapper.root}`,
          `and ${model.sources.length} Kotlin and Java files`,
        ]
      );
}

function googleServicesCheck(model: AndroidProjectModel): Check {
  const services = model.googleServices;
  if (!services) {
    return fail(
      'google_services',
      'google-services.json is present and matches this app',
      'wiring.google_services_missing',
      [`looked in ${model.appModuleName}`]
    );
  }

  const applicationId = model.applicationId;
  if (!applicationId) {
    return warn(
      'google_services',
      'google-services.json is present and matches this app',
      'wiring.init_launch_unproven',
      [
        'google-services.json found, but the applicationId could not be resolved to compare against',
        `packages in file: ${services.packageNames.join(', ')}`,
      ]
    );
  }

  return services.packageNames.includes(applicationId)
    ? pass(
        'google_services',
        'google-services.json is present and matches this app',
        [
          `${applicationId} is listed among ${services.packageNames.length} packages`,
        ]
      )
    : fail(
        'google_services',
        'google-services.json is present and matches this app',
        'wiring.google_services_package_mismatch',
        [
          `applicationId: ${applicationId}`,
          `packages in file: ${services.packageNames.join(', ') || 'none'}`,
        ],
        `the app is ${applicationId}; google-services.json lists ${
          services.packageNames.join(', ') || 'none'
        }`
      );
}

/**
 * POST_NOTIFICATIONS gates display, not delivery — the distinction matters, because a
 * developer who sees no notification concludes push is broken while every delivery is
 * being counted.
 */
function notificationPermissionCheck(model: AndroidProjectModel): Check {
  const declared = /POST_NOTIFICATIONS/.test(model.manifest ?? '');
  // The build merges a library's manifest into the app's, so a wrapper's declaration is the
  // app's too.
  const declaredByWrapper =
    model.wrapper && /POST_NOTIFICATIONS/.test(model.wrapper.manifest ?? '');
  const targetSdk = Number(
    model.gradle.match(/targetSdk(?:Version)?\s*(?:=|\s)\s*(\d+)/)?.[1] ?? '0'
  );

  if (declared || declaredByWrapper) {
    return pass('post_notifications', 'POST_NOTIFICATIONS is declared', [
      ...(declared || !model.wrapper
        ? []
        : [
            `by ${model.wrapper.name}'s manifest, which the build merges into the app's`,
          ]),
      targetSdk ? `targetSdk ${targetSdk}` : 'targetSdk unknown',
    ]);
  }
  if (targetSdk >= 33) {
    return fail(
      'post_notifications',
      'POST_NOTIFICATIONS is declared',
      'wiring.post_notifications_undeclared',
      [`targetSdk ${targetSdk} requires it before a notification can be shown`]
    );
  }
  return warn(
    'post_notifications',
    'POST_NOTIFICATIONS is declared',
    'wiring.post_notifications_undeclared',
    [
      targetSdk
        ? `targetSdk ${targetSdk}, so it is not required yet — it will be on the next bump`
        : 'targetSdk could not be read from the build files',
    ]
  );
}

function messagingServiceCheck(model: AndroidProjectModel): Check | undefined {
  const service = model.customMessagingService;
  if (!service) return undefined;

  if (service.forwardsToSdk === true) {
    return pass(
      'fcm_service_forwards',
      'Custom FirebaseMessagingService forwards to the SDK',
      [service.className]
    );
  }
  return warn(
    'fcm_service_forwards',
    'Custom FirebaseMessagingService forwards to the SDK',
    'wiring.fcm_service_does_not_forward',
    [
      service.className,
      service.forwardsToSdk === undefined
        ? 'no source found for the class, so the forwarding could not be read'
        : 'no call into the SDK found in the class',
    ]
  );
}
