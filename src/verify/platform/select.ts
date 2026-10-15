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
import {
  describeTarget,
  isUsable,
  listTargets,
  selectTarget,
} from './ios/device';
import { Asker, MissingInput } from '../core/prompt';
import { XcodeProjectModel, appTargets } from './ios/xcode';

/**
 * The questions any area asks before it touches anything: which workspace, which app, which
 * device. Each one is the person's intent rather than something read out of the project or
 * off whatever happens to be plugged in, and each names the flag that answers it, so a
 * session answered by hand can be turned into a CI job by copying it.
 */

/** Where an answer came from, for the facts: `--device`, `picked` or `only one`. */
export type AnswerSource = 'flag' | 'picked' | 'only one';

export interface Picked {
  /** What the rest of the run matches the device by: as typed, or the picked one's id. */
  selector?: string;
  /** The device's name, so the facts can say which one it is. */
  name?: string;
  /** Its udid or serial, beside the name. */
  id?: string;
  source?: AnswerSource;
}

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
}): Promise<{ name?: string; source?: AnswerSource }> {
  if (input.appTarget) return { name: input.appTarget, source: 'flag' };
  const apps = appTargets(input.model);
  if (apps.length === 0) return {};
  if (apps.length === 1) return { name: apps[0].name, source: 'only one' };
  const name = await input.asker.select(
    'Which app target should be verified?',
    apps.map((target) => ({
      value: target.name,
      label: target.name,
      hint: target.settings.PRODUCT_BUNDLE_IDENTIFIER,
    })),
    { flag: '--ios-target <name>' }
  );
  return { name, source: 'picked' };
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
}): Promise<{
  variant?: BuildVariant;
  packageName?: string;
  source?: AnswerSource;
}> {
  const moduleDirectory = input.model?.appModulePath;
  const variants = moduleDirectory ? await buildVariants(moduleDirectory) : [];

  if (input.packageName) {
    return { packageName: input.packageName, source: 'flag' };
  }
  let variant: BuildVariant | undefined;
  let source: AnswerSource | undefined;
  if (variants.length === 1) {
    variant = variants[0];
    source = 'only one';
  } else if (variants.length > 1) {
    source = 'picked';
    variant = await input.asker.select(
      'Which build variant is installed on the target?',
      variants.map((candidate) => ({
        value: candidate,
        label: `${candidate.variantName}`,
        hint: candidate.applicationId,
      })),
      { flag: '--android-app-id <id>' }
    );
  }
  return { variant, packageName: variant?.applicationId, source };
}

/**
 * The device, taken without a question when only one is connected.
 *
 * Picking it is not consent: anything that sends to it or drives the app on it asks first
 * — or, when nobody can be asked, refuses — unless the command line named it, because a
 * phone plugged into this machine is not necessarily a test phone.
 */
export async function chooseIosTarget(input: PickInput): Promise<Picked> {
  const targets = await listTargets();
  if (input.target) {
    // Named the way the run will match it, so the facts say which device that is.
    const { target: named, ambiguous } = selectTarget(targets, input.target);
    if (ambiguous.length > 1) {
      throw new MissingInput(
        `--device ${input.target} names ${ambiguous.length} running simulators or devices — pass one's UDID`,
        '--device <name|udid>',
        ambiguous.map((target) => `${target.udid}  ${describeTarget(target)}`)
      );
    }
    return {
      selector: input.target,
      name: named?.name,
      id: named?.udid,
      source: 'flag',
    };
  }
  const usable = targets.filter(isUsable);
  if (usable.length === 0) return {};
  if (usable.length === 1) {
    return {
      selector: usable[0].udid,
      name: usable[0].name,
      id: usable[0].udid,
      source: 'only one',
    };
  }
  const picked = await input.asker.select(
    'Which device?',
    usable.map((target) => ({
      value: target,
      label: describeTarget(target),
      hint: target.udid,
    })),
    { flag: '--device <name|udid>' }
  );
  return {
    selector: picked.udid,
    name: picked.name,
    id: picked.udid,
    source: 'picked',
  };
}

export async function chooseAndroidTarget(input: PickInput): Promise<Picked> {
  const targets = await listAndroidTargets();
  if (input.target) {
    const named = targets.find((target) => target.serial === input.target);
    return {
      selector: input.target,
      name: named?.model,
      id: named?.serial,
      source: 'flag',
    };
  }
  if (targets.length === 0) return {};
  if (targets.length === 1) {
    return {
      selector: targets[0].serial,
      name: targets[0].model,
      id: targets[0].serial,
      source: 'only one',
    };
  }
  const picked = await input.asker.select(
    'Which device?',
    targets.map((target: AndroidTarget) => ({
      value: target,
      label: describeAndroidTarget(target),
      hint: target.serial,
    })),
    { flag: '--device <serial>' }
  );
  return {
    selector: picked.serial,
    name: picked.model,
    id: picked.serial,
    source: 'picked',
  };
}
