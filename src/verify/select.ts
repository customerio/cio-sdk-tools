import {
  AndroidProjectModel,
  BuildVariant,
  buildVariants,
} from './android/project';
import {
  AndroidTarget,
  describeAndroidTarget,
  listAndroidTargets,
} from './android/device';
import { CioContext } from './cio/cli';
import { WorkspaceResolution, resolveWorkspace } from './cio/workspace';
import { describeTarget, isUsable, listTargets } from './ios/device';
import { ALL_STATES, AppState } from './matrix/states';
import { Asker, MissingInput } from './prompt';
import { XcodeProjectModel, appTargets } from './ios/xcode';

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

  const apps = appTargets(input.model);
  const appTargetName = input.appTarget
    ? input.appTarget
    : apps.length === 0
    ? undefined
    : apps.length === 1
    ? apps[0].name
    : await input.asker.select(
        'Which app target should be verified?',
        apps.map((target) => ({
          value: target.name,
          label: target.name,
          hint: target.settings.PRODUCT_BUNDLE_IDENTIFIER,
        })),
        { flag: '--app-target <name>' }
      );

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
  const moduleDirectory = input.model?.appModulePath;
  const variants = moduleDirectory ? await buildVariants(moduleDirectory) : [];

  // An explicit --package wins; otherwise the built variants are the candidates, because
  // they are the only place the real application id exists.
  let variant: BuildVariant | undefined;
  let packageName = input.packageName;
  if (!packageName && variants.length === 1) variant = variants[0];
  else if (!packageName && variants.length > 1) {
    variant = await input.asker.select(
      'Which build variant is installed on the target?',
      variants.map((candidate) => ({
        value: candidate,
        label: `${candidate.variantName}`,
        hint: candidate.applicationId,
      })),
      { flag: '--package <applicationId>' }
    );
  }
  packageName = packageName ?? variant?.applicationId;

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

async function chooseWorkspace(
  input: SelectInput
): Promise<WorkspaceResolution> {
  if (!input.cio.authenticated) {
    return {
      how: 'unresolved',
      candidates: [],
      unresolvedReason: input.cio.reason ?? 'the cio CLI is unavailable',
    };
  }
  return resolveWorkspace({
    accountId: input.cio.accountId,
    explicit: input.workspace,
    asker: input.asker,
  });
}

/**
 * The target is asked for even when there is only one.
 *
 * Every other question is disambiguation; this one is consent. A phone plugged into this
 * machine is not necessarily a test phone, and the run launches, kills and sends pushes to
 * whatever it picks.
 */
async function chooseIosTarget(
  input: SelectInput
): Promise<{ selector?: string; name?: string }> {
  if (input.target) return { selector: input.target };
  const usable = (await listTargets()).filter(isUsable);
  if (usable.length === 0) return {};
  const picked = await input.asker.select(
    'Which target should be verified?',
    usable.map((target) => ({
      value: target,
      label: describeTarget(target),
      hint: target.udid,
    })),
    { flag: '--target <name|udid>' }
  );
  return { selector: picked.udid, name: picked.name };
}

async function chooseAndroidTarget(
  input: SelectInput
): Promise<{ selector?: string; name?: string }> {
  if (input.target) return { selector: input.target };
  const targets = await listAndroidTargets();
  if (targets.length === 0) return {};
  const picked = await input.asker.select(
    'Which target should be verified?',
    targets.map((target: AndroidTarget) => ({
      value: target,
      label: describeAndroidTarget(target),
      hint: target.serial,
    })),
    { flag: '--target <serial>' }
  );
  return { selector: picked.serial, name: picked.model };
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
