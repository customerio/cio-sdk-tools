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
  chooseAndroidTarget,
  chooseAndroidVariant,
  chooseIosApp,
  chooseIosTarget,
  chooseWorkspace,
} from '../../platform/select';

/**
 * What the run is about, settled before it touches anything.
 *
 * Four answers — workspace, app, target, how many pushes — and every one of them is the
 * person's intent rather than something read out of the project or off whatever happens
 * to be plugged in. Everything after this is a comparison of that intent against reality,
 * which is what makes "the workspace you chose does not contain this device" expressible
 * at all.
 */
export interface Selection {
  resolution: WorkspaceResolution;
  /** iOS: the app target's name. */
  appTargetName?: string;
  /** Android: the Gradle module, and the id the chosen variant actually produces. */
  appModuleName?: string;
  packageName?: string;
  variant?: BuildVariant;
  targetSelector?: string;
  /** Set when the target was picked from the list, so the facts can name it. */
  targetName?: string;
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

  const appTargetName = await chooseIosApp(input);

  const target = await chooseIosTarget(input);
  return {
    resolution,
    appTargetName,
    targetSelector: target.selector,
    targetName: target.name,
    states: await chooseStates(input),
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
  const { variant, packageName } = await chooseAndroidVariant(input);

  const target = await chooseAndroidTarget(input);
  return {
    resolution,
    appModuleName: input.appModule ?? input.model?.appModuleName,
    packageName,
    variant,
    targetSelector: target.selector,
    targetName: target.name,
    states: await chooseStates(input),
  };
}

/** Only asked when something is actually going to be sent. */
async function chooseStates(
  input: SelectInput
): Promise<AppState[] | undefined> {
  if (!input.send) return input.states;
  if (input.states) return input.states;
  // The one question with an obvious answer, so a non-interactive run takes it rather
  // than refusing: all three states, because a state-dependent failure is a real bug and
  // the whole point of the matrix is to catch it.
  if (!input.asker.interactive) return [...ALL_STATES];
  return input.asker.select(
    'How much should be sent?',
    [
      {
        value: [...ALL_STATES],
        label: 'All three app states',
        hint: '3 pushes · a state-dependent failure is a real bug',
      },
      { value: ['killed' as AppState], label: 'Killed only', hint: '1 push' },
    ],
    { flag: '--states <list>' }
  );
}

/**
 * What was settled, stated before anything runs.
 *
 * Printed as a block rather than a sentence because it is the record of consent: these are
 * the workspace the pushes will land in and the device they will be sent to.
 */
export function selectionFacts(
  selection: Selection,
  options: { dryRun?: boolean } = {}
): [string, string][] {
  const workspace = selection.resolution.workspace;
  const facts: [string, string][] = [];
  const app = selection.packageName ?? selection.appTargetName;
  if (app) facts.push(['app', app]);
  if (selection.variant) facts.push(['variant', selection.variant.variantName]);
  if (selection.targetSelector) {
    // Named the way the workspace is: a udid alone is not something a person recognises.
    facts.push([
      'target',
      selection.targetName
        ? `${selection.targetName} (${selection.targetSelector})`
        : selection.targetSelector,
    ]);
  }
  if (workspace) {
    facts.push([
      'workspace',
      `${workspace.name ?? workspace.id} (${workspace.id})`,
    ]);
  }
  if (selection.states) {
    const count = `${selection.states.length} push${
      selection.states.length === 1 ? '' : 'es'
    } · ${selection.states.join(', ')}`;
    facts.push(
      options.dryRun
        ? ['dry run', `${count} · nothing will be sent`]
        : ['sending', count]
    );
  }
  return facts;
}

export { MissingInput };
