import * as path from 'path';
import { CioContext } from '../../platform/cio/cli';
import { stopwatch } from '../../core/clock';
import { PushProvider } from './credentials';
import { Reporter } from '../../core/report/render';
import { Asker } from '../../core/prompt';
import { freshness, watchFor } from '../../platform/observe';
import { deviceLogUnavailable, startCapture } from '../../platform/ios/logs';
import { simulatorPredicate } from './on_device/sdk_lines';
import {
  Target as IosTarget,
  describeTarget,
  listTargets,
  locateApp,
  readSdkState,
} from '../../platform/ios/device';
import { Selection } from './select';
import { XcodeProjectModel } from '../../platform/ios/xcode';
import { explainNotificationsOff, runDeliveredMatrix } from './on_device';
import { whyNoSend } from './on_device/send';
import { ALL_STATES, AppState } from '../../platform/app_state';
import { deviceReady, gatherDevice } from './registration/device_ready';
import {
  profileLinked,
  judgeNotificationPermission,
} from './registration/profile_linked';
import { projectWiring } from './registration/project_wiring';
import { setAppState } from '../../platform/ios/app_state';
import {
  gatherWorkspace,
  workspaceReady,
} from './registration/workspace_ready';
import { PushLadder, RUNG_TITLES } from './types';
import { VerifyPushOptions, evidenceDirectoryFor } from './options';
import { ClimbResult, skipRest, skipSending } from './climb';
import { addSent, askToSend, skipUnreadable, tapPlanFor } from './sending';
import { askerPhases } from '../../platform/observe';

/**
 * The climb itself. Each rung is adopted in the order it is reported, and the first failure
 * turns the rest into explicit skips — a later rung's answer is not merely unknown after an
 * early failure, it is meaningless.
 */
export async function climb(
  ladder: PushLadder,
  projectPath: string,
  options: VerifyPushOptions,
  reporter: Reporter,
  cio: CioContext,
  selection: Selection,
  model: XcodeProjectModel,
  asker: Asker
): Promise<ClimbResult> {
  const wiringRung = reporter.rung(RUNG_TITLES.project_wiring);
  wiringRung.phase('reading the project');
  const wiring = await projectWiring({
    projectPath,
    scanRoot: path.dirname(projectPath),
    configuration: options.configuration,
    appTargetName: selection.appTargetName,
    model,
  });
  wiringRung.done(wiring.rung);
  ladder.adopt(wiring.rung);
  if (ladder.halted) {
    skipRest(
      ladder,
      reporter,
      ['workspace_ready', 'device_ready', 'profile_linked'],
      options
    );
    return { projectName: wiring.model.projectName };
  }

  // The device is read before the workspace rung is evaluated, though it is reported after
  // it: the siteId the SDK stored on the device is the only thing tying this build to a
  // workspace, so rung 2's subject comes out of rung 3's evidence.
  // Observed mode watches the facts appear before anything reads them.
  let observed = false;
  if (options.observe && selection.targetSelector && wiring.bundleId) {
    const chosen = (await listTargets()).find(
      (candidate: IosTarget) =>
        candidate.udid === selection.targetSelector ||
        candidate.name === selection.targetSelector
    );
    if (chosen) {
      const watch = await observeIos({
        target: chosen,
        bundleId: wiring.bundleId,
        reporter,
        asker,
        evidenceDirectory: options.evidence,
        processNames: wiring.processNames,
      });
      observed = watch.observed;
    }
  }

  const deviceTimer = stopwatch();
  const deviceRung = reporter.rung(RUNG_TITLES.device_ready);
  deviceRung.phase('reading the target');
  const device = await gatherDevice({
    bundleId: wiring.bundleId,
    selector: selection.targetSelector,
  });
  const deviceMs = deviceTimer();

  try {
    const workspaceTimer = stopwatch();
    const workspaceRung = reporter.rung(RUNG_TITLES.workspace_ready);
    workspaceRung.phase('resolving the workspace');
    const workspace = await gatherWorkspace({
      cio,
      platform: 'ios',
      provider: wiring.provider,
      resolution: selection.resolution,
      sdkKey: device.sdk?.cdpApiKey,
      extensionKey: wiring.extensionKey,
    });
    const ready = workspaceReady(workspace, wiring.apsEnvironment);
    ladder.adopt(ready, workspaceTimer());
    workspaceRung.done(ready);
    if (ladder.halted) {
      skipRest(ladder, reporter, ['device_ready', 'profile_linked'], options);
      return { projectName: wiring.model.projectName };
    }

    const deviceRungResult = deviceReady(device, wiring.bundleId);
    ladder.adopt(deviceRungResult, deviceMs);
    deviceRung.done(deviceRungResult);
    if (ladder.halted) {
      skipRest(ladder, reporter, ['profile_linked'], options);
      return { projectName: wiring.model.projectName };
    }

    const profileTimer = stopwatch();
    const profileRung = reporter.rung(RUNG_TITLES.profile_linked);
    profileRung.phase('checking the profile');
    const profile = await profileLinked({
      cio,
      environmentId: workspace.resolution?.workspace?.id,
      userId: device.sdk?.userId,
      anonymousId: device.sdk?.anonymousId,
      token: device.sdk?.pushDeviceToken,
      candidates: selection.resolution.candidates,
      onSweep: (workspace) =>
        profileRung.phase(`looking in ${workspace.name ?? workspace.id}`),
      onWait: (text) => profileRung.phase(text),
      foreground: async () => {
        if (!device.target || !wiring.bundleId) return undefined;
        profileRung.phase(
          'opening the app, so what it queued in the background can go out'
        );
        const launched = await setAppState(
          device.target,
          wiring.bundleId,
          'foreground',
          wiring.processNames?.[0]
        );
        return launched.ok ? launched.how : undefined;
      },
      bundleId: wiring.bundleId,
    });
    ladder.adopt(profile, profileTimer());
    profileRung.done(profile);

    // A phone whose log cannot be read can prove nothing, so it is sent nothing, and the
    // person is not asked to agree to pushes that could never be followed.
    const unreadable =
      options.send && device.target
        ? await deviceLogUnavailable(device.target)
        : undefined;
    if (unreadable) skipUnreadable(ladder, options, unreadable);
    // Nor is a simulator cut off from Apple's push servers: whatever is sent is held by Apple,
    // and only the last push ever arrives, once the simulator reconnects.
    const offline =
      options.send && !unreadable && device.pushService?.connected === false;
    if (offline) {
      skipSending(
        ladder,
        options,
        "no push was sent: the simulator has no connection to Apple's push servers, so none could arrive — restart it and run again"
      );
    }

    const consent =
      unreadable || offline
        ? undefined
        : await askToSend(ladder, options, reporter, asker, {
            target:
              device.target &&
              `${describeTarget(device.target)} · ${device.target.udid}`,
            app: wiring.bundleId,
            workspace: workspace.resolution?.workspace,
            login: cio.profile,
            token: device.sdk?.pushDeviceToken,
            delivered: selection.states,
            retries: options.resend !== false,
          });
    if (!unreadable && !offline && consent?.granted !== false) {
      await matrix(ladder, options, reporter, asker, selection.states, {
        target: device.target,
        bundleId: wiring.bundleId,
        provider: wiring.provider,
        environmentId: workspace.resolution?.workspace?.id,
        workspaceReason: workspace.resolution?.unresolvedReason ?? cio.reason,
        token: device.sdk?.pushDeviceToken,
        sandbox: wiring.apsEnvironment !== 'production',
        processNames: wiring.processNames,
        extensionName: wiring.extensionName,
        appSchemes: wiring.urlSchemes,
      });
    }
    // Pushes that failed because notifications are off already say so; a note at Device
    // ready would say it a second time.
    if (!ladder.matrixHasCause('device.notifications_disabled')) {
      judgeNotificationPermission(
        ladder,
        ladder.matrices.find((section) => section.metric === 'delivered')
          ?.notificationAuthorization
      );
    }

    return {
      projectName: wiring.model.projectName,
      observed,
      freshnessNote: freshness({
        installedAt: device.freshness?.installedAt,
        observed,
      }).note,
      consent,
    };
  } finally {
    // Anything pulled off a physical device lives in a temp directory.
    await device.cleanup?.();
  }
}

/** Observed mode, iOS. Same shape; the probes read the simulator or device container. */
async function observeIos(input: {
  target: Parameters<typeof startCapture>[0];
  bundleId: string;
  reporter: Reporter;
  asker: Asker;
  evidenceDirectory?: string;
  processNames?: string[];
}): Promise<{ observed: boolean; evidencePath?: string; notes: string[] }> {
  const handle = input.reporter.rung('Observing');
  const capture = await startCapture(input.target, input.evidenceDirectory, {
    processes: input.processNames ?? [],
    predicate: simulatorPredicate(),
  });
  const notes: string[] = [];
  let observed = false;

  const read = async () => {
    const located = await locateApp(input.target, input.bundleId);
    if (!located.installed || !located.preferences) return undefined;
    const state = await readSdkState(located.preferences, input.bundleId);
    await located.cleanup?.();
    return state;
  };

  try {
    const installed = await watchFor(
      {
        label: 'app installed',
        instruction: `Install and launch the build on ${input.target.name}.`,
        probe: async () =>
          (await locateApp(input.target, input.bundleId)).installed
            ? true
            : undefined,
      },
      askerPhases(input, handle)
    );
    if (installed.timedOut) {
      notes.push('the app was never installed while watching');
      return { observed, evidencePath: capture.evidencePath, notes };
    }
    if (installed.at) {
      observed = true;
      notes.push('watched the app appear on the target');
    }

    const token = await watchFor(
      {
        label: 'push token',
        instruction:
          'Launch the app, and allow notifications, so the SDK registers a token.',
        probe: async () => (await read())?.pushDeviceToken,
      },
      askerPhases(input, handle)
    );
    if (token.at) {
      observed = true;
      notes.push('watched the SDK register a push token');
    } else if (token.timedOut) {
      notes.push('no push token appeared while watching');
    }

    const identity = await watchFor(
      {
        label: 'login',
        instruction: 'Log in on the device so the SDK identifies a profile.',
        probe: async () => (await read())?.userId,
      },
      askerPhases(input, handle)
    );
    if (identity.at) {
      observed = true;
      notes.push(`watched a login as ${identity.value}`);
    } else if (identity.timedOut) {
      notes.push('nobody logged in while watching');
    }
  } finally {
    await capture.stop();
    handle.done({
      id: 'device_ready',
      title: 'Observing',
      checks: [],
      skipped: notes.join('; ') || 'nothing left to watch',
    });
  }

  return { observed, evidencePath: capture.evidencePath, notes };
}

/**
 * Pushes are sent only at a level that sends them. A registration run proves the
 * integration could report a delivery and its closing line says exactly that, which is a
 * different claim from one that did.
 */
async function matrix(
  ladder: PushLadder,
  options: VerifyPushOptions,
  reporter: Reporter,
  asker: Asker,
  states: AppState[] | undefined,
  inputs: {
    target?: Parameters<typeof runDeliveredMatrix>[0]['target'];
    bundleId?: string;
    environmentId?: string;
    workspaceReason?: string;
    token?: string;
    sandbox: boolean;
    provider: PushProvider;
    processNames?: string[];
    extensionName?: string;
    appSchemes?: string[];
  }
): Promise<void> {
  // Registration sends nothing, and says so in its closing line rather than as a skipped
  // section: nothing it asked for was left unproven.
  if (!options.send) return;

  if (
    !inputs.target ||
    !inputs.bundleId ||
    !inputs.environmentId ||
    !inputs.token
  ) {
    const skipped =
      whyNoSend({
        target: inputs.target,
        app: inputs.bundleId,
        workspaceId: inputs.environmentId,
        workspaceReason: inputs.workspaceReason,
        token: inputs.token,
      }) ?? 'no push was sent';
    skipSending(ladder, options, skipped);
    return;
  }

  const plan = tapPlanFor(options, asker, states ?? ALL_STATES);
  const { delivered, opened } = await runDeliveredMatrix({
    target: inputs.target,
    bundleId: inputs.bundleId,
    environmentId: inputs.environmentId,
    token: inputs.token,
    sandbox: inputs.sandbox,
    provider: inputs.provider,
    processNames: inputs.processNames,
    extensionName: inputs.extensionName,
    appSchemes: inputs.appSchemes,
    states,
    dryRun: options.dryRun,
    resend: options.resend,
    reporter,
    evidenceDirectory: evidenceDirectoryFor(options),
    tap: plan.tap,
  });
  await addSent(
    ladder,
    options,
    {
      delivered: explainNotificationsOff(
        delivered,
        delivered.notificationAuthorization?.allowed === false,
        reporter
      ),
      opened,
    },
    {
      environmentId: inputs.environmentId,
      reporter,
      tapSkipped: plan.skipped,
    }
  );
}
