import {
  AndroidSdkState,
  AndroidTarget,
  Connectivity,
  connectivity,
  describeAndroidTarget,
  listAndroidTargets,
  notificationPermission,
  packageInstalled,
  packageInstalledAt,
  packageStopped,
  readAndroidSdkState,
  selectAndroidTarget,
} from '../../../platform/android/device';
import { fail, pass, warn } from '../../../core/report/ladder';
import { Check, Rung } from '../../../core/report/types';
import { RUNG_TITLES } from '../types';

export interface AndroidDeviceFacts {
  target?: AndroidTarget;
  usable: AndroidTarget[];
  selector?: string;
  installed: boolean;
  stopped?: boolean;
  permissionGranted?: boolean;
  /** When this build went on: `lastUpdateTime` from the dump we already read. */
  installedAt?: Date;
  network?: Connectivity;
  sdk?: AndroidSdkState;
}

export async function gatherAndroidDevice(options: {
  packageName?: string;
  selector?: string;
}): Promise<AndroidDeviceFacts> {
  const targets = await listAndroidTargets();
  const { target, usable } = selectAndroidTarget(targets, options.selector);

  const facts: AndroidDeviceFacts = {
    target,
    usable,
    selector: options.selector,
    installed: false,
  };
  if (!target || !options.packageName) return facts;

  facts.network = await connectivity(target.serial);
  facts.installed = await packageInstalled(target.serial, options.packageName);
  if (!facts.installed) return facts;

  facts.stopped = await packageStopped(target.serial, options.packageName);
  facts.installedAt = await packageInstalledAt(
    target.serial,
    options.packageName
  );
  facts.permissionGranted = await notificationPermission(
    target.serial,
    options.packageName
  );
  facts.sdk = await readAndroidSdkState(target.serial, options.packageName);
  return facts;
}

export function androidDeviceReady(
  facts: AndroidDeviceFacts,
  packageName?: string
): Rung {
  const rung: Rung = {
    id: 'device_ready',
    title: RUNG_TITLES.device_ready,
    checks: [],
  };

  if (!facts.target) {
    if (facts.selector) {
      rung.checks.push(
        fail('target_available', 'Target is usable', 'device.not_available', [
          `--device ${facts.selector} matched no connected device or running emulator`,
          ...facts.usable.map((t) => `available: ${describeAndroidTarget(t)}`),
        ])
      );
      return rung;
    }
    rung.skipped =
      facts.usable.length > 1
        ? `several devices are available; pass --device to choose one (${facts.usable
            .map((t) => t.serial)
            .join(', ')})`
        : 'no connected device and no running emulator';
    return rung;
  }

  rung.checks.push(
    pass('target_available', `Target: ${describeAndroidTarget(facts.target)}`, [
      facts.target.serial,
    ])
  );

  if (!packageName) {
    rung.skipped = 'the applicationId could not be resolved from the project';
    return rung;
  }

  if (!facts.installed) {
    rung.checks.push(
      fail(
        'app_installed',
        `App is installed: ${packageName}`,
        'device.app_not_installed'
      )
    );
    return rung;
  }
  rung.checks.push(pass('app_installed', `App is installed: ${packageName}`));

  const network = networkCheck(facts);
  if (network) rung.checks.push(network);
  // Nothing downstream means anything if Firebase cannot connect.
  if (network?.verdict === 'fail') return rung;

  rung.checks.push(permissionCheck(facts));
  const stopped = stoppedCheck(facts);
  if (stopped) rung.checks.push(stopped);
  rung.checks.push(tokenCheck(facts));
  rung.checks.push(identityCheck(facts));
  rung.summary = [
    facts.target?.serial,
    facts.sdk?.deviceToken
      ? `token ${facts.sdk.deviceToken.slice(0, 8)}…`
      : 'no token',
  ]
    .filter(Boolean)
    .join(' · ');
  return rung;
}

/**
 * Grantable without a human, which iOS has no equivalent for — so an unmet permission here
 * is a fixable state rather than a dead end, and the remedy says the command.
 */
function networkCheck(facts: AndroidDeviceFacts): Check | undefined {
  const network = facts.network;
  if (!network) return undefined;

  if (!network.ip) {
    return fail(
      'network_reachable',
      'Target can reach Firebase',
      'device.no_network',
      ['no ping response from 8.8.8.8']
    );
  }
  if (!network.dns) {
    return fail(
      'network_reachable',
      'Target can reach Firebase',
      'device.dns_unresolved',
      [
        'the network route is up but fcm.googleapis.com does not resolve',
        'a target in this state answers pings and receives nothing',
      ]
    );
  }
  return pass('network_reachable', 'Target can reach Firebase', [
    'fcm.googleapis.com resolves',
  ]);
}

function permissionCheck(facts: AndroidDeviceFacts): Check {
  if (facts.permissionGranted === undefined) {
    return warn(
      'notification_permission',
      'Notification permission is granted',
      'device.notification_permission_denied',
      ['the permission state could not be read from dumpsys']
    );
  }
  return facts.permissionGranted
    ? pass('notification_permission', 'Notification permission is granted')
    : fail(
        'notification_permission',
        'Notification permission is granted',
        'device.notification_permission_denied',
        ['POST_NOTIFICATIONS: granted=false']
      );
}

/**
 * The stopped state is a precondition, not a defect: a force-stopped app receives nothing
 * at all. Flagging it before any send is what keeps the matrix from reporting Android's
 * documented behaviour as a broken integration.
 */
function stoppedCheck(facts: AndroidDeviceFacts): Check | undefined {
  if (facts.stopped !== true) return undefined;
  return warn(
    'app_not_stopped',
    'App is not in the stopped state',
    'runtime.app_force_stopped',
    ['dumpsys reports stopped=true for this package']
  );
}

function tokenCheck(facts: AndroidDeviceFacts): Check {
  const token = facts.sdk?.deviceToken;
  if (!token) {
    return fail(
      'token_registered',
      'SDK holds an FCM token',
      'device.token_unregistered',
      [
        facts.sdk?.error ??
          `no device_token in ${
            facts.sdk?.sources.join(', ') || 'the SDK store'
          }`,
      ]
    );
  }
  // Read from shared preferences on purpose: logcat truncates long lines, and a clipped
  // token comes back from a send as FCM_UNREGISTERED, which reads like a broken setup.
  return pass('token_registered', 'SDK holds an FCM token', [
    `${token.slice(0, 12)}… (${token.length} chars)`,
    ...(facts.sdk?.sources ?? []),
  ]);
}

function identityCheck(facts: AndroidDeviceFacts): Check {
  const userId = facts.sdk?.userId;
  if (userId) {
    return pass('identity_read', `Identified as ${userId}`, [
      facts.sdk?.siteId
        ? `siteId ${facts.sdk.siteId}`
        : 'no siteId in settings',
    ]);
  }
  // Customer.io sends push only to identified profiles, so an anonymous device stops here.
  return fail(
    'identity_read',
    'SDK has an identified profile',
    'device.identity_anonymous',
    [
      facts.sdk?.anonymousId
        ? `anonymous id only: ${facts.sdk.anonymousId}`
        : 'no identity recorded at all',
    ]
  );
}
