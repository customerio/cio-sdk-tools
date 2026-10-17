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
  packageName?: string,
  /** The run will send pushes, opening the app before each one. */
  sending = false
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

  rung.checks.push(permissionCheck(facts, packageName));
  const stopped = stoppedCheck(facts, sending);
  if (stopped) rung.checks.push(stopped);
  if (facts.sdk?.notDebuggable) {
    // Nothing was read, so a missing token and a missing profile would both be guesses.
    rung.checks.push(
      fail(
        'sdk_state_readable',
        "SDK's stored state is readable",
        'device.build_not_debuggable',
        [facts.sdk.error ?? 'run-as refused the package']
      )
    );
    return rung;
  }
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

  // An answer from Firebase proves the route and the name both. 8.8.8.8 only tells the two
  // failures apart: an emulator under load drops a lone ping while Firebase still answers.
  if (network.dns) {
    return pass('network_reachable', 'Target can reach Firebase', [
      'fcm.googleapis.com resolves and answers',
    ]);
  }
  if (!network.ip) {
    return fail(
      'network_reachable',
      'Target can reach Firebase',
      'device.no_network',
      ['no ping response from 8.8.8.8 or fcm.googleapis.com']
    );
  }
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

function permissionCheck(
  facts: AndroidDeviceFacts,
  packageName: string
): Check {
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
        ['POST_NOTIFICATIONS: granted=false'],
        // The command for this device and app, so the fix is a paste, not a template.
        `grant it: adb${
          facts.target ? ` -s ${facts.target.serial}` : ''
        } shell pm grant ${packageName} android.permission.POST_NOTIFICATIONS`
      );
}

/**
 * The stopped state is a precondition, not a defect: a force-stopped app receives nothing
 * at all. Flagging it before any send is what keeps the matrix from reporting Android's
 * documented behaviour as a broken integration.
 */
function stoppedCheck(
  facts: AndroidDeviceFacts,
  sending: boolean
): Check | undefined {
  if (facts.stopped !== true) return undefined;
  // A new install is stopped until it is first opened; the token check says to open it.
  if (storedNothing(facts)) return undefined;
  // The run opens the app before each push, which clears the state, so it changes nothing
  // here; the flow says so at the end (see stoppedBeforeRun).
  if (sending) return undefined;
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
        storedNothing(facts)
          ? facts.stopped
            ? 'the SDK has stored nothing: the app has never been opened, and Android keeps a new install stopped until it is'
            : 'the SDK has stored nothing: it has not run in this app yet'
          : facts.sdk?.error ??
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

/** No SDK file at all: the SDK has never run in this install. */
function storedNothing(facts: AndroidDeviceFacts): boolean {
  return (
    (facts.sdk?.sources.length ?? 0) === 0 &&
    /No such file/.test(facts.sdk?.error ?? '')
  );
}

/**
 * Said at the end of a run that sent pushes to an app force-stopped beforehand: the run
 * cleared the state by opening the app, so its pushes arrived, and a person's force-stopped
 * app would still get nothing until they open it.
 */
export function stoppedBeforeRun(
  facts: AndroidDeviceFacts
): string | undefined {
  if (facts.stopped !== true || storedNothing(facts)) return undefined;
  return "the app was force-stopped before the run, and opening it for the pushes cleared that: on a person's device a force-stopped app gets no pushes until it is opened";
}
