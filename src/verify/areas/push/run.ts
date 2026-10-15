import chalk from 'chalk';
import * as path from 'path';
import { refusalUnattended } from '../../core/consent';
import { ERROR_CODES } from '../../core/errors';
import { resolveLevel } from '../../core/levels';
import { Asker } from '../../core/prompt';
import { Ladder } from '../../core/report/ladder';
import { Report } from '../../core/report/types';
import { RunContext, ToolFailure } from '../../core/run';
import {
  AndroidProjectModel,
  loadAndroidProject,
} from '../../platform/android/project';
import { ALL_STATES, AppState } from '../../platform/app_state';
import { cioContext, setActiveProfile } from '../../platform/cio/cli';
import { XcodeProjectModel, loadProject } from '../../platform/ios/xcode';
import { detectPlatform } from '../../platform/project';
import { climbAndroid } from './android_flow';
import { openedStatesToSend } from './consent';
import { OPENED_STATES } from './on_device/opened';
import { climb } from './ios_flow';
import { PUSH_LEVELS } from './levels';
import {
  PushFlags,
  evidenceDirectoryFor,
  parseStates,
  settingsFrom,
} from './options';
import { pushRerun, unprovenStates } from './rerun';
import {
  Selection,
  selectForAndroid,
  selectForIos,
  selectionFacts,
} from './select';
import { MatrixSection } from './types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require('../../../../package.json');

/**
 * Which of push's answers the command line gave, as opposed to the run picking them or a
 * person answering a question. Naming where pushes go is the go-ahead to send them.
 */
export interface Given {
  /** Typed, or implied by a flag that only means something when pushes are sent. */
  depth: boolean;
  workspace: boolean;
  device: boolean;
  /** Those sending flags, as typed: a registration run that names one contradicts itself. */
  sendingFlags: string[];
}

/**
 * Push's run: settle how far to go and where, climb the registration rungs, then send and
 * follow the pushes when the level does. The core sets up the output and the questions
 * around it.
 */
export async function runPush(
  pathArg: string,
  flags: PushFlags,
  given: Given,
  { reporter, asker }: RunContext
): Promise<Report> {
  const options = settingsFrom(flags);
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

  if (flags.depth === 'registration' && given.sendingFlags.length > 0) {
    throw new ToolFailure(
      `${given.sendingFlags.join(', ')} ${
        given.sendingFlags.length === 1 ? 'only means' : 'only mean'
      } something when pushes are sent, and --depth registration sends none — use --depth on-device`,
      ERROR_CODES.validation,
      { flag: '--depth' }
    );
  }

  const { level, asked: levelAsked } = await resolveLevel(PUSH_LEVELS, {
    given: flags.depth,
    flag: '--depth',
    asker,
    question: 'How far should this go?',
    fallback: 'registration',
  });
  options.send = level.id !== 'registration';
  options.recorded = level.steps.includes('recorded');

  // Someone who answered "how far" by hand is asked the rest the same way. A command line
  // that set the depth gets the defaults instead: all three states, no taps.
  if (levelAsked && options.send) {
    const pushes = await choosePushes(asker);
    states = pushes.states;
    options.opened = pushes.opened;
    if (options.opened) {
      options.link = await asker.ask('Deep link for the pushes?', {
        hint: 'Enter to skip; opens are still checked',
      });
    }
  }
  options.states = states?.join(',');
  options.named = given.depth && given.workspace && given.device;

  // One evidence folder per sending run, settled here so every section writes into it. The
  // opened section used to keep its log only on request, so the one run that most needed
  // reading afterwards — a tap the tool said it never saw — left nothing behind.
  if (options.send) options.evidence = evidenceDirectoryFor(options);

  // Decided before anything is touched: a run nobody can answer sends only where it was
  // told to.
  const refusal = refusalUnattended({
    sends: options.send && !options.dryRun,
    interactive: asker.interactive,
    destinations: [
      { flag: '--depth <level>', named: given.depth },
      { flag: '--workspace <id>', named: given.workspace },
      { flag: '--device <id|name>', named: given.device },
    ],
    what: 'real pushes',
  });
  if (refusal) {
    throw new ToolFailure(refusal.message, ERROR_CODES.validation, {
      flags: refusal.flags,
    });
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
    const parsed = await loadProject(detected.path, options.configuration);
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
    selectionFacts(selection, {
      dryRun: options.dryRun,
      depth: level.id,
      depthSource: given.depth ? 'flag' : levelAsked ? 'picked' : undefined,
      taps: openedStatesToSend({
        opened: options.opened && !options.dryRun,
        interactive: asker.interactive,
        delivered: selection.states,
      }),
    })
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

  const unproven = unprovenStates(ladder.matrices);
  const rerunInput = {
    program: `${packageJson.name} verify push`,
    pathArg,
    level: level.id,
    options,
    flags,
    selection,
  };

  return ladder.toReport({
    schema: 1,
    // `observed` is only claimed when the run actually watched a fact appear. An agent
    // that installed the build before calling us leaves nothing to watch, and that run is
    // honestly a `read` — the freshness note is where its recency shows up.
    provenance: climbed.observed ? 'observed' : 'read',
    advice: advice([
      ...(climbed.notes ?? []),
      ...(climbed.freshnessNote
        ? [
            `${climbed.freshnessNote} — a run that watches a fresh install proves more; see --watch-registration`,
          ]
        : []),
    ]),
    consent: climbed.consent,
    tool: { name: packageJson.name, version: packageJson.version },
    command: 'verify push',
    area: 'push',
    level: level.id,
    rerun: pushRerun(rerunInput),
    rerunUnproven:
      unproven.length > 0 && !options.dryRun
        ? pushRerun({
            ...rerunInput,
            // Taps only on the states that get one: a lone foreground retry has no banner
            // the tap test would ask for.
            options: {
              ...options,
              opened:
                options.opened &&
                unproven.some((state) => OPENED_STATES.includes(state)),
            },
            selection: { ...selection, states: unproven },
          })
        : undefined,
    startedAt,
    finishedAt: new Date().toISOString(),
    project: {
      path: detected.path,
      framework: detected.platform === 'android' ? 'Android' : 'iOS',
      name: climbed.projectName,
    },
  });
}

/**
 * How many pushes, and whether someone taps them, asked as one question: the two answers
 * only make sense together, and asking them apart was two questions for one decision.
 */
async function choosePushes(
  asker: Asker
): Promise<{ states: AppState[]; opened: boolean }> {
  return asker.select(
    'Which pushes?',
    [
      {
        value: { states: [...ALL_STATES], opened: false },
        label: '3, one per app state',
        hint: 'nothing for you to do',
      },
      {
        value: { states: [...ALL_STATES], opened: true },
        label: '3, and you tap 2',
        hint: 'also checks opens',
      },
      {
        value: { states: ['killed' as AppState], opened: true },
        label: '1 with the app killed, and you tap it',
        hint: 'the quickest check of both',
      },
    ],
    { flag: '--app-states <list> and --check-opens' }
  );
}

function advice(notes: string[]): string[] | undefined {
  return notes.length > 0 ? notes : undefined;
}
