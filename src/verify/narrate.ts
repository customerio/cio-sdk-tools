/**
 * Progress narration for the parts of a run that are slow and silent.
 *
 * Borrowed from `stack`'s Narrator, with two deliberate changes. It writes to **stderr**
 * rather than stdout, because our stdout carries the report even in human mode; and it is
 * on in human mode rather than only under `--quiet`, because this tool prints nothing at
 * all until the ladder renders — a cell can wait 45 seconds for a push, and a developer
 * watching a dead terminal cannot tell that from a hang.
 *
 * Kept from the original, because both were learned the hard way there: a heartbeat so the
 * silence is visibly alive, and a multiline mode for log viewers that only flush on a
 * newline (GitHub Actions renders same-line dots as nothing at all).
 *
 * Never emitted with `--json`. Narration is for people; mixing it into a machine stream is
 * how a parser ends up with prose in it.
 */
import chalk from 'chalk';
import { formatMs, stopwatch } from './clock';

export interface Step {
  /** Closes the line. `note` replaces the default "done". Returns the elapsed ms. */
  done(note?: string): number;
}

export interface Narrator {
  step(message: string): Step;
  /** A one-off line with no completion, for facts worth seeing as they are learned. */
  say(message: string): void;
}

const HEARTBEAT_MS = 5_000;

export function createNarrator(options: {
  json: boolean;
  quiet?: boolean;
  intervalMs?: number;
  out?: { write(chunk: string): unknown; isTTY?: boolean };
}): Narrator {
  const out = options.out ?? process.stderr;
  const enabled = !options.json && !options.quiet;
  if (!enabled) return silent();

  const interval = options.intervalMs ?? HEARTBEAT_MS;
  // Same-line dots need a terminal that redraws; anything else gets discrete lines.
  const multiline = !out.isTTY;

  return {
    step(message: string): Step {
      const elapsed = stopwatch();
      out.write(multiline ? `${message}...\n` : `  ${message}...`);
      const timer = setInterval(() => {
        // The heartbeat carries the elapsed time too, so a long wait is legible while it
        // is still happening rather than only in hindsight.
        out.write(
          multiline
            ? `${message}... still waiting (${formatMs(elapsed())})\n`
            : '.'
        );
      }, interval);
      timer.unref?.();

      let closed = false;
      let took = 0;
      return {
        done(note?: string) {
          if (closed) return took;
          closed = true;
          took = elapsed();
          clearInterval(timer);
          const tail = `${note ?? 'done'} ${chalk.dim(`(${formatMs(took)})`)}`;
          out.write(multiline ? `${message}... ${tail}\n` : `${tail}\n`);
          return took;
        },
      };
    },
    say(message: string) {
      out.write(`  ${message}\n`);
    },
  };
}

function silent(): Narrator {
  return {
    // Still timed, so a caller can use the step's own number under `--json`.
    step: () => {
      const elapsed = stopwatch();
      return { done: () => elapsed() };
    },
    say: () => undefined,
  };
}
