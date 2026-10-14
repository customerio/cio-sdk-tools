import chalk from 'chalk';
import { emitKeypressEvents } from 'readline';
import { visibleLength } from './report/render';

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

/** What a person said about a tap they were asked for. */
export type TapAnswer = 'tapped' | 'not_shown' | 'skipped' | 'no_answer';

export interface Asker {
  readonly interactive: boolean;
  /**
   * How many questions a person has answered so far. Taps are not counted: they are the
   * check itself, not an answer a flag could have given.
   */
  readonly asked: number;
  /**
   * A free-text answer that may be left empty. Enter, silence, a closed stdin and a run that
   * cannot ask all read as no answer, because whatever asks this has a way to do without.
   */
  ask(
    question: string,
    options?: { hint?: string }
  ): Promise<string | undefined>;
  /**
   * Ask for a tap, and what came of it. "Press Enter when done" left a person who never saw
   * the banner two answers, both wrong: Enter (a tap that did not happen) or ctrl-c (the
   * whole run). Silence is `no_answer`: a tap nobody confirmed must never read as a tap
   * that happened.
   */
  askTap(
    instruction: string,
    options?: { timeoutMs?: number }
  ): Promise<TapAnswer>;
  /**
   * A yes/no question whose answer defaults to no. Only an explicit yes counts: Enter,
   * silence, a closed stdin and a run that cannot ask all read as no, because this is the
   * question asked before something that cannot be taken back. On a terminal it is two rows
   * picked with the arrow keys, the cursor starting on no.
   */
  agree(
    question: string,
    context?: string,
    answers?: { yes: string; no: string }
  ): Promise<boolean>;
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
  // Arrow keys need a terminal on both ends: raw keypresses in, cursor moves out. Anything
  // else — a pipe, CI, the tests — answers by number, as before.
  const arrows =
    interactive &&
    (input as RawInput).isTTY === true &&
    typeof (input as RawInput).setRawMode === 'function' &&
    (output as { isTTY?: boolean }).isTTY === true;
  const pick = async (
    rows: { label: string; hint?: string }[],
    initial: number,
    wait: number,
    collapse?: Collapse
  ): Promise<number | undefined> => {
    // The line reader stays attached to stdin, and would pause it after the first keypress
    // and keep the keystrokes as a line for the next question. It sits this one out.
    reader?.hold(true);
    try {
      return await pickWithArrows(
        input as RawInput,
        output,
        rows,
        initial,
        wait,
        collapse
      );
    } finally {
      reader?.hold(false);
    }
  };
  const columns = () => (output as { columns?: number }).columns;
  /** An answered question, as the one line it collapses to. */
  const answered = (question: string, answer: string, done = true) =>
    `${done ? chalk.green('✔') : chalk.dim('–')} ${question} ${chalk.dim(
      '·'
    )} ${answer}\n`;

  let asked = 0;

  return {
    interactive,

    get asked() {
      return asked;
    },

    async ask(
      question: string,
      askOptions: { hint?: string } = {}
    ): Promise<string | undefined> {
      if (!interactive) return undefined;
      asked += 1;
      const hint = askOptions.hint
        ? ` ${chalk.dim(`(${askOptions.hint})`)}`
        : '';
      // On a terminal the answered question collapses to one line, so a run that asked four
      // things reads as four lines rather than twelve.
      const shown = `${chalk.bold(question)}${hint}`;
      output.write(`${arrows ? '' : '\n'}${shown}\n${chalk.dim('›')} `);
      const answer = await reader?.next(timeoutMs);
      if (answer === undefined) {
        output.write('\n');
        return undefined;
      }
      const trimmed = answer.trim() || undefined;
      if (arrows) {
        const height =
          rowsOf(shown, columns()) + rowsOf(`› ${answer}`, columns());
        output.write(
          `${ESC}${height}A${ESC}0J${answered(question, trimmed ?? 'none')}`
        );
      }
      return trimmed;
    },

    async askTap(
      instruction: string,
      tapOptions: { timeoutMs?: number } = {}
    ): Promise<TapAnswer> {
      if (!interactive) return 'no_answer';
      const answers: [TapAnswer, string][] = [
        ['tapped', 'I tapped it'],
        ['not_shown', 'It never showed up'],
        ['skipped', 'Skip this state'],
      ];
      output.write(`\n${chalk.bold(instruction)}\n`);
      if (arrows) {
        // Once answered, the instructions go: the result row that follows says what came of
        // the tap, and instructions left between result rows read as results themselves.
        const index = await pick(
          answers.map(([, label]) => ({ label })),
          0,
          tapOptions.timeoutMs ?? timeoutMs,
          { above: 1 + rowsOf(instruction, columns()) }
        );
        return index === undefined ? 'no_answer' : answers[index][0];
      }
      answers.forEach(([, label], index) => {
        const marker = index === 0 ? chalk.cyan('›') : ' ';
        output.write(
          `${marker} ${chalk.dim(String(index + 1).padStart(2))}  ${label}\n`
        );
      });
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        output.write(`${chalk.dim(`1-${answers.length}`)} [1] `);
        const answer = await reader?.next(tapOptions.timeoutMs ?? timeoutMs);
        if (answer === undefined) {
          output.write('\n');
          return 'no_answer';
        }
        const trimmed = answer.trim();
        // Enter still means "tapped", as it did before there was a choice.
        if (trimmed === '') return 'tapped';
        const picked = Number(trimmed);
        if (
          Number.isInteger(picked) &&
          picked >= 1 &&
          picked <= answers.length
        ) {
          return answers[picked - 1][0];
        }
        output.write(chalk.yellow(`  not one of 1-${answers.length}\n`));
      }
      return 'no_answer';
    },

    async agree(
      question: string,
      context?: string,
      answers: { yes: string; no: string } = { yes: 'Yes', no: 'No' }
    ): Promise<boolean> {
      if (!interactive) return false;
      asked += 1;
      if (context) output.write(`\n${context}`);
      if (arrows) {
        output.write(`\n${chalk.bold(question)}\n`);
        // The cursor starts on no: Enter alone must never be the yes.
        const index = await pick(
          [{ label: answers.yes }, { label: answers.no }],
          1,
          timeoutMs,
          {
            above: rowsOf(question, columns()),
            line: (label, at) => answered(question, label, at === 0),
          }
        );
        // A yes goes on to the results, which want a blank line above them; a no ends the
        // run, whose summary brings its own.
        if (index === 0) output.write('\n');
        return index === 0;
      }
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
      asked += 1;
      output.write(`${arrows ? '' : '\n'}${chalk.bold(question)}\n`);
      if (arrows) {
        const index = await pick(choices, fallback, timeoutMs, {
          above: rowsOf(question, columns()),
          line: (label) => answered(question, label),
        });
        if (index === undefined) {
          throw new MissingInput(
            `no answer in ${Math.round(timeoutMs / 1000)}s — pass ${
              selectOptions.flag
            }`,
            selectOptions.flag,
            choices.map((choice) =>
              choice.hint ? `${choice.hint}  ${choice.label}` : choice.label
            )
          );
        }
        return choices[index].value;
      }
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
  /** Ignore the stream while something else reads it, keystroke by keystroke. */
  hold(on: boolean): void;
} {
  let buffer = '';
  let attached = false;
  let ended = false;
  let held = false;
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
            if (held) return;
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
    hold(on: boolean): void {
      held = on;
      if (!on) buffer = '';
    },
  };
}

/** A terminal that can be switched to raw mode, so single keys arrive as they are pressed. */
interface RawInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
}

const ESC = '\u001b[';

/**
 * Pick one row with the arrow keys, the way EAS and Expo's CLIs do. They use the `prompts`
 * library; this is the same keys without a second reader competing for stdin, and with the
 * timeout a tap prompt needs. ↑/↓ or k/j move, a number jumps, Enter picks, and ctrl-c stops
 * the run as it does anywhere else. Once picked, the list collapses to the one line chosen.
 * `undefined` means no answer in time.
 */
export interface Collapse {
  /** Rows written above the list, the question or instructions, to take down with it. */
  above: number;
  /** The line the answer leaves; none, and nothing is left. */
  line?: (label: string, index: number) => string;
}

export function pickWithArrows(
  input: RawInput,
  output: { write(chunk: string): unknown },
  rows: { label: string; hint?: string }[],
  initial: number,
  timeoutMs: number,
  collapse?: Collapse
): Promise<number | undefined> {
  let index = Math.min(Math.max(initial, 0), rows.length - 1);
  const height = rows.length + 1;

  const draw = (first: boolean): void => {
    if (!first) output.write(`${ESC}${height}A`);
    rows.forEach((row, at) => {
      const current = at === index;
      const marker = current ? chalk.cyan('›') : ' ';
      const number = chalk.dim(String(at + 1).padStart(2));
      const label = current ? chalk.cyan(row.label) : row.label;
      const hint = row.hint ? ` ${chalk.dim(row.hint)}` : '';
      output.write(`${ESC}2K${marker} ${number}  ${label}${hint}\n`);
    });
    output.write(`${ESC}2K${chalk.dim('  ↑/↓ to move · Enter to pick')}\n`);
  };

  return new Promise((resolve) => {
    const wasRaw = input.isRaw === true;
    emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.resume();
    output.write(`${ESC}?25l`);
    draw(true);

    const finish = (picked: number | undefined, interrupted = false): void => {
      clearTimeout(timer);
      input.removeListener('keypress', onKey);
      input.setRawMode?.(wasRaw);
      input.pause();
      // Collapse the list to the answer, so the scrollback reads like a log.
      output.write(`${ESC}${height + (collapse?.above ?? 0)}A${ESC}0J`);
      if (picked === undefined) {
        output.write(`  ${chalk.dim(interrupted ? 'stopped' : 'no answer')}\n`);
      } else if (!collapse) {
        output.write(`  ${chalk.green('✔')} ${rows[picked].label}\n`);
      } else if (collapse.line) {
        output.write(collapse.line(rows[picked].label, picked));
      }
      output.write(`${ESC}?25h`);
      resolve(picked);
      // Raw mode swallows ctrl-c as a keypress; hand it back as the signal it would have
      // been, so the run stops and its log capture is cleaned up the usual way.
      if (interrupted) process.kill(process.pid, 'SIGINT');
    };

    const onKey = (
      text: string | undefined,
      key?: { name?: string; ctrl?: boolean }
    ): void => {
      if (key?.ctrl && key.name === 'c') return finish(undefined, true);
      if (key?.name === 'return' || key?.name === 'enter') return finish(index);
      if (key?.name === 'up' || key?.name === 'k') {
        index = (index - 1 + rows.length) % rows.length;
      } else if (
        key?.name === 'down' ||
        key?.name === 'j' ||
        key?.name === 'tab'
      ) {
        index = (index + 1) % rows.length;
      } else if (text && /^[1-9]$/.test(text) && Number(text) <= rows.length) {
        index = Number(text) - 1;
      } else {
        return;
      }
      draw(false);
    };

    const timer = setTimeout(() => finish(undefined), timeoutMs);
    input.on('keypress', onKey);
  });
}

/** How many terminal rows text takes once its long lines wrap. */
export function rowsOf(text: string, columns?: number): number {
  const width = columns && columns > 0 ? columns : 80;
  return text
    .split('\n')
    .reduce(
      (rows, part) =>
        rows + Math.max(1, Math.ceil(visibleLength(part) / width)),
      0
    );
}

/** The message a non-interactive run gets: what was needed, and what to pass. */
export function describeMissingInput(error: MissingInput): string {
  if (error.candidates.length === 0) return error.message;
  const list = error.candidates.map((line) => `    ${line}`).join('\n');
  return `${error.message}\n${list}`;
}
