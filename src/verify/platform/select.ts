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
import { Asker } from '../core/prompt';
import { XcodeProjectModel, appTargets } from './ios/xcode';

/**
 * The questions any area asks before it touches anything: which workspace, which app, which
 * device. Each one is the person's intent rather than something read out of the project or
 * off whatever happens to be plugged in, and each names the flag that answers it, so a
 * session answered by hand can be turned into a CI job by copying it.
 */
export interface PickInput {
  cio: CioContext;
  asker: Asker;
  /** The answers given as flags; each skips its question. */
  workspace?: string;
  target?: string;
}

export async function chooseWorkspace(
  input: PickInput
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

/** Which iOS app target, when the project builds several. */
export async function chooseIosApp(input: {
  asker: Asker;
  model: XcodeProjectModel;
  appTarget?: string;
}): Promise<string | undefined> {
  const apps = appTargets(input.model);
  return input.appTarget
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
}

/**
 * Which Android variant is installed. An explicit application id wins; otherwise the built
 * variants are the candidates, because they are the only place the real application id
 * exists.
 */
export async function chooseAndroidVariant(input: {
  asker: Asker;
  model?: AndroidProjectModel;
  packageName?: string;
}): Promise<{ variant?: BuildVariant; packageName?: string }> {
  const moduleDirectory = input.model?.appModulePath;
  const variants = moduleDirectory ? await buildVariants(moduleDirectory) : [];

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

  return { variant, packageName };
}

/**
 * The target is asked for even when there is only one.
 *
 * Every other question is disambiguation; this one is consent. A phone plugged into this
 * machine is not necessarily a test phone, and the run launches, kills and sends pushes to
 * whatever it picks.
 */
export async function chooseIosTarget(
  input: PickInput
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

export async function chooseAndroidTarget(
  input: PickInput
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
