import chalk from 'chalk';
import { Asker } from './prompt';
import { Reporter, factLines } from './report/render';
import { Consent } from './report/types';

/**
 * The go-ahead before a run sends or writes something real.
 *
 * Naming where it goes is the go-ahead. A command line that names every destination — the
 * level that sends, the workspace, the device — has said what it wants, so the run goes
 * without a question, the way naming the branch counts as confirming it in Supabase's CLI.
 * A run that picked any of them itself asks, showing where everything goes; one that cannot
 * ask stops before it touches anything and names what to add. A flag that only says "yes"
 * cannot carry this: it agrees to whatever the run happened to pick.
 */
export interface Destination {
  /** The flag that names it, for the refusal. */
  flag: string;
  /** Given on this command line, rather than picked by the run or by a question. */
  named: boolean;
}

/**
 * Decided before the run touches anything — no `cio` call, no device read — so a CI job that
 * left a destination to chance fails in milliseconds with the flag to add. `undefined` means
 * go on.
 */
export function refusalUnattended(options: {
  /** Whether this run would send or write anything real. */
  sends: boolean;
  interactive: boolean;
  destinations: Destination[];
  /** What would be sent, for the message: "real pushes". */
  what: string;
}): { message: string; flags: string[] } | undefined {
  if (!options.sends || options.interactive) return undefined;
  const missing = options.destinations
    .filter((destination) => !destination.named)
    .map((destination) => destination.flag);
  if (missing.length === 0) return undefined;
  return {
    message: `this run sends ${
      options.what
    } and nobody can be asked, so where they go has to be named — pass ${missing.join(
      ' and '
    )}`,
    flags: missing,
  };
}

/**
 * Go, or ask, and say which in the report. The facts are printed either way: the log of an
 * unattended run is the only record of where it sent.
 */
export async function goAhead(input: {
  /** Every destination was named on the command line. */
  named: boolean;
  /** "real pushes" */
  what: string;
  facts: [string, string][];
  question: string;
  /** The two answers, as the picker shows them. */
  answers?: { yes: string; no: string };
  writes: string[];
  asker: Asker;
  reporter: Reporter;
}): Promise<Consent> {
  if (input.named) {
    input.reporter.block(`Sending ${input.what}`, [
      ...input.facts,
      ['go-ahead', 'named on the command line'],
    ]);
    return { granted: true, by: 'named', writes: input.writes };
  }

  const context = [
    chalk.bold(`Ready to send ${input.what}`),
    ...factLines(input.facts),
    '',
  ].join('\n');
  input.reporter.pause();
  const granted = await input.asker.agree(
    input.question,
    context,
    input.answers
  );
  input.reporter.resume();
  return { granted, by: 'prompt', writes: input.writes };
}
