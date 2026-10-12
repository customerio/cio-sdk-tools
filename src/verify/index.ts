import chalk from 'chalk';
import { Command } from 'commander';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CioContext, cioContext, setActiveProfile } from './cio/cli';
import { stopwatch } from './clock';
import { PushProvider } from './cio/push';
import { Ladder } from './ladder';
import { Level, Reporter, createReporter } from './report';
import {
  Asker,
  MissingInput,
  createAsker,
  describeMissingInput,
} from './prompt';
import { freshness, watchFor } from './observe';
import { startAndroidCapture } from './matrix/android_logs';
import { startCapture } from './matrix/logs';
import {
  Target as IosTarget,
  describeTarget,
  listTargets,
  locateApp,
  readSdkState,
} from './ios/device';
import {
  Selection,
  selectionFacts,
  selectForAndroid,
  selectForIos,
} from './select';
import { AndroidProjectModel, loadAndroidProject } from './android/project';
import { XcodeProjectModel, loadProject } from './ios/xcode';
import { runDeliveredMatrix } from './matrix';
import { RATE_LIMITED_CAUSE, whyNoSend } from './matrix/send';
import { openedSkipReason, runOpenedMatrix } from './matrix/opened';
import { runAndroidOpenedMatrix } from './matrix/android_opened';
import { runAndroidDeliveredMatrix } from './matrix/android';
import { ALL_STATES, AppState } from './matrix/states';
import {
  describeAndroidTarget,
  packageInstalled,
  readAndroidSdkState,
} from './android/device';
import {
  consentToSend,
  openedStatesToSend,
  refusalWithoutConsent,
} from './consent';
import {
  androidDeviceReady,
  gatherAndroidDevice,
} from './rungs/android_device';
import { androidWiring } from './rungs/android_wiring';
import { deviceReady, gatherDevice } from './rungs/device_ready';
import { profileLinked } from './rungs/profile_linked';
import { projectWiring } from './rungs/project_wiring';
import { gatherWorkspace, workspaceReady } from './rungs/workspace_ready';
import { ERROR_CODES, ErrorCode, printError } from './errors';
import { Consent, RUNG_TITLES, Report, RungId } from './types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require('../../package.json');

type VerifyPushOptions = {
  json: boolean;
  report?: string;
  appTarget?: string;
  configuration: string;
  target?: string;
  workspace?: string;
  platform?: string;
  appModule?: string;
  profile?: string;
  send: boolean;
  dryRun: boolean;
  resend: boolean;
  yes: boolean;
  quiet: boolean;
  verbose: boolean;
  package?: string;
  nonInteractive: boolean;
  observe: boolean;
  opened: boolean;
  link?: string;
  states?: string;
  evidence?: string;
};

/**
 * `verify push` is the deterministic half of push verification. Its whole reason to exist
 * is that an agent asked "did push work?" will answer yes from a clean build — so the
 * answer has to come from evidence, with a stable name for whatever went wrong.
 *
 * Preflight (this command today) proves the integration *could* report a push. The runtime
 * matrix that proves one actually was is the next step, and deliberately separate.
 */
export const verifyCommand = new Command('verify').description(
  'Verify a Customer.io mobile SDK integration with evidence rather than optimism'
);

const pushCommand = new Command('push')
  .description(
    'Verify an iOS or Android push integration, then send real pushes and follow each one until the SDK reports it'
  )
  .argument(
    '[path]',
    'path to the project: an .xcodeproj, a Gradle app module, or a directory holding one',
    '.'
  )
  .option('--json', 'emit the machine-readable report on stdout', false)
  .option('--report <path>', 'write the machine-readable report to a file')
  .option(
    '--app-target <name>',
    'app target to verify, when the project builds several'
  )
  .option(
    '--configuration <name>',
    'build configuration to read settings from',
    'Debug'
  )
  .option(
    '--target <name|udid|serial>',
    'simulator, device or emulator to verify against'
  )
  .option('--platform <ios|android>', 'skip platform detection')
  .option(
    '--package <applicationId>',
    'Android application id to verify, when the module builds several variants'
  )
  .option(
    '--non-interactive',
    'never prompt; every choice must come from a flag',
    false
  )
  .option(
    '--opened',
    'also verify the opened metric and the deep link — needs one tap per app state, so it never runs unattended (implies --send)',
    false
  )
  .option(
    '--link <url>',
    'deep link to send with the tap test (must be a URL the app routes)'
  )
  .option(
    '--observe',
    'watch the install, the token and the login happen, instead of reading what they left behind',
    false
  )
  .option(
    '--app-module <name>',
    'Gradle app module to verify, when the project builds several'
  )
  .option(
    '--workspace <id>',
    'workspace (environment) id, skipping auto-selection'
  )
  .option(
    '--profile <name>',
    'cio CLI credential profile to read (defaults to its current_profile)'
  )
  .option(
    '--send',
    'send real pushes and follow each one until the SDK reports it delivered',
    false
  )
  .option(
    '--states <list>',
    `app states to cover when sending (${ALL_STATES.join(', ')})`
  )
  .option(
    '--dry-run',
    'with --send, do everything except the send itself',
    false
  )
  .option(
    '--no-resend',
    'never send a second push when the first does not arrive'
  )
  .option(
    '-y, --yes',
    'send real pushes without asking first; required to send when nobody can be asked (--non-interactive, --json, no terminal)',
    false
  )
  .option(
    '-v, --verbose',
    'print every check, every command and every phase (also CIO_VERBOSE=1)',
    false
  )
  .option(
    '-q, --quiet',
    'print only the verdict and what to do about it',
    false
  )
  .option('--evidence <dir>', 'directory to write captured logs into')
  .action(async (pathArg: string, options: VerifyPushOptions) => {
    process.exitCode = await verifyPush(pathArg, options);
  });

verifyCommand.addCommand(pushCommand);

/**
 * `CIO_VERBOSE` exists because Expo's `EXPO_DEBUG` habit is worth borrowing: the moment
 * you want detail is usually inside a script you are not editing.
 */
function levelFrom(options: VerifyPushOptions): Level {
  if (options.json) return 'json';
  if (options.verbose || process.env.CIO_VERBOSE === '1') return 'verbose';
  if (options.quiet) return 'quiet';
  return 'human';
}

async function verifyPush(
  pathArg: string,
  options: VerifyPushOptions
): Promise<number> {
  // Set once, before any credential is read.
  setActiveProfile(options.profile);

  const root = path.resolve(process.cwd(), pathArg);
  const detected = await detectPlatform(root, options.platform);
  if ('error' in detected)
    return toolError(options, detected.error, ERROR_CODES.validation);

  let states: AppState[] | undefined;
  try {
    states = parseStates(options.states);
  } catch (error) {
    return toolError(options, (error as Error).message, ERROR_CODES.validation);
  }

  // `--opened` sends its own pushes, so a run that asks for it is a sending run. Without
  // this the delivered matrix stayed skipped and dragged a run that verified two taps
  // down to "nothing was proven".
  if (options.opened) options.send = true;

  const level = levelFrom(options);
  const reporter = createReporter({ level });

  // Questions come before anything is touched, and a run that cannot ask says which flag
  // would have answered it. `--json` implies non-interactive: a machine reading stdout is
  // not going to type a number.
  const asker = createAsker({
    interactive:
      level !== 'json' &&
      !options.nonInteractive &&
      Boolean(process.stdin.isTTY),
  });

  const refusal = refusalWithoutConsent({
    send: options.send,
    opened: options.opened,
    dryRun: options.dryRun,
    yes: options.yes,
    interactive: asker.interactive,
  });
  if (refusal) {
    return toolError(options, refusal, ERROR_CODES.validation, {
      details: { flag: '--yes' },
    });
  }

  const cio = await cioContext();
  const startedAt = new Date().toISOString();
  const ladder = new Ladder();

  let selection: Selection;
  let model: XcodeProjectModel | AndroidProjectModel | undefined;
  try {
    if (detected.platform === 'android') {
      const parsed = await loadAndroidProject(detected.path, options.appModule);
      model = parsed;
      selection = await selectForAndroid({
        cio,
        asker,
        model: parsed,
        appModule: options.appModule,
        packageName: options.package,
        workspace: options.workspace,
        target: options.target,
        states,
        send: options.send,
      });
    } else {
      const parsed = await loadProject(
        detected.path,
        options.configuration ?? 'Debug'
      );
      model = parsed;
      selection = await selectForIos({
        cio,
        asker,
        model: parsed,
        appTarget: options.appTarget,
        workspace: options.workspace,
        target: options.target,
        states,
        send: options.send,
      });
    }
  } catch (error) {
    if (error instanceof MissingInput) {
      // The message stays one line and the candidates go in `details`, so an agent reads
      // a list instead of parsing a paragraph.
      return toolError(options, error.message, ERROR_CODES.validation, {
        details: { flag: error.flag, candidates: error.candidates },
        humanSuffix: describeMissingInput(error)
          .split('\n')
          .slice(1)
          .join('\n'),
      });
    }
    throw error;
  }

  reporter.start(
    `${path.basename(detected.path, path.extname(detected.path))} ${chalk.dim(
      `· ${detected.platform === 'android' ? 'Android' : 'iOS'}`
    )}`,
    selectionFacts(selection, { dryRun: options.dryRun })
  );

  const climbed =
    detected.platform === 'android'
      ? await climbAndroid(
          ladder,
          detected.path,
          options,
          reporter,
          cio,
          selection,
          model as AndroidProjectModel,
          asker
        )
      : await climb(
          ladder,
          detected.path,
          options,
          reporter,
          cio,
          selection,
          model as XcodeProjectModel,
          asker
        );

  const built = ladder.toReport({
    schema: 1,
    // `observed` is only claimed when the run actually watched a fact appear. An agent
    // that installed the build before calling us leaves nothing to watch, and that run is
    // honestly a `read` — the freshness note is where its recency shows up.
    provenance: climbed.observed ? 'observed' : 'read',
    advice: climbed.freshnessNote
      ? [
          `${climbed.freshnessNote} — a run that watches a fresh install proves more; see --observe`,
        ]
      : undefined,
    consent: climbed.consent,
    tool: { name: packageJson.name, version: packageJson.version },
    command: 'verify push',
    startedAt,
    finishedAt: new Date().toISOString(),
    project: {
      path: detected.path,
      framework: detected.platform === 'android' ? 'Android' : 'iOS',
      name: climbed.projectName,
    },
  });

  await emit(built, reporter, options);
  return built.exitCode;
}

interface ClimbResult {
  projectName?: string;
  /** Set when a real send was due, whether or not it was allowed. */
  consent?: Consent;
  /** True when the run watched a fact appear rather than reading it afterwards. */
  observed?: boolean;
  /** Advice, never an assertion: how old the build under test is. */
  freshnessNote?: string;
}

/**
 * The climb itself. Each rung is adopted in the order it is reported, and the first failure
 * turns the rest into explicit skips — a later rung's answer is not merely unknown after an
 * early failure, it is meaningless.
 */
async function climb(
  ladder: Ladder,
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
    skipRest(ladder, reporter, [
      'workspace_ready',
      'device_ready',
      'profile_linked',
    ]);
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
      provider: wiring.provider,
      resolution: selection.resolution,
    });
    const ready = workspaceReady(workspace, wiring.apsEnvironment);
    ladder.adopt(ready, workspaceTimer());
    workspaceRung.done(ready);
    if (ladder.halted) {
      skipRest(ladder, reporter, ['device_ready', 'profile_linked']);
      return { projectName: wiring.model.projectName };
    }

    const deviceRungResult = deviceReady(device, wiring.bundleId);
    ladder.adopt(deviceRungResult, deviceMs);
    deviceRung.done(deviceRungResult);
    if (ladder.halted) {
      skipRest(ladder, reporter, ['profile_linked']);
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
      bundleId: wiring.bundleId,
    });
    ladder.adopt(profile, profileTimer());
    profileRung.done(profile);

    const consent = await askToSend(ladder, options, reporter, asker, {
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
    if (consent?.granted !== false) {
      await matrix(ladder, options, reporter, selection.states, {
        target: device.target,
        bundleId: wiring.bundleId,
        provider: wiring.provider,
        environmentId: workspace.resolution?.workspace?.id,
        workspaceReason: workspace.resolution?.unresolvedReason ?? cio.reason,
        token: device.sdk?.pushDeviceToken,
        sandbox: wiring.apsEnvironment !== 'production',
        processNames: wiring.processNames,
      });
      await openedMatrix(ladder, options, reporter, asker, {
        target: device.target,
        bundleId: wiring.bundleId,
        environmentId: workspace.resolution?.workspace?.id,
        workspaceReason: workspace.resolution?.unresolvedReason ?? cio.reason,
        token: device.sdk?.pushDeviceToken,
        sandbox: wiring.apsEnvironment !== 'production',
        provider: wiring.provider,
        processNames: wiring.processNames,
      });
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
  const capture = await startCapture(
    input.target,
    input.evidenceDirectory,
    input.processNames ?? []
  );
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

function askerPhases(
  input: { reporter: Reporter; asker: Asker },
  handle: { phase(text: string): void }
): {
  asker: Asker;
  onPhase: (text: string) => void;
  onInstruction: (text: string) => void;
} {
  return {
    asker: input.asker,
    onPhase: (text) => handle.phase(text),
    // Instructions are for a person; an agent that has already installed the build never
    // sees them, because the probe is true on the first tick.
    onInstruction: (text) => input.reporter.note(text),
  };
}

function skipRest(ladder: Ladder, reporter: Reporter, ids: RungId[]): void {
  for (const id of ids) {
    const rung = ladder.skip(id, RUNG_TITLES[id], 'an earlier rung failed');
    reporter.rung(RUNG_TITLES[id]).done(rung);
  }
  ladder.addMatrix({
    metric: 'delivered',
    cells: [],
    skipped: 'preflight did not pass, so no push was sent',
  });
}

/**
 * Sending is opt-in, and its absence is reported rather than omitted: a preflight that
 * passes proves the integration *could* report a delivery, which is not the same claim as
 * one that did. Without --send the verdict stays inconclusive on purpose.
 */
async function matrix(
  ladder: Ladder,
  options: VerifyPushOptions,
  reporter: Reporter,
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
  }
): Promise<void> {
  if (!options.send) {
    ladder.addMatrix({
      metric: 'delivered',
      cells: [],
      skipped:
        'no push was sent — pass --send to send one per app state and follow it until the SDK reports it',
    });
    return;
  }

  if (
    !inputs.target ||
    !inputs.bundleId ||
    !inputs.environmentId ||
    !inputs.token
  ) {
    ladder.addMatrix({
      metric: 'delivered',
      cells: [],
      skipped:
        whyNoSend({
          target: inputs.target,
          app: inputs.bundleId,
          workspaceId: inputs.environmentId,
          workspaceReason: inputs.workspaceReason,
          token: inputs.token,
        }) ?? 'no push was sent',
    });
    return;
  }

  const evidenceDirectory =
    options.evidence ??
    path.join(
      os.tmpdir(),
      `cio-verify-${new Date().toISOString().slice(0, 19)}`
    );

  ladder.addMatrix(
    await runDeliveredMatrix({
      target: inputs.target,
      bundleId: inputs.bundleId,
      environmentId: inputs.environmentId,
      token: inputs.token,
      sandbox: inputs.sandbox,
      provider: inputs.provider,
      processNames: inputs.processNames,
      states,
      dryRun: options.dryRun,
      resend: options.resend,
      reporter,
      evidenceDirectory,
    })
  );
}

/** Records the opened section as skipped when it must not run; see `openedSkipReason`. */
function skipOpened(ladder: Ladder, options: VerifyPushOptions): boolean {
  const skipped = openedSkipReason({
    dryRun: options.dryRun,
    rateLimited: ladder.matrixHasCause(RATE_LIMITED_CAUSE),
  });
  if (!skipped) return false;
  ladder.addMatrix({ metric: 'opened', cells: [], skipped });
  return true;
}

/** The Android half of the opened matrix: same causes, Android's own sentences. */
async function androidOpened(
  ladder: Ladder,
  options: VerifyPushOptions,
  reporter: Reporter,
  asker: Asker,
  inputs: {
    serial?: string;
    packageName?: string;
    environmentId?: string;
    workspaceReason?: string;
    token?: string;
  }
): Promise<void> {
  if (!options.opened) return;
  if (skipOpened(ladder, options)) return;
  if (
    !inputs.serial ||
    !inputs.packageName ||
    !inputs.environmentId ||
    !inputs.token
  ) {
    ladder.addMatrix({
      metric: 'opened',
      cells: [],
      skipped:
        whyNoSend({
          target: inputs.serial,
          app: inputs.packageName,
          workspaceId: inputs.environmentId,
          workspaceReason: inputs.workspaceReason,
          token: inputs.token,
        }) ?? 'no push was sent',
    });
    return;
  }
  if (!options.link) {
    ladder.addMatrix({
      metric: 'opened',
      cells: [],
      skipped:
        'pass --link <url> with a URL this app routes, so the deep link half can be judged',
    });
    return;
  }

  ladder.addMatrix(
    await runAndroidOpenedMatrix({
      serial: inputs.serial,
      packageName: inputs.packageName,
      environmentId: inputs.environmentId,
      token: inputs.token,
      link: options.link,
      states: options.states ? parseStates(options.states) : undefined,
      evidenceDirectory: options.evidence,
      asker,
      reporter,
    })
  );
}

/**
 * The opened matrix, which only ever runs when asked and when someone can answer.
 *
 * Kept separate from the delivered matrix rather than folded in as more cells, because it
 * is a different kind of run: unattended verification is the product, and this is the part
 * that cannot be.
 */
async function openedMatrix(
  ladder: Ladder,
  options: VerifyPushOptions,
  reporter: Reporter,
  asker: Asker,
  inputs: {
    target?: IosTarget;
    bundleId?: string;
    environmentId?: string;
    workspaceReason?: string;
    token?: string;
    sandbox: boolean;
    provider: PushProvider;
    processNames?: string[];
  }
): Promise<void> {
  if (!options.opened) return;
  if (skipOpened(ladder, options)) return;
  if (
    !inputs.target ||
    !inputs.bundleId ||
    !inputs.environmentId ||
    !inputs.token
  ) {
    ladder.addMatrix({
      metric: 'opened',
      cells: [],
      skipped:
        whyNoSend({
          target: inputs.target,
          app: inputs.bundleId,
          workspaceId: inputs.environmentId,
          workspaceReason: inputs.workspaceReason,
          token: inputs.token,
        }) ?? 'no push was sent',
    });
    return;
  }
  if (!options.link) {
    ladder.addMatrix({
      metric: 'opened',
      cells: [],
      skipped:
        'pass --link <url> with a URL this app routes, so the deep link half can be judged',
    });
    return;
  }

  ladder.addMatrix(
    await runOpenedMatrix({
      target: inputs.target,
      bundleId: inputs.bundleId,
      environmentId: inputs.environmentId,
      token: inputs.token,
      sandbox: inputs.sandbox,
      provider: inputs.provider,
      link: options.link,
      states: options.states ? parseStates(options.states) : undefined,
      processNames: inputs.processNames,
      evidenceDirectory: options.evidence,
      asker,
      reporter,
    })
  );
}

function parseStates(list?: string): AppState[] | undefined {
  if (!list) return undefined;
  const wanted = list
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean) as AppState[];
  const unknown = wanted.filter((state) => !ALL_STATES.includes(state));
  if (unknown.length > 0) {
    throw new Error(
      `unknown app state${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`
    );
  }
  return wanted;
}

async function emit(
  built: Report,
  reporter: Reporter,
  options: VerifyPushOptions
): Promise<void> {
  if (options.report) {
    await fs.writeFile(
      path.resolve(process.cwd(), options.report),
      `${JSON.stringify(built, null, 2)}\n`,
      'utf8'
    );
  }
  if (options.json) process.stdout.write(`${JSON.stringify(built, null, 2)}\n`);
  else reporter.summary(built);
}

/**
 * A failure of the tool itself, which is never a verdict about the integration — written to
 * stderr in the `cio` CLI's envelope so one consumer can read both tools.
 */
function toolError(
  options: VerifyPushOptions,
  message: string,
  code: ErrorCode = ERROR_CODES.general,
  extra?: { details?: unknown; humanSuffix?: string }
): number {
  const exitCode = printError(code, message, { details: extra?.details });
  if (!options.json) {
    process.stderr.write(`${message}\n`);
    if (extra?.humanSuffix) process.stderr.write(`${extra.humanSuffix}\n`);
  }
  return exitCode;
}

/**
 * The Android climb.
 *
 * The same four rungs and the same cause-code vocabulary, because the plugin reading this
 * should not need to learn a second contract. What differs is the evidence: no extension to
 * prove ran, a stopped state that blocks delivery outright, and a permission that gates
 * display without touching delivery at all.
 */
async function climbAndroid(
  ladder: Ladder,
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
    skipRest(ladder, reporter, [
      'workspace_ready',
      'device_ready',
      'profile_linked',
    ]);
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
    skipRest(ladder, reporter, ['device_ready', 'profile_linked']);
    return { projectName: wiring.model.appModuleName };
  }

  const deviceRungResult = androidDeviceReady(device, packageName);
  ladder.adopt(deviceRungResult, deviceMs);
  deviceRung.done(deviceRungResult);
  if (ladder.halted) {
    skipRest(ladder, reporter, ['profile_linked']);
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
    await androidMatrix(ladder, options, reporter, selection.states, {
      serial: device.target?.serial,
      packageName,
      environmentId: workspace.resolution?.workspace?.id,
      workspaceReason: workspace.resolution?.unresolvedReason ?? cio.reason,
      token: device.sdk?.deviceToken,
    });

    // Taps come last: the unattended cells should be done before anyone is asked for
    // anything, which is also the order iOS runs in.
    await androidOpened(ladder, options, reporter, asker, {
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
 * The one question before the first real push, asked after preflight because the token it
 * names only exists once the device has been read. Returns nothing when there is nothing
 * real to send — no `--send`, a dry run, or an input missing, in which case the matrices
 * skip themselves with the reason — and a consent whose `granted` gates the matrices
 * otherwise.
 */
async function askToSend(
  ladder: Ladder,
  options: VerifyPushOptions,
  reporter: Reporter,
  asker: Asker,
  inputs: {
    target?: string;
    app?: string;
    workspace?: { id: string; name?: string };
    login?: string;
    token?: string;
    delivered?: AppState[];
    retries: boolean;
  }
): Promise<Consent | undefined> {
  if (!options.send || options.dryRun) return undefined;
  if (!inputs.target || !inputs.app || !inputs.workspace || !inputs.token) {
    return undefined;
  }
  return consentToSend({
    plan: {
      target: inputs.target,
      app: inputs.app,
      workspace: `${inputs.workspace.name ?? inputs.workspace.id} (${
        inputs.workspace.id
      })`,
      login: inputs.login,
      token: inputs.token,
      delivered: inputs.delivered ?? ALL_STATES,
      opened: openedStatesToSend({
        opened: options.opened,
        link: options.link,
        interactive: asker.interactive,
        states: parseStates(options.states),
      }),
      retries: inputs.retries,
    },
    yes: options.yes,
    opened: options.opened,
    asker,
    reporter,
    ladder,
  });
}

async function androidMatrix(
  ladder: Ladder,
  options: VerifyPushOptions,
  reporter: Reporter,
  states: AppState[] | undefined,
  inputs: {
    serial?: string;
    packageName?: string;
    environmentId?: string;
    workspaceReason?: string;
    token?: string;
  }
): Promise<void> {
  if (!options.send) {
    ladder.addMatrix({
      metric: 'delivered',
      cells: [],
      skipped:
        'no push was sent — pass --send to send one per app state and follow it until the SDK reports it',
    });
    return;
  }
  if (
    !inputs.serial ||
    !inputs.packageName ||
    !inputs.environmentId ||
    !inputs.token
  ) {
    ladder.addMatrix({
      metric: 'delivered',
      cells: [],
      skipped:
        whyNoSend({
          target: inputs.serial,
          app: inputs.packageName,
          workspaceId: inputs.environmentId,
          workspaceReason: inputs.workspaceReason,
          token: inputs.token,
        }) ?? 'no push was sent',
    });
    return;
  }

  ladder.addMatrix(
    await runAndroidDeliveredMatrix({
      serial: inputs.serial,
      packageName: inputs.packageName,
      environmentId: inputs.environmentId,
      token: inputs.token,
      states,
      dryRun: options.dryRun,
      reporter,
      evidenceDirectory: evidenceDirectoryFor(options),
    })
  );
}

function evidenceDirectoryFor(options: VerifyPushOptions): string {
  return (
    options.evidence ??
    path.join(
      os.tmpdir(),
      `cio-verify-${new Date().toISOString().slice(0, 19)}`
    )
  );
}

/**
 * Which platform is this?
 *
 * A wrapper project has both an `.xcodeproj` and a Gradle build, and guessing between them
 * would verify the half the developer did not mean. So both being present is a question,
 * not a coin toss.
 */
async function detectPlatform(
  root: string,
  explicit?: string
): Promise<{ platform: 'ios' | 'android'; path: string } | { error: string }> {
  if (explicit && !['ios', 'android'].includes(explicit)) {
    return { error: `unknown platform: ${explicit}` };
  }

  const iosProject = await locateProject(root);
  const androidProject = await locateAndroidProject(root);

  if (explicit === 'ios' || (!explicit && iosProject && !androidProject)) {
    if (!iosProject)
      return { error: `No .xcodeproj found at or under ${root}` };
    if (process.platform !== 'darwin') {
      return {
        error:
          'iOS verification needs macOS: it reads the project with Xcode tooling and the device with simctl.',
      };
    }
    return { platform: 'ios', path: iosProject };
  }

  if (explicit === 'android' || (!explicit && androidProject && !iosProject)) {
    if (!androidProject) {
      return { error: `No Gradle project found at or above ${root}` };
    }
    return { platform: 'android', path: androidProject };
  }

  if (iosProject && androidProject) {
    return {
      error:
        'this path has both an Xcode project and a Gradle build; pass --platform ios or --platform android',
    };
  }
  return { error: `No Xcode or Gradle project found at or under ${root}` };
}

/** The module directory, not the Gradle root: the app module is what gets verified. */
async function locateAndroidProject(root: string): Promise<string | undefined> {
  const isModule = async (dir: string): Promise<boolean> => {
    for (const name of ['build.gradle', 'build.gradle.kts']) {
      const text = await fs
        .readFile(path.join(dir, name), 'utf8')
        .catch(() => '');
      if (/com\.android\.application/.test(text)) return true;
    }
    return false;
  };

  if (await isModule(root)) return root;

  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    const entries: string[] = await fs.readdir(dir).catch(() => []);
    for (const entry of entries) {
      if (
        entry.startsWith('.') ||
        ['node_modules', 'build', 'Pods', '.gradle'].includes(entry)
      ) {
        continue;
      }
      const full = path.join(dir, entry);
      const stat = await fs.stat(full).catch(() => undefined);
      if (!stat?.isDirectory()) continue;
      if (await isModule(full)) {
        found.push(full);
        continue;
      }
      await walk(full, depth + 1);
    }
  };
  await walk(root, 0);
  found.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
  return found[0];
}

/** Accept either a project directory or the `.xcodeproj` itself. */
async function locateProject(root: string): Promise<string | undefined> {
  if (root.endsWith('.xcodeproj')) return root;

  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        entry.startsWith('.') ||
        entry === 'node_modules' ||
        entry === 'Pods'
      ) {
        continue;
      }
      const full = path.join(dir, entry);
      if (entry.endsWith('.xcodeproj')) {
        found.push(full);
        continue;
      }
      const stat = await fs.stat(full).catch(() => undefined);
      if (stat?.isDirectory()) await walk(full, depth + 1);
    }
  };

  await walk(root, 0);
  if (found.length === 0) return undefined;
  // The shallowest project: a sample app nested under a package is the common shape.
  found.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
  return found[0];
}
