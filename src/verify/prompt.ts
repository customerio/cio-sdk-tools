import chalk from 'chalk';

/**
 * The four questions this command has no business answering on its own.
 *
 * Which workspace, which app, which target, how many pushes. Every one of them was
 * inferred at some point, and inference is what made the tool confidently wrong: the
 * workspace was read from a siteId that only exists when in-app messaging is configured,
 * the app id was parsed out of a build script that does not know which variant is
 * installed, and the target was whatever was plugged in.
 *
 * So intent is asked for, and everything afterwards is a check of that intent against
 * reality. A picked workspace that does not contain the device is the finding — the most
 * useful one this tool can produce.
 *
 * Nothing here ever runs unattended: a run that cannot ask exits with the flag to pass.
 */
export interface Choice<T> {
  value: T;
  label: string;
  /** Shown dim after the label: an id, a bundle id, a serial. */
  hint?: string;
}

export interface Asker {
  readonly interactive: boolean;
  /**
   * Wait for a person to do something and say they did. Returns false when nobody
   * answered — a tap nobody confirmed must never read as a tap that happened.
   */
  confirm(
    instruction: string,
    options?: { timeoutMs?: number }
  ): Promise<boolean>;
  /**
   * A yes/no question whose answer defaults to no. Only an explicit yes counts: Enter,
   * silence, a closed stdin and a run that cannot ask all read as no, because this is the
   * question asked before something that cannot be taken back.
   */
  agree(question: string, context?: string): Promise<boolean>;
  /**
   * `flag` is the non-interactive escape hatch, named in the error and in the hint, so a
   * session that had to be answered by hand can be turned into a CI job by copying it.
   */
  select<T>(
    question: string,
    choices: Choice<T>[],
    options: { flag: string; defaultIndex?: number }
  ): Promise<T>;
}

/**
 * Thrown when the answer cannot be obtained — no terminal, --json, nobody home — or when a
 * flag gave one that is not among the choices. Either way the run ends naming the flag.
 */
export class MissingInput extends Error {
  constructor(
    message: string,
    readonly flag: string,
    readonly candidates: string[] = []
  ) {
    super(message);
    this.name = 'MissingInput';
  }
}

/** A minute is long enough for a person and short enough for a stuck pipeline. */
const ANSWER_TIMEOUT_MS = 60_000;
const ATTEMPTS = 3;

export function createAsker(options: {
  interactive: boolean;
  input?: NodeJS.ReadableStream;
  output?: { write(chunk: string): unknown };
  timeoutMs?: number;
}): Asker {
  const interactive = options.interactive;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  const timeoutMs = options.timeoutMs ?? ANSWER_TIMEOUT_MS;
  // One reader for the run: answers can arrive several to a chunk, and a fresh reader per
  // question would drop whatever came after the newline it consumed.
  const reader = interactive ? createLineReader(input) : undefined;

  return {
    interactive,

    async confirm(
      instruction: string,
      confirmOptions: { timeoutMs?: number } = {}
    ): Promise<boolean> {
      if (!interactive) return false;
      output.write(`\n${chalk.bold(instruction)}\n`);
      output.write(chalk.dim('  press Enter when done, or ctrl-c to stop '));
      const answer = await reader?.next(confirmOptions.timeoutMs ?? timeoutMs);
      output.write('\n');
      return answer !== undefined;
    },

    async agree(question: string, context?: string): Promise<boolean> {
      if (!interactive) return false;
      if (context) output.write(`\n${context}`);
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        output.write(`${chalk.bold(question)} ${chalk.dim('(y/N)')} `);
        const answer = await reader?.next(timeoutMs);
        if (answer === undefined) {
          output.write('\n');
          return false;
        }
        const trimmed = answer.trim().toLowerCase();
        if (trimmed === 'y' || trimmed === 'yes') return true;
        if (trimmed === '' || trimmed === 'n' || trimmed === 'no') return false;
        output.write(chalk.yellow('  answer y or n\n'));
      }
      return false;
    },

    async select<T>(
      question: string,
      choices: Choice<T>[],
      selectOptions: { flag: string; defaultIndex?: number }
    ): Promise<T> {
      if (choices.length === 0) {
        throw new MissingInput(
          `nothing to choose from for ${question}`,
          selectOptions.flag
        );
      }
      if (!interactive) {
        throw new MissingInput(
          `${question} — pass ${selectOptions.flag}`,
          selectOptions.flag,
          choices.map((choice) =>
            choice.hint ? `${choice.hint}  ${choice.label}` : choice.label
          )
        );
      }

      const fallback = selectOptions.defaultIndex ?? 0;
      output.write(`\n${chalk.bold(question)}\n`);
      choices.forEach((choice, index) => {
        const marker = index === fallback ? chalk.cyan('›') : ' ';
        const number = chalk.dim(String(index + 1).padStart(2));
        const hint = choice.hint ? ` ${chalk.dim(choice.hint)}` : '';
        output.write(`${marker} ${number}  ${choice.label}${hint}\n`);
      });

      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        output.write(`${chalk.dim(`1-${choices.length}`)} [${fallback + 1}] `);
        const answer = await reader?.next(timeoutMs);
        if (answer === undefined) output.write('\n');
        if (answer === undefined) {
          throw new MissingInput(
            reader?.ended()
              ? `nothing on stdin — pass ${selectOptions.flag}`
              : `no answer in ${Math.round(timeoutMs / 1000)}s — pass ${
                  selectOptions.flag
                }`,
            selectOptions.flag,
            choices.map((choice) =>
              choice.hint ? `${choice.hint}  ${choice.label}` : choice.label
            )
          );
        }
        const trimmed = answer.trim();
        if (trimmed === '') return choices[fallback].value;
        const picked = Number(trimmed);
        if (
          Number.isInteger(picked) &&
          picked >= 1 &&
          picked <= choices.length
        ) {
          return choices[picked - 1].value;
        }
        output.write(chalk.yellow(`  not one of 1-${choices.length}\n`));
      }
      throw new MissingInput(
        `no usable answer after ${ATTEMPTS} attempts — pass ${selectOptions.flag}`,
        selectOptions.flag
      );
    },
  };
}

/**
 * Lines off a stream, one await at a time.
 *
 * `readline` is the obvious choice and was the first one: given a plain sink as its
 * `output` it silently reads nothing, and given none it dropped the line this code was
 * waiting for. Two hours of that is enough — a reader that keeps its own residual buffer
 * is twenty lines, survives several answers arriving in one chunk, and pauses the stream
 * when nobody is waiting so the process can still exit.
 */
function createLineReader(input: NodeJS.ReadableStream): {
  next(timeoutMs: number): Promise<string | undefined>;
  ended(): boolean;
} {
  let buffer = '';
  let attached = false;
  let ended = false;
  const waiting: ((line: string | undefined) => void)[] = [];

  const deliver = (): void => {
    while (waiting.length > 0) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      waiting.shift()?.(line);
    }
    // Nobody is waiting: let go of the stream so the process is free to exit.
    if (waiting.length === 0) input.pause?.();
  };

  return {
    next(timeoutMs: number): Promise<string | undefined> {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (line: string | undefined): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const index = waiting.indexOf(finish);
          if (index >= 0) waiting.splice(index, 1);
          resolve(line);
        };
        const timer = setTimeout(() => finish(undefined), timeoutMs);
        timer.unref?.();

        if (ended) {
          finish(undefined);
          return;
        }

        waiting.push(finish);
        if (!attached) {
          attached = true;
          input.on('data', (chunk: Buffer | string) => {
            buffer += String(chunk);
            deliver();
          });
          // A closed stdin is an answer too: nothing more is coming, so waiting out the
          // full minute would only make a piped run look like a hang.
          const stop = (): void => {
            ended = true;
            while (waiting.length > 0) waiting.shift()?.(undefined);
          };
          input.on('end', stop);
          input.on('close', stop);
        }
        input.resume?.();
        deliver();
      });
    },
    ended(): boolean {
      return ended;
    },
  };
}

/** The message a non-interactive run gets: what was needed, and what to pass. */
export function describeMissingInput(error: MissingInput): string {
  if (error.candidates.length === 0) return error.message;
  const list = error.candidates.map((line) => `    ${line}`).join('\n');
  return `${error.message}\n${list}`;
}
