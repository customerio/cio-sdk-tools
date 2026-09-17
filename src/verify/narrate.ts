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
export interface Step {
  /** Closes the line. `note` replaces the default "done". */
  done(note?: string): void;
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
      out.write(multiline ? `${message}...\n` : `  ${message}...`);
      const timer = setInterval(() => {
        out.write(multiline ? `${message}... still waiting\n` : '.');
      }, interval);
      timer.unref?.();

      let closed = false;
      return {
        done(note?: string) {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          out.write(
            multiline
              ? `${message}... ${note ?? 'done'}\n`
              : `${note ?? 'done'}\n`
          );
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
    step: () => ({ done: () => undefined }),
    say: () => undefined,
  };
}
