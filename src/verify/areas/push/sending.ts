import { Reporter } from '../../core/report/render';
import { skipSending } from './climb';
import { readBack } from './record';
import { Asker } from '../../core/prompt';
import { TapPlan, openedSkipReason } from './on_device/opened';
import { ALL_STATES, AppState } from '../../platform/app_state';
import { consentToSend, openedStatesToSend } from './consent';
import { Consent } from '../../core/report/types';
import { MatrixSection, PushLadder } from './types';
import { VerifyPushOptions } from './options';

/**
 * Which states get a tap, on the push each already gets for the delivered check.
 * `--check-opens` asks for it; a dry run or a run nobody can answer makes the opened section
 * a skip with the reason instead. Without `--deep-link` the open is still checked.
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
  });
  if (skipped) return { skipped };
  const states = openedStatesToSend({
    opened: options.opened,
    interactive: asker.interactive,
    delivered,
  });
  if (states.length === 0) {
    return {
      skipped:
        'none of the states being sent has a banner to tap — add killed or background',
    };
  }
  return { tap: { asker, link: options.link, states } };
}

/**
 * The sections a sending run produced, with Customer.io's record read into them once the
 * last push is done: an open the log could not prove is settled by it, and at end-to-end
 * the record of every push is judged in a section of its own.
 */
export async function addSent(
  ladder: PushLadder,
  options: VerifyPushOptions,
  sent: { delivered: MatrixSection; opened?: MatrixSection },
  inputs: { environmentId: string; reporter: Reporter; tapSkipped?: string }
): Promise<void> {
  const read = await readBack({
    environmentId: inputs.environmentId,
    judge: options.recorded,
    delivered: sent.delivered,
    opened: sent.opened,
    linkSent: Boolean(options.link),
    reporter: inputs.reporter,
  });
  ladder.addMatrix(read.delivered);
  addOpened(ladder, options, read.opened, inputs.tapSkipped);
  if (read.recorded) ladder.addMatrix(read.recorded);
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
  skipSending(
    ladder,
    options,
    `no push was sent: the device's log cannot be read (${reason})`
  );
}

/**
 * The go-ahead before the first real push, settled after registration because the token it
 * names only exists once the device has been read. Returns nothing when there is nothing
 * real to send — a level that sends nothing, a dry run, or an input missing, in which case
 * the sections skip themselves with the reason — and a consent whose `granted` gates the
 * sections otherwise.
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
        interactive: asker.interactive,
        delivered: inputs.delivered ?? ALL_STATES,
      }),
      retries: inputs.retries,
    },
    named: options.named,
    opened: options.opened,
    recorded: options.recorded,
    asker,
    reporter,
    ladder,
  });
}
