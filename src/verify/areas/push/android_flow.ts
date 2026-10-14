import { CioContext } from '../../platform/cio/cli';
import { stopwatch } from '../../core/clock';
import { Reporter } from '../../core/report/render';
import { Asker } from '../../core/prompt';
import { freshness, watchFor } from '../../platform/observe';
import { startAndroidCapture } from '../../platform/android/logcat';
import { Selection } from './select';
import { AndroidProjectModel } from '../../platform/android/project';
import { whyNoSend } from './on_device/send';
import { runAndroidDeliveredMatrix } from './on_device/android';
import { ALL_STATES, AppState } from '../../platform/app_state';
import {
  describeAndroidTarget,
  packageInstalled,
  readAndroidSdkState,
} from '../../platform/android/device';
import {
  androidDeviceReady,
  gatherAndroidDevice,
} from './registration/android_device';
import { androidWiring } from './registration/android_wiring';
import { profileLinked } from './registration/profile_linked';
import {
  gatherWorkspace,
  workspaceReady,
} from './registration/workspace_ready';
import { PushLadder, RUNG_TITLES } from './types';
import { VerifyPushOptions, evidenceDirectoryFor } from './options';
import { ClimbResult, skipRest } from './climb';
import { addOpened, askToSend, tapPlanFor } from './sending';
import { askerPhases } from '../../platform/observe';

/**
 * The Android climb.
 *
 * The same four rungs and the same cause-code vocabulary, because the plugin reading this
 * should not need to learn a second contract. What differs is the evidence: no extension to
 * prove ran, a stopped state that blocks delivery outright, and a permission that gates
 * display without touching delivery at all.
 */
export async function climbAndroid(
  ladder: PushLadder,
  projectPath: string,
  options: VerifyPushOptions,
  reporter: Reporter,
  cio: CioContext,
  selection: Selection,
  model: AndroidProjectModel,
  asker: Asker
): Promise<ClimbResult> {
  const wiringRung = reporter.rung(RUNG_TITLES.project_wiring);
  wiringRung.phase('reading the project');
  const wiring = await androidWiring({
    projectPath,
    appModuleName: selection.appModuleName,
    model,
  });
  wiringRung.done(wiring.rung);
  ladder.adopt(wiring.rung);
  if (ladder.halted || !wiring.model) {
    skipRest(
      ladder,
      reporter,
      ['workspace_ready', 'device_ready', 'profile_linked'],
      options.send
    );
    return { projectName: wiring.model?.appModuleName };
  }

  // The project says which ids it *can* build; the chosen variant says which one is
  // installed, and they differ the moment an applicationIdSuffix is in play.
  const packageName = selection.packageName ?? wiring.applicationId;

  let observed = false;
  if (options.observe && selection.targetSelector && packageName) {
    const watch = await observeAndroid({
      serial: selection.targetSelector,
      packageName,
      reporter,
      asker,
      evidenceDirectory: options.evidence,
    });
    observed = watch.observed;
  }

  const deviceTimer = stopwatch();
  const deviceRung = reporter.rung(RUNG_TITLES.device_ready);
  deviceRung.phase('reading the target');
  const device = await gatherAndroidDevice({
    packageName,
    selector: selection.targetSelector,
  });
  const deviceMs = deviceTimer();

  const workspaceTimer = stopwatch();
  const workspaceRung = reporter.rung(RUNG_TITLES.workspace_ready);
  workspaceRung.phase('resolving the workspace');
  const workspace = await gatherWorkspace({
    cio,
    provider: 'fcm',
    resolution: selection.resolution,
  });
  const ready = workspaceReady(workspace);
  ladder.adopt(ready, workspaceTimer());
  workspaceRung.done(ready);
  if (ladder.halted) {
    skipRest(
      ladder,
      reporter,
      ['device_ready', 'profile_linked'],
      options.send
    );
    return { projectName: wiring.model.appModuleName };
  }

  const deviceRungResult = androidDeviceReady(device, packageName);
  ladder.adopt(deviceRungResult, deviceMs);
  deviceRung.done(deviceRungResult);
  if (ladder.halted) {
    skipRest(ladder, reporter, ['profile_linked'], options.send);
    return { projectName: wiring.model.appModuleName };
  }

  const profileTimer = stopwatch();
  const profileRung = reporter.rung(RUNG_TITLES.profile_linked);
  profileRung.phase('checking the profile');
  const profile = await profileLinked({
    cio,
    environmentId: workspace.resolution?.workspace?.id,
    userId: device.sdk?.userId,
    anonymousId: device.sdk?.anonymousId,
    token: device.sdk?.deviceToken,
    candidates: selection.resolution.candidates,
    onSweep: (workspace) =>
      profileRung.phase(`looking in ${workspace.name ?? workspace.id}`),
    bundleId: packageName,
  });
  ladder.adopt(profile, profileTimer());
  profileRung.done(profile);

  const androidFreshness = freshness({
    installedAt: device.installedAt,
    observed,
  });

  // Android's delivered cells never re-send, so there are no retries to announce.
  const consent = await askToSend(ladder, options, reporter, asker, {
    target:
      device.target &&
      `${describeAndroidTarget(device.target)} · ${device.target.serial}`,
    app: packageName,
    workspace: workspace.resolution?.workspace,
    login: cio.profile,
    token: device.sdk?.deviceToken,
    delivered: selection.states,
    retries: false,
  });
  if (consent?.granted !== false) {
    await androidMatrix(ladder, options, reporter, asker, selection.states, {
      serial: device.target?.serial,
      packageName,
      environmentId: workspace.resolution?.workspace?.id,
      workspaceReason: workspace.resolution?.unresolvedReason ?? cio.reason,
      token: device.sdk?.deviceToken,
    });
  }

  return {
    projectName: wiring.model.appModuleName,
    observed,
    freshnessNote: androidFreshness.note,
    consent,
  };
}

/**
 * Observed mode, Android.
 *
 * A capture opens before anything else, because the interesting failures are the ones
 * where nothing appears — a token that never arrives has its reason in the log, and that
 * is exactly the run where an after-the-fact read has nothing to show. The capture is
 * stopped before the climb continues: two concurrent log streams on one target return
 * nothing at all, and the matrix opens its own.
 */
async function observeAndroid(input: {
  serial: string;
  packageName: string;
  reporter: Reporter;
  asker: Asker;
  evidenceDirectory?: string;
}): Promise<{ observed: boolean; evidencePath?: string; notes: string[] }> {
  const handle = input.reporter.rung('Observing');
  const capture = await startAndroidCapture(
    input.serial,
    input.evidenceDirectory
  );
  const notes: string[] = [];
  let observed = false;

  try {
    const installed = await watchFor(
      {
        label: 'app installed',
        instruction: `Install and launch the build on ${input.serial}.`,
        probe: async () =>
          (await packageInstalled(input.serial, input.packageName))
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
        probe: async () =>
          (await readAndroidSdkState(input.serial, input.packageName))
            .deviceToken,
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
        probe: async () =>
          (await readAndroidSdkState(input.serial, input.packageName)).userId,
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

async function androidMatrix(
  ladder: PushLadder,
  options: VerifyPushOptions,
  reporter: Reporter,
  asker: Asker,
  states: AppState[] | undefined,
  inputs: {
    serial?: string;
    packageName?: string;
    environmentId?: string;
    workspaceReason?: string;
    token?: string;
  }
): Promise<void> {
  // Registration sends nothing, and says so in its closing line rather than as a skipped
  // section: nothing it asked for was left unproven.
  if (!options.send) return;
  if (
    !inputs.serial ||
    !inputs.packageName ||
    !inputs.environmentId ||
    !inputs.token
  ) {
    const skipped =
      whyNoSend({
        target: inputs.serial,
        app: inputs.packageName,
        workspaceId: inputs.environmentId,
        workspaceReason: inputs.workspaceReason,
        token: inputs.token,
      }) ?? 'no push was sent';
    ladder.addMatrix({ metric: 'delivered', cells: [], skipped });
    if (options.opened)
      ladder.addMatrix({ metric: 'opened', cells: [], skipped });
    return;
  }

  const plan = tapPlanFor(options, asker, states ?? ALL_STATES);
  const { delivered, opened } = await runAndroidDeliveredMatrix({
    serial: inputs.serial,
    packageName: inputs.packageName,
    environmentId: inputs.environmentId,
    token: inputs.token,
    states,
    dryRun: options.dryRun,
    reporter,
    evidenceDirectory: evidenceDirectoryFor(options),
    tap: plan.tap,
  });
  ladder.addMatrix(delivered);
  addOpened(ladder, options, opened, plan.skipped);
}
