import {
  DeviceSdkState,
  Freshness,
  Target,
  describeTarget,
  installedEntitlements,
  listTargets,
  locateApp,
  readSdkState,
  selectTarget,
  tokenFreshness,
} from '../ios/device';
import { fail, pass, skipped, warn } from '../ladder';
import { Check, Rung } from '../types';

export interface DeviceFacts {
  target?: Target;
  usable: Target[];
  ambiguous: Target[];
  selector?: string;
  installed: boolean;
  appPath?: string;
  preferences?: string;
  containerError?: string;
  sdk?: DeviceSdkState;
  /** Entitlements of the build actually installed; absent when they cannot be read. */
  entitlements?: Record<string, string>;
  freshness?: Freshness;
  cleanup?: () => Promise<void>;
}

/**
 * Everything the device itself knows, read in one pass: whether the app is there, the token
 * the SDK is holding, who it thinks the user is, and the siteId it was handed — which is
 * also the only thing that ties this build to a workspace, so rung 2 depends on it.
 */
export async function gatherDevice(options: {
  bundleId?: string;
  selector?: string;
}): Promise<DeviceFacts> {
  const targets = await listTargets();
  const { target, usable, ambiguous } = selectTarget(targets, options.selector);

  const facts: DeviceFacts = {
    target,
    usable,
    ambiguous,
    selector: options.selector,
    installed: false,
  };
  if (!target || !options.bundleId) return facts;

  const located = await locateApp(target, options.bundleId);
  facts.installed = located.installed;
  facts.appPath = located.appPath;
  facts.preferences = located.preferences;
  facts.containerError = located.error;
  facts.cleanup = located.cleanup;

  if (located.appPath) {
    facts.entitlements = await installedEntitlements(located.appPath);
  }
  if (located.preferences) {
    facts.sdk = await readSdkState(located.preferences, options.bundleId);
    facts.freshness = await tokenFreshness(
      located.appPath,
      located.preferences,
      options.bundleId
    );
  }
  return facts;
}

export function deviceReady(facts: DeviceFacts, bundleId?: string): Rung {
  const rung: Rung = { id: 'device_ready', title: 'Device ready', checks: [] };

  if (!facts.target) {
    // A named target that is not there is a failure; nothing named and nothing available is
    // a skip, because the developer never claimed to have one.
    if (facts.selector) {
      rung.checks.push(
        fail(
          'target_available',
          'Simulator or device is usable',
          'device.not_available',
          [
            `--target ${facts.selector} matched nothing usable`,
            ...facts.usable.map((t) => `available: ${describeTarget(t)}`),
          ]
        )
      );
      return rung;
    }
    rung.skipped =
      facts.usable.length > 1
        ? `several targets are usable; pass --target to choose one (${facts.usable
            .map((t) => t.name)
            .join(', ')})`
        : 'no booted simulator and no connected device';
    return rung;
  }

  rung.checks.push(
    pass('target_available', `Target: ${describeTarget(facts.target)}`, [
      facts.target.udid,
    ])
  );

  if (!bundleId) {
    rung.skipped = 'the app bundle id could not be resolved from the project';
    return rung;
  }

  if (!facts.installed) {
    rung.checks.push(
      fail(
        'app_installed',
        `App is installed: ${bundleId}`,
        'device.app_not_installed',
        facts.containerError ? [facts.containerError] : []
      )
    );
    return rung;
  }
  rung.checks.push(pass('app_installed', `App is installed: ${bundleId}`));

  if (!facts.preferences) {
    rung.checks.push(
      warn(
        'container_readable',
        "App's data container is readable",
        'device.container_unreadable',
        facts.containerError ? [facts.containerError] : []
      )
    );
    return rung;
  }

  const capable = installedBuildCheck(facts);
  if (capable) rung.checks.push(capable);
  // A build that cannot register explains a dead token, so there is nothing to learn from
  // reading one.
  if (capable?.verdict === 'fail') return rung;

  rung.checks.push(tokenCheck(facts));
  const fresh = freshnessCheck(facts);
  if (fresh) rung.checks.push(fresh);
  rung.checks.push(identityCheck(facts));
  return rung;
}

function installedBuildCheck(facts: DeviceFacts): Check | undefined {
  // Only a simulator's bundle is readable from here. A phone's entitlements live in its
  // signature, inside a bundle this tool never has a copy of.
  if (!facts.appPath) return undefined;

  if (!facts.entitlements) {
    return skipped(
      'installed_build_push_capable',
      'Installed build can register for push',
      'the installed binary carries no entitlements section to read'
    );
  }

  const environment = facts.entitlements['aps-environment'];
  return environment
    ? pass(
        'installed_build_push_capable',
        'Installed build can register for push',
        [`aps-environment: ${environment}`]
      )
    : fail(
        'installed_build_push_capable',
        'Installed build can register for push',
        'device.installed_build_cannot_register',
        ['the installed binary declares no aps-environment']
      );
}

function freshnessCheck(facts: DeviceFacts): Check | undefined {
  const freshness = facts.freshness;
  if (!freshness?.tokenPredatesInstall) return undefined;
  return warn(
    'token_freshness',
    'Stored token belongs to the installed build',
    'device.token_predates_install',
    [
      `build installed ${freshness.installedAt?.toISOString()}`,
      `token stored ${freshness.storeWrittenAt?.toISOString()}`,
    ]
  );
}

function tokenCheck(facts: DeviceFacts) {
  const token = facts.sdk?.pushDeviceToken;
  if (!token) {
    return fail(
      'token_registered',
      'SDK holds a push token',
      'device.token_unregistered',
      [
        `no pushDeviceToken in ${
          facts.sdk?.sources.join(', ') || 'the SDK store'
        }`,
      ]
    );
  }
  // Only the shape is printed. The token is the address of someone's phone.
  return pass('token_registered', 'SDK holds a push token', [
    `${token.slice(0, 12)}… (${token.length} chars)`,
    ...(facts.sdk?.sources ?? []),
  ]);
}

function identityCheck(facts: DeviceFacts) {
  const userId = facts.sdk?.userId;
  const anonymousId = facts.sdk?.anonymousId;

  if (userId) {
    return pass('identity_read', `Identified as ${userId}`, [
      facts.sdk?.siteId
        ? `siteId ${facts.sdk.siteId}`
        : 'no siteId in settings',
    ]);
  }
  return warn(
    'identity_read',
    'SDK has an identified profile',
    'device.identity_anonymous',
    [
      anonymousId
        ? `anonymous id only: ${anonymousId}`
        : 'no identity recorded at all',
    ]
  );
}
