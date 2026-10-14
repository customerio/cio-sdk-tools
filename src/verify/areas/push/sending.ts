import { Reporter } from '../../core/report/render';
import { Asker } from '../../core/prompt';
import { TapPlan, openedSkipReason } from './on_device/opened';
import { ALL_STATES, AppState } from '../../platform/app_state';
import { consentToSend, openedStatesToSend } from './consent';
import { Consent } from '../../core/report/types';
import { MatrixSection, PushLadder } from './types';
import { VerifyPushOptions, parseStates } from './options';

/**
 * Which states get a tap, on the push each already gets for the delivered check. `--opened`
 * asks for it; a dry run, a run nobody can answer, or a missing `--link` makes the opened
 * section a skip with the reason instead.
 */
export function tapPlanFor(
  options: VerifyPushOptions,
  asker: Asker,
  delivered: AppState[]
): { tap?: TapPlan; skipped?: string } {
  if (!options.opened) return {};
  const skipped = openedSkipReason({
    dryRun: Boolean(options.dryRun),
    interactive: asker.interactive,
    link: options.link ?? '',
  });
  if (skipped) return { skipped };
  const states = openedStatesToSend({
    opened: options.opened,
    link: options.link,
    interactive: asker.interactive,
    states: parseStates(options.states),
    delivered,
  });
  if (states.length === 0 || !options.link) {
    return {
      skipped:
        'none of the states being sent has a banner to tap — add killed or background',
    };
  }
  return { tap: { asker, link: options.link, states } };
}

export function addOpened(
  ladder: PushLadder,
  options: VerifyPushOptions,
  opened: MatrixSection | undefined,
  skipped: string | undefined
): void {
  if (!options.opened) return;
  ladder.addMatrix(
    opened ?? {
      metric: 'opened',
      cells: [],
      skipped: skipped ?? 'no tap test ran',
    }
  );
}

/** Records every section that would have sent as skipped, because the log is unreadable. */
export function skipUnreadable(
  ladder: PushLadder,
  options: VerifyPushOptions,
  reason: string
): void {
  const skipped = `no push was sent: the device's log cannot be read (${reason})`;
  ladder.addMatrix({ metric: 'delivered', cells: [], skipped });
  if (options.opened)
    ladder.addMatrix({ metric: 'opened', cells: [], skipped });
}

/**
 * The one question before the first real push, asked after preflight because the token it
 * names only exists once the device has been read. Returns nothing when there is nothing
 * real to send — no `--send`, a dry run, or an input missing, in which case the matrices
 * skip themselves with the reason — and a consent whose `granted` gates the matrices
 * otherwise.
 */
export async function askToSend(
  ladder: PushLadder,
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
        delivered: inputs.delivered ?? ALL_STATES,
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
