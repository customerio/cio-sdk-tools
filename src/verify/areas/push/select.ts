import chalk from 'chalk';
import {
  AndroidProjectModel,
  BuildVariant,
} from '../../platform/android/project';
import { CioContext } from '../../platform/cio/cli';
import { WorkspaceResolution } from '../../platform/cio/workspace';
import { ALL_STATES, AppState } from '../../platform/app_state';
import { Asker, MissingInput } from '../../core/prompt';
import { XcodeProjectModel } from '../../platform/ios/xcode';
import {
  AnswerSource,
  chooseAndroidTarget,
  chooseAndroidVariant,
  chooseIosApp,
  chooseIosTarget,
  chooseWorkspace,
} from '../../platform/select';

/**
 * What the run is about, settled before it touches anything.
 *
 * Every answer — workspace, app, device — is the person's intent rather than something read
 * out of the project or off whatever happens to be plugged in, and each records where it
 * came from. Everything after this is a comparison of that intent against reality, which is
 * what makes "the workspace you chose does not contain this device" expressible at all.
 */
export interface Selection {
  resolution: WorkspaceResolution;
  /** iOS: the app target's name. */
  appTargetName?: string;
  appTargetSource?: AnswerSource;
  /** Android: the Gradle module, and the id the chosen variant actually produces. */
  appModuleName?: string;
  packageName?: string;
  packageSource?: AnswerSource;
  variant?: BuildVariant;
  targetSelector?: string;
  /** The device's name and its udid or serial, so the facts can say which one it is. */
  targetName?: string;
  targetId?: string;
  targetSource?: AnswerSource;
  /** iOS: a simulator or a phone, when the run could tell which it named. */
  targetKind?: 'simulator' | 'device';
  states?: AppState[];
}

export interface SelectInput {
  cio: CioContext;
  asker: Asker;
  workspace?: string;
  target?: string;
  states?: AppState[];
  send?: boolean;
}

export async function selectForIos(
  input: SelectInput & { model: XcodeProjectModel; appTarget?: string }
): Promise<Selection> {
  const resolution = await chooseWorkspace(input);
  const app = await chooseIosApp(input);
  const target = await chooseIosTarget(input);
  return {
    resolution,
    appTargetName: app.name,
    appTargetSource: app.source,
    targetSelector: target.selector,
    targetName: target.name,
    targetId: target.id,
    targetSource: target.source,
    targetKind: target.kind,
    states: statesToSend(input),
  };
}

export async function selectForAndroid(
  input: SelectInput & {
    model?: AndroidProjectModel;
    appModule?: string;
    packageName?: string;
  }
): Promise<Selection> {
  const resolution = await chooseWorkspace(input);
  const { variant, packageName, source } = await chooseAndroidVariant(input);
  const target = await chooseAndroidTarget(input);
  return {
    resolution,
    appModuleName: input.appModule ?? input.model?.appModuleName,
    packageName,
    packageSource: source,
    variant,
    targetSelector: target.selector,
    targetName: target.name,
    targetId: target.id,
    targetSource: target.source,
    states: statesToSend(input),
  };
}

/**
 * All three states unless told otherwise: a state-dependent failure is a real bug and the
 * whole point of sending one push per state is to catch it. How many to send is asked
 * together with how far to go, never on its own.
 */
function statesToSend(input: SelectInput): AppState[] | undefined {
  if (!input.send) return input.states;
  return input.states ?? [...ALL_STATES];
}

/** How each answer was reached, beside it in the facts. */
function sourceOf(source: AnswerSource | undefined, flag: string): string {
  if (!source) return '';
  return `  ${chalk.dim(source === 'flag' ? flag : source)}`;
}

const WORKSPACE_SOURCE: Record<string, AnswerSource | undefined> = {
  explicit: 'flag',
  chosen: 'picked',
  only_environment: 'only one',
};

/**
 * What was settled, stated before anything runs.
 *
 * Printed as a block rather than a sentence because it is the record of consent: these are
 * the workspace the pushes will land in and the device they will be sent to, and how each
 * was settled — named, picked, or the only one there was.
 */
export function selectionFacts(
  selection: Selection,
  options: {
    dryRun?: boolean;
    depth?: string;
    depthSource?: AnswerSource;
    taps?: AppState[];
  } = {}
): [string, string][] {
  const workspace = selection.resolution.workspace;
  const facts: [string, string][] = [];
  if (selection.packageName) {
    facts.push([
      'app',
      // The only variant there is needs no note; one that was picked or named does.
      `${selection.packageName}${sourceOf(
        selection.packageSource === 'only one'
          ? undefined
          : selection.packageSource,
        '--android-app-id'
      )}`,
    ]);
  } else if (selection.appTargetName) {
    facts.push([
      'app',
      `${selection.appTargetName}${sourceOf(
        selection.appTargetSource === 'only one'
          ? undefined
          : selection.appTargetSource,
        '--ios-target'
      )}`,
    ]);
  }
  if (selection.variant) facts.push(['variant', selection.variant.variantName]);
  if (selection.targetSelector) {
    // Named the way the workspace is: a udid alone is not something a person recognises.
    const device = selection.targetName
      ? `${selection.targetName} (${
          selection.targetId ?? selection.targetSelector
        })`
      : selection.targetSelector;
    facts.push([
      'device',
      `${device}${sourceOf(selection.targetSource, '--device')}`,
    ]);
  }
  if (workspace) {
    facts.push([
      'workspace',
      `${workspace.name ?? workspace.id} (${workspace.id})${sourceOf(
        WORKSPACE_SOURCE[selection.resolution.how],
        '--workspace'
      )}`,
    ]);
  }
  if (options.depth) {
    facts.push([
      'depth',
      `${options.depth}${sourceOf(options.depthSource, '--depth')}`,
    ]);
  }
  if (selection.states) {
    const count = `${selection.states.length} push${
      selection.states.length === 1 ? '' : 'es'
    } · ${selection.states.join(', ')}`;
    const taps =
      options.taps && options.taps.length > 0
        ? ` · tap ${options.taps.join(', ')}`
        : '';
    facts.push(
      options.dryRun
        ? ['dry run', `${count}${taps} · nothing will be sent`]
        : ['sending', `${count}${taps}`]
    );
  }
  return facts;
}

export { MissingInput };
