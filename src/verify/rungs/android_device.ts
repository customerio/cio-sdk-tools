import {
  AndroidSdkState,
  AndroidTarget,
  describeAndroidTarget,
  listAndroidTargets,
  notificationPermission,
  packageInstalled,
  packageStopped,
  readAndroidSdkState,
  selectAndroidTarget,
} from '../android/device';
import { fail, pass, warn } from '../ladder';
import { Check, Rung } from '../types';

export interface AndroidDeviceFacts {
  target?: AndroidTarget;
  usable: AndroidTarget[];
  selector?: string;
  installed: boolean;
  stopped?: boolean;
  permissionGranted?: boolean;
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

  facts.installed = await packageInstalled(target.serial, options.packageName);
  if (!facts.installed) return facts;

  facts.stopped = await packageStopped(target.serial, options.packageName);
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
  const rung: Rung = { id: 'device_ready', title: 'Device ready', checks: [] };

  if (!facts.target) {
    if (facts.selector) {
      rung.checks.push(
        fail('target_available', 'Emulator is usable', 'device.not_available', [
          `--target ${facts.selector} matched no running emulator`,
          ...facts.usable.map((t) => `available: ${describeAndroidTarget(t)}`),
        ])
      );
      return rung;
    }
    rung.skipped =
      facts.usable.length > 1
        ? `several emulators are running; pass --target to choose one (${facts.usable
            .map((t) => t.serial)
            .join(', ')})`
        : 'no running emulator (this iteration verifies Android on an emulator only)';
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

  rung.checks.push(permissionCheck(facts));
  const stopped = stoppedCheck(facts);
  if (stopped) rung.checks.push(stopped);
  rung.checks.push(tokenCheck(facts));
  rung.checks.push(identityCheck(facts));
  return rung;
}

/**
 * Grantable without a human, which iOS has no equivalent for — so an unmet permission here
 * is a fixable state rather than a dead end, and the remedy says the command.
 */
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
  return warn(
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
