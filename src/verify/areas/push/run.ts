import chalk from 'chalk';
import * as path from 'path';
import { cioContext, setActiveProfile } from '../../platform/cio/cli';
import { Ladder } from '../../core/report/ladder';
import {
  Selection,
  selectionFacts,
  selectForAndroid,
  selectForIos,
} from './select';
import {
  AndroidProjectModel,
  loadAndroidProject,
} from '../../platform/android/project';
import { XcodeProjectModel, loadProject } from '../../platform/ios/xcode';
import { AppState } from '../../platform/app_state';
import { refusalWithoutConsent } from './consent';
import { ERROR_CODES } from '../../core/errors';
import { Report } from '../../core/report/types';
import { MatrixSection } from './types';
import { RunContext, ToolFailure } from '../../core/run';
import {
  VerifyPushOptions,
  evidenceDirectoryFor,
  parseStates,
} from './options';
import { climb } from './ios_flow';
import { climbAndroid } from './android_flow';
import { detectPlatform } from '../../platform/project';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require('../../../../package.json');

/**
 * Push's run: settle what is being verified, climb the registration rungs, then send and
 * follow the pushes when asked to. The core sets up the output and the questions around it.
 */
export async function runPush(
  pathArg: string,
  options: VerifyPushOptions,
  { reporter, asker }: RunContext
): Promise<Report> {
  // Set once, before any credential is read.
  setActiveProfile(options.profile);

  const root = path.resolve(process.cwd(), pathArg);
  const detected = await detectPlatform(root, options.platform);
  if ('error' in detected) {
    throw new ToolFailure(detected.error, ERROR_CODES.validation);
  }

  let states: AppState[] | undefined;
  try {
    states = parseStates(options.states);
  } catch (error) {
    throw new ToolFailure((error as Error).message, ERROR_CODES.validation);
  }

  // `--opened` taps the pushes the delivered check sends, so a run that asks for it is a
  // sending run. Without this the delivered matrix stayed skipped and dragged a run that
  // verified two taps down to "nothing was proven".
  if (options.opened) options.send = true;

  // One evidence folder per sending run, settled here so every matrix writes into it. The
  // opened matrix used to keep its log only with --evidence, so the one run that most
  // needed reading afterwards — a tap the tool said it never saw — left nothing behind.
  if (options.send) options.evidence = evidenceDirectoryFor(options);

  const refusal = refusalWithoutConsent({
    send: options.send,
    opened: options.opened,
    dryRun: options.dryRun,
    yes: options.yes,
    interactive: asker.interactive,
  });
  if (refusal) {
    throw new ToolFailure(refusal, ERROR_CODES.validation, { flag: '--yes' });
  }

  const cio = await cioContext();
  const startedAt = new Date().toISOString();
  const ladder = new Ladder<MatrixSection>();

  let selection: Selection;
  let model: XcodeProjectModel | AndroidProjectModel | undefined;
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

  return built;
}
