import {
  AndroidProjectModel,
  PUSH_MODULE_NAMES,
  loadAndroidProject,
  resolveInitAtLaunch,
} from '../../../platform/android/project';
import { fail, pass, warn } from '../../../core/report/ladder';
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
    model.sdkModules.find((name) => name.includes('push')) ?? 'no push module'
  }`;
  return { rung, model, applicationId: model.applicationId };
}

function sdkCheck(model: AndroidProjectModel): Check {
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
  const found = PUSH_MODULE_NAMES.filter((name) =>
    model.sdkModules.includes(name)
  );
  return found.length > 0
    ? pass('push_module', 'Push module is a dependency', found)
    : fail(
        'push_module',
        'Push module is a dependency',
        'wiring.push_module_missing',
        [`modules found: ${model.sdkModules.join(', ') || 'none'}`],
        `Customer.io modules found: ${model.sdkModules.join(', ') || 'none'}`
      );
}

function initCheck(model: AndroidProjectModel): Check {
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
  const targetSdk = Number(
    model.gradle.match(/targetSdk(?:Version)?\s*(?:=|\s)\s*(\d+)/)?.[1] ?? '0'
  );

  if (declared) {
    return pass('post_notifications', 'POST_NOTIFICATIONS is declared', [
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
