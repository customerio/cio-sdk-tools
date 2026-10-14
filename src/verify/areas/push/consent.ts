import { OPENED_STATES } from './on_device/opened';
import { AppState } from '../../platform/app_state';
import { goAhead } from '../../core/consent';
import { Asker } from '../../core/prompt';
import { Reporter } from '../../core/report/render';
import { Consent } from '../../core/report/types';
import { PushLadder } from './types';

/**
 * The go-ahead before a real push leaves.
 *
 * Every other question this tool asks is about intent; this one is about consequence. The
 * pushes land on a real device through a real workspace, so the facts say where they go,
 * how many there are and which token they are addressed to. Once per run, stating the
 * count, covers every push without asking three to five times — and a command line that
 * named the depth, the workspace and the device has already said all of it.
 */
export interface SendPlan {
  /** As the device picker shows it, followed by the udid or serial. */
  target: string;
  /** Bundle id or application id. */
  app: string;
  /** `name (id)`. */
  workspace: string;
  /** The `cio` credential profile the sends go out under. */
  login?: string;
  token: string;
  delivered: AppState[];
  /** The states whose push will also be tapped. Empty unless the tap test runs. */
  opened: AppState[];
  /** True when a delivered cell sends once more if nothing arrives. */
  retries: boolean;
}

/**
 * The states whose push will also be tapped: the ones sent while the app was killed or in
 * the background, where the tap has to bring the app up. None when opens are not checked,
 * and none when nobody can tap, because the tap test skips itself then. The deep link is
 * optional: without one the open is still checked.
 */
export function openedStatesToSend(options: {
  opened: boolean;
  interactive: boolean;
  /** The states that get a push: a tap is only ever on one of those pushes. */
  delivered?: AppState[];
}): AppState[] {
  if (!options.opened || !options.interactive) return [];
  return options.delivered
    ? OPENED_STATES.filter((state) => options.delivered?.includes(state))
    : OPENED_STATES;
}

/**
 * First sends only: a re-send happens only when the first push never arrived. Taps add
 * none — each one is on a push that is already counted.
 */
export function pushCount(plan: SendPlan): number {
  return plan.delivered.length;
}

/** Enough of a token to tell two apart, never the whole address. */
export function shortToken(token: string): string {
  return `${token.slice(0, 12)}…`;
}

export function consentFacts(plan: SendPlan): [string, string][] {
  const facts: [string, string][] = [
    ['device', plan.target],
    ['app', plan.app],
    ['workspace', plan.workspace],
  ];
  if (plan.login) facts.push(['cio login', plan.login]);
  facts.push(['token', shortToken(plan.token)]);
  facts.push([
    'delivered',
    `${plan.delivered.length} · ${plan.delivered.join(', ')}`,
  ]);
  if (plan.opened.length > 0) {
    facts.push([
      'taps',
      `${plan.opened.length} · ${plan.opened.join(
        ', '
      )} · on the same pushes, one tap each`,
    ]);
  }
  if (plan.retries) {
    facts.push([
      'retries',
      'up to 1 more per delivered state if nothing arrives (--no-retry turns this off)',
    ]);
  }
  return facts;
}

export function consentQuestion(plan: SendPlan): string {
  const count = pushCount(plan);
  return `Send ${count} real push${count === 1 ? '' : 'es'}?`;
}

/** The two answers, saying what each one does. */
export function consentAnswers(plan: SendPlan): { yes: string; no: string } {
  const count = pushCount(plan);
  return {
    yes: `Yes, send ${count} push${count === 1 ? '' : 'es'}`,
    no: 'No, send nothing',
  };
}

/** What the go-ahead covered, for the report. */
export function consentWrites(plan: SendPlan): string[] {
  const count = pushCount(plan);
  return [
    `${count} real push${count === 1 ? '' : 'es'} to ${plan.target} through ${
      plan.workspace
    }`,
  ];
}

/**
 * Go when the command line named where the pushes go, ask otherwise, and say which in the
 * report. A no records every section that would have sent as skipped, so the summary says
 * why nothing was proven.
 */
export async function consentToSend(input: {
  plan: SendPlan;
  /** The command line named the depth, the workspace and the device. */
  named: boolean;
  /** Whether opens were to be checked, so a no skips that section too. */
  opened: boolean;
  asker: Asker;
  reporter: Reporter;
  ladder: PushLadder;
}): Promise<Consent> {
  const consent = await goAhead({
    named: input.named,
    what: 'real pushes',
    facts: consentFacts(input.plan),
    question: consentQuestion(input.plan),
    answers: consentAnswers(input.plan),
    writes: consentWrites(input.plan),
    asker: input.asker,
    reporter: input.reporter,
  });

  if (!consent.granted) {
    const skipped = input.asker.interactive
      ? 'the send was not confirmed, so nothing was sent'
      : 'nobody could confirm the send — name the device with --device and the workspace with --workspace';
    input.ladder.addMatrix({ metric: 'delivered', cells: [], skipped });
    if (input.opened) {
      input.ladder.addMatrix({ metric: 'opened', cells: [], skipped });
    }
  }
  return consent;
}
