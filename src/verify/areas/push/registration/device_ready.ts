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
} from '../../../platform/ios/device';
import {
  PushServiceState,
  describePushService,
  restartSimulator,
  simulatorPushService,
} from '../../../platform/ios/push_service';
import { fail, pass, skipped, warn } from '../../../core/report/ladder';
import { SdkStateLine } from '../../../platform/sdk_events';
import { SdkVersion, versionChecked } from '../../../platform/sdk_version';
import { Check, Rung } from '../../../core/report/types';
import { RUNG_TITLES } from '../types';

export interface DeviceFacts {
  target?: Target;
  usable: Target[];
  ambiguous: Target[];
  /** Every target the selector named, running or not. */
  matched?: Target[];
  selector?: string;
  installed: boolean;
  appPath?: string;
  preferences?: string;
  containerError?: string;
  sdk?: DeviceSdkState;
  /** Entitlements of the build actually installed; absent when they cannot be read. */
  entitlements?: Record<string, string>;
  freshness?: Freshness;
  /** A simulator's connection to Apple's push servers, when its log says. */
  pushService?: PushServiceState;
  /** The native SDK's version: from the SDK's own state line, else from the project. */
  sdkVersion?: SdkVersion;
  /** What the SDK said about itself in its log, read when its stores could not answer. */
  stateLine?: SdkStateLine;
  cleanup?: () => Promise<void>;
}

/** What the person running the tool said, for what the device's stores cannot. */
export interface GivenState {
  userId?: string;
  token?: string;
}

/**
 * Everything the device itself knows, read in one pass: whether the app is there, the token
 * the SDK is holding, who it thinks the user is, and the siteId it was handed — which is
 * also the only thing that ties this build to a workspace, so rung 2 depends on it.
 */
export async function gatherDevice(options: {
  bundleId?: string;
  selector?: string;
  sdkVersion?: SdkVersion;
  given?: GivenState;
  /**
   * Opens the app and reads the SDK's `sdk.state` line from its log. Only asked when the
   * stores leave the token or the user unknown: it costs a launch.
   */
  readStateLine?: (target: Target) => Promise<SdkStateLine | undefined>;
}): Promise<DeviceFacts> {
  const targets = await listTargets();
  const { target, usable, ambiguous, matched } = selectTarget(
    targets,
    options.selector
  );

  const facts: DeviceFacts = {
    target,
    usable,
    ambiguous,
    matched,
    selector: options.selector,
    installed: false,
    sdkVersion: options.sdkVersion,
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
  if (target.kind === 'simulator') {
    facts.pushService = await simulatorPushService(target.udid);
  }
  if (located.preferences) {
    facts.sdk = await readSdkState(
      located.preferences,
      options.bundleId,
      located.sdkSupport
    );
    facts.freshness = await tokenFreshness(
      located.appPath,
      located.preferences,
      options.bundleId
    );
  }
  if (!facts.installed) return facts;

  // Only when the stores can't answer: for an SDK too old to write the line, the launch
  // finds nothing and costs a wait.
  const answered = storesAnswer(facts);
  if (
    options.readStateLine &&
    ((!answered.token && !options.given?.token) ||
      (!answered.user && !options.given?.userId))
  ) {
    facts.stateLine = await options.readStateLine(target);
    if (facts.stateLine?.version) {
      facts.sdkVersion = {
        version: facts.stateLine.version,
        source: "the SDK's state line",
      };
    }
  }
  facts.sdk = fillIn(facts.sdk, facts.stateLine, options.given);
  return facts;
}

/**
 * What the stores left unknown, filled in from what the person said, else from what the SDK
 * said in its log. Each value names where it came from in `sources`.
 */
function fillIn(
  sdk: DeviceSdkState | undefined,
  line: SdkStateLine | undefined,
  given: GivenState | undefined
): DeviceSdkState {
  const filled: DeviceSdkState = sdk ?? {
    sources: [],
    stores: { sdk: false, context: false, cdp: false },
  };
  if (given?.token) {
    filled.pushDeviceToken = given.token;
    filled.sources.push('--token');
  } else if (!filled.pushDeviceToken && line?.token) {
    filled.pushDeviceToken = line.token;
    filled.sources.push("the SDK's state line");
  }
  if (given?.userId) {
    filled.userId = given.userId;
    filled.sources.push('--user');
  } else if (!filled.userId && line?.userId) {
    filled.userId = line.userId;
    filled.sources.push("the SDK's state line");
  }
  return filled;
}

export function deviceReady(facts: DeviceFacts, bundleId?: string): Rung {
  const rung: Rung = {
    id: 'device_ready',
    title: RUNG_TITLES.device_ready,
    checks: [],
  };

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
            facts.ambiguous.length > 1
              ? `--device ${facts.selector} names ${facts.ambiguous.length} running targets; pass one's UDID`
              : `--device ${facts.selector} matched nothing usable`,
            ...(facts.matched ?? [])
              .filter((t) => !facts.ambiguous.includes(t))
              .map((t) => `named, but ${t.state}: ${t.name} (${t.udid})`),
            ...facts.usable.map((t) => `available: ${describeTarget(t)}`),
          ],
          facts.ambiguous.length > 1
            ? `--device ${facts.selector} names ${facts.ambiguous.length} running targets; pass one's UDID`
            : `--device ${facts.selector} matched nothing usable${
                facts.usable.length > 0
                  ? `; available: ${facts.usable.map((t) => t.name).join(', ')}`
                  : ''
              }`
        )
      );
      return rung;
    }
    rung.skipped =
      facts.usable.length > 1
        ? `several devices are usable; pass --device to choose one (${facts.usable
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

  // Without the container, a token the person gave still lets the run go on.
  if (!facts.preferences && !facts.sdk?.pushDeviceToken) {
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
  const service = pushServiceCheck(facts);
  if (service) rung.checks.push(service);
  rung.summary = [
    facts.target?.name,
    facts.sdk?.pushDeviceToken
      ? `token ${facts.sdk.pushDeviceToken.slice(0, 8)}…`
      : 'no token',
  ]
    .filter(Boolean)
    .join(' · ');
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

/**
 * A simulator cut off from Apple's push servers can receive nothing, whatever the app does.
 * Said here, before anything is sent, rather than after three pushes that could not arrive.
 * A warning, not a failure: the integration is not what is wrong.
 */
function pushServiceCheck(facts: DeviceFacts): Check | undefined {
  const state = facts.pushService;
  if (!state || !facts.target) return undefined;
  const label = "Simulator is connected to Apple's push servers";
  return state.connected
    ? pass('push_service_connected', label, [describePushService(state)])
    : warn(
        'push_service_connected',
        label,
        'device.apns_offline',
        [
          describePushService(state),
          `restart it: ${restartSimulator(facts.target.udid)}`,
        ],
        `restart it: ${restartSimulator(facts.target.udid)}`
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

/**
 * Whether the stores settle the token and the user: they hold them, or they prove there are
 * none. A missing value proves nothing for an SDK version whose stores this tool hasn't
 * checked, where the tool may simply be looking in the wrong place. An anonymous id read from
 * the CDP layer's store shows the store was read where its user would be.
 */
function storesAnswer(facts: DeviceFacts): { token: boolean; user: boolean } {
  const sdk = facts.sdk;
  const checked = versionChecked('ios', facts.sdkVersion?.version);
  return {
    token: Boolean(sdk?.pushDeviceToken || (sdk?.stores?.sdk && checked)),
    user: Boolean(
      sdk?.userId ||
        sdk?.anonymousId ||
        ((sdk?.stores?.context || sdk?.stores?.cdp) && checked)
    ),
  };
}

/** A value that may be there, in a place this tool does not know. */
export function unreadState(
  id: string,
  label: string,
  sdkVersion: SdkVersion | undefined,
  looked: string
): Check {
  const why = sdkVersion
    ? `${looked}, and the SDK (${sdkVersion.version}) is not a version this tool has checked where it keeps it`
    : `${looked}, and the SDK's version could not be read, so the tool cannot tell it is looking in the right place`;
  return { ...skipped(id, label, why), cause: 'device.sdk_state_unreadable' };
}

function tokenCheck(facts: DeviceFacts) {
  const token = facts.sdk?.pushDeviceToken;
  const label = 'SDK holds a push token';
  if (!token) {
    const looked = `no pushDeviceToken in ${
      facts.sdk?.stores?.sdk ? 'the SDK store' : 'any SDK store on the target'
    }`;
    if (!facts.stateLine?.noToken && !storesAnswer(facts).token) {
      return unreadState('token_registered', label, facts.sdkVersion, looked);
    }
    return fail('token_registered', label, 'device.token_unregistered', [
      facts.stateLine?.noToken ? 'the SDK says it holds no token' : looked,
    ]);
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
      ...(facts.sdk?.sources ?? []),
    ]);
  }
  if (!facts.stateLine?.anonymous && !storesAnswer(facts).user) {
    return unreadState(
      'identity_read',
      'SDK has an identified profile',
      facts.sdkVersion,
      'no identified user in any SDK store on the target'
    );
  }
  // Customer.io sends push only to identified profiles, so an anonymous device stops here:
  // there is no profile to look for, and nothing to send to.
  return fail(
    'identity_read',
    'SDK has an identified profile',
    'device.identity_anonymous',
    [
      anonymousId
        ? `anonymous id only: ${anonymousId}`
        : facts.stateLine?.anonymous
        ? 'the SDK says no user is identified'
        : 'no identity recorded at all',
    ]
  );
}
