import chalk from 'chalk';
import { Ladder } from './ladder';
import { OPENED_STATES } from './matrix/opened';
import { AppState } from './matrix/states';
import { Asker } from './prompt';
import { Reporter, factLines } from './report';
import { Consent } from './types';

/**
 * The question before a real push leaves.
 *
 * Every other question this tool asks is about intent; this one is about consequence. The
 * pushes land on a real device through a real workspace, so the person sees where they go,
 * how many there are and which token they are addressed to, and says yes before any of
 * them is sent. Once per run, stating the count, covers every push without asking three to
 * five times.
 *
 * A run that cannot ask does not get to assume. It needs `--yes`, and without it is
 * refused before it touches anything.
 */
export interface SendPlan {
  /** As the target picker shows it, followed by the udid or serial. */
  target: string;
  /** Bundle id or application id. */
  app: string;
  /** `name (id)`. */
  workspace: string;
  /** The `cio` credential profile the sends go out under. */
  login?: string;
  token: string;
  delivered: AppState[];
  /** Empty unless the opened matrix is going to run. */
  opened: AppState[];
  /** True when a delivered cell sends once more if nothing arrives. */
  retries: boolean;
}

/**
 * The tap-test states that will actually be sent. None without `--opened` or a `--link`,
 * and none when nobody can tap, because the opened matrices skip themselves then — a
 * count that included them would promise pushes the run never sends.
 */
export function openedStatesToSend(options: {
  opened: boolean;
  link?: string;
  interactive: boolean;
  states?: AppState[];
}): AppState[] {
  if (!options.opened || !options.link || !options.interactive) return [];
  return options.states ?? OPENED_STATES;
}

/** First sends only: a re-send happens only when the first push never arrived. */
export function pushCount(plan: SendPlan): number {
  return plan.delivered.length + plan.opened.length;
}

/** Enough of a token to tell two apart, never the whole address. */
export function shortToken(token: string): string {
  return `${token.slice(0, 12)}…`;
}

export function consentFacts(plan: SendPlan): [string, string][] {
  const facts: [string, string][] = [
    ['target', plan.target],
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
      'opened',
      `${plan.opened.length} · ${plan.opened.join(', ')} · one tap each`,
    ]);
  }
  if (plan.retries) {
    facts.push([
      'retries',
      'up to 1 more per delivered state if nothing arrives (--no-resend turns this off)',
    ]);
  }
  return facts;
}

export function consentQuestion(plan: SendPlan): string {
  const count = pushCount(plan);
  return `Send ${count} real push${count === 1 ? '' : 'es'}?`;
}

/**
 * Decided before the run touches anything — no `cio` call, no device read — so a CI job
 * that forgot `--yes` fails in milliseconds with the flag to add. `undefined` means go on.
 */
export function refusalWithoutConsent(options: {
  send: boolean;
  opened: boolean;
  dryRun: boolean;
  yes: boolean;
  interactive: boolean;
}): string | undefined {
  if (!options.send || options.dryRun || options.yes || options.interactive) {
    return undefined;
  }
  const flag = options.opened ? '--opened' : '--send';
  return `${flag} sends real pushes and nobody can be asked — pass --yes`;
}

/**
 * Ask, or take `--yes` as the answer, and say which in the report. A no records every
 * section that would have sent as skipped, so the summary says why nothing was proven.
 */
export async function consentToSend(input: {
  plan: SendPlan;
  yes: boolean;
  /** Whether `--opened` was asked for, so a no skips that section too. */
  opened: boolean;
  asker: Asker;
  reporter: Reporter;
  ladder: Ladder;
}): Promise<Consent> {
  const facts = consentFacts(input.plan);
  const pushes = pushCount(input.plan);

  if (input.yes) {
    // Printed anyway: the log of an unattended run is the only record of where it sent.
    input.reporter.block('Sending real pushes', [
      ...facts,
      ['consent', '--yes'],
    ]);
    return { granted: true, by: '--yes', pushes };
  }

  const context = [
    chalk.bold('Ready to send real pushes'),
    ...factLines(facts),
    '',
  ].join('\n');
  input.reporter.pause();
  const granted = await input.asker.agree(consentQuestion(input.plan), context);
  input.reporter.resume();

  if (!granted) {
    const skipped = input.asker.interactive
      ? 'the send was not confirmed, so nothing was sent'
      : 'nobody could confirm the send — pass --yes';
    input.ladder.addMatrix({ metric: 'delivered', cells: [], skipped });
    if (input.opened) {
      input.ladder.addMatrix({ metric: 'opened', cells: [], skipped });
    }
  }
  return { granted, by: 'prompt', pushes };
}
