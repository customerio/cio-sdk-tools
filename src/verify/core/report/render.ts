import chalk from 'chalk';
import ora, { Ora } from 'ora';
import { formatMs, stopwatch } from '../clock';
import { setTracer } from '../exec';
import { Cell, Report, Rung, Section, Verdict } from './types';

/**
 * Everything a person reads comes from here.
 *
 * Three shapes of the same run, following the split Expo and EAS both settled on: a
 * roll-up while it works, the whole picture when something is wrong or when asked, and
 * silence when a machine is reading. The reason it is one module rather than a renderer
 * plus a progress printer is that they were drifting — the ladder rendered a report the
 * narrator had already half-described, and neither knew what the other had said.
 *
 * Streams: finished lines go to stdout, the live spinner to stderr. That is ora's own
 * default and it means piping stdout gives clean text with no cursor escapes, while a
 * non-TTY run drops the spinner entirely rather than emitting thousands of redraws.
 */
export type Level = 'json' | 'quiet' | 'human' | 'verbose';

/**
 * The words that belong to an area: what the run is called, what its cells prove, and what
 * a passing run may claim. The renderer lays out any area's report; only the area knows how
 * to say what it proved, and only what it proved.
 */
export interface Voice {
  /** Named on the opening line, e.g. `verify push`. */
  command: string;
  /** The section a cell belongs to when its caller does not say. */
  firstSection: string;
  /** How a section is named in the summary when it never ran. */
  sectionName(section: Section): string;
  /** A cell's roll-up phrase, when the cell did not write its own. */
  cellSummary(cell: Cell, section: string): string;
  /** The closing line when a section of cells did not pass. */
  failed: string;
  /** The closing lines of a run that passed: what it proved, in the area's words. */
  conclusion(report: Report): string[];
}

/** Used when no area speaks: says what passed and claims nothing more. */
export const PLAIN_VOICE: Voice = {
  command: 'verify',
  firstSection: 'checks',
  sectionName: () => 'section',
  cellSummary: (cell) =>
    cell.verdict === 'pass' ? 'passed' : cell.cause ?? cell.verdict,
  failed: 'a check did not pass.',
  conclusion: () => ['passed.'],
};

export interface RungHandle {
  /** Names what is happening right now. Replaces the spinner's text. */
  phase(text: string): void;
  /** Collapses the rung to one line, expanded when anything did not pass. */
  done(rung: Rung): void;
}

export interface CellHandle {
  phase(text: string): void;
  done(cell: Cell): void;
}

export interface Reporter {
  readonly level: Level;
  /** The run's opening block: what is being verified, and against what. */
  start(subject: string, facts?: [string, string][]): void;
  /** A titled block of facts mid-run, laid out like the opening block. */
  block(title: string, facts: [string, string][]): void;
  rung(title: string): RungHandle;
  /** Opens a section of cells; `section` names it, the voice's first section by default. */
  matrix(how?: string, section?: string): void;
  cell(state: string, section?: string): CellHandle;
  /** A fact worth recording but not worth a line in the roll-up. */
  note(text: string): void;
  /**
   * Take the spinner down while something else owns the terminal.
   *
   * A question and a spinner cannot share a screen: the spinner repaints over the prompt,
   * and the person is left looking at "sending 892ms" wondering whether anything wants an
   * answer. Anything that asks has to pause first.
   */
  pause(): void;
  resume(): void;
  summary(report: Report): void;
}

const TITLE_WIDTH = 16;
/** Durations line up at the right edge, as narrow as 72 and never wider than 96. */
const MAX_WIDTH = 96;
const MIN_WIDTH = 72;
const TICK_MS = 500;

export function createReporter(options: {
  level: Level;
  /** The area's words. Without one, the reporter claims nothing beyond pass and fail. */
  voice?: Voice;
  out?: { write(chunk: string): unknown; isTTY?: boolean };
  err?: { write(chunk: string): unknown; isTTY?: boolean };
  /** Test seam: ora is disabled when this is false regardless of the level. */
  spinners?: boolean;
}): Reporter {
  const out = options.out ?? process.stdout;
  const columns = (out as { columns?: number }).columns;
  const err = options.err ?? process.stderr;
  const level = options.level;
  const quiet = level === 'json' || level === 'quiet';
  const verbose = level === 'verbose';
  const voice = options.voice ?? PLAIN_VOICE;

  // Expo's rule, and the reason for it is worth keeping: a spinner redrawing over debug
  // output is unreadable, so verbose turns it off rather than fighting it.
  const spinning =
    options.spinners ??
    (level === 'human' && Boolean(out.isTTY) && !process.env.CI);

  // Every shelled command becomes evidence in verbose mode. Installed here because the
  // alternative is threading a logger through twenty call sites that do not otherwise
  // care about output.
  setTracer(
    verbose
      ? (cmd, args, code, ms) => {
          const head = `  $ ${cmd} ${args.join(' ')}`;
          const tail = chalk.dim(`exit ${code} · ${formatMs(ms)}`);
          write(out, `${chalk.dim(head)}  ${tail}\n`);
        }
      : undefined
  );

  // One spinner for the whole run, the way EAS does it. Two live spinners garble each
  // other, and rungs overlap here: the device is read before the workspace rung is
  // evaluated, so two handles are open at once by design.
  let spinner: Ora | undefined;
  let spinnerText = '';
  let paused: string | undefined;
  /** Which section the cells now printing belong to, so each says what it proved. */
  let currentSection = voice.firstSection;
  let timer: NodeJS.Timeout | undefined;

  function paint(): void {
    if (spinner) spinner.text = spinnerText;
  }

  function setSpinner(text: string): void {
    spinnerText = text;
    if (!spinning) return;
    if (!spinner) {
      spinner = ora({
        text,
        stream: err as unknown as NodeJS.WriteStream,
        isEnabled: true,
      }).start();
      timer = setInterval(paint, TICK_MS);
      timer.unref?.();
    } else {
      paint();
    }
  }

  function stopSpinner(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
    spinner?.stop();
    spinner = undefined;
  }

  /** Expo's logWrap: a spinner has to be stopped before a line is written over it. */
  function line(text = ''): void {
    if (quiet) return;
    const resume = spinner ? spinnerText : undefined;
    if (spinner) stopSpinner();
    write(out, `${text}\n`);
    if (resume !== undefined) setSpinner(resume);
  }

  function track(
    title: string,
    indent: string
  ): {
    phase(text: string): void;
    stop(): number;
  } {
    const elapsed = stopwatch();
    setSpinner(`${indent}${title}`);
    return {
      phase(text: string) {
        setSpinner(
          `${indent}${title}  ${chalk.dim(text)} ${chalk.dim(
            formatMs(elapsed())
          )}`
        );
        // Without a spinner the phases are the only sign of life, so they are printed.
        if (!spinning && verbose) line(`     ${chalk.dim(`… ${text}`)}`);
      },
      stop() {
        return elapsed();
      },
    };
  }

  return {
    level,

    start(subject: string, facts: [string, string][] = []) {
      line();
      line(`${chalk.bold(voice.command)} ${chalk.dim('·')} ${subject}`);
      factLines(facts).forEach((text) => line(text));
      line();
    },

    block(title: string, facts: [string, string][]) {
      line();
      line(chalk.bold(title));
      factLines(facts).forEach((text) => line(text));
      line();
    },

    rung(title: string): RungHandle {
      const tracked = track(title, '');
      return {
        phase: tracked.phase,
        done(rung: Rung) {
          const ms = tracked.stop();
          // Explicit measurement wins: a rung whose gather ran earlier already knows how
          // long it took, and the handle's wall time would include everything since.
          rung.durationMs = rung.durationMs ?? ms;
          const verdict = verdictOf(rung);
          line(
            row(
              glyph(verdict),
              title,
              rung.skipped ?? rung.summary ?? summarise(rung),
              rung.durationMs ?? ms,
              columns
            )
          );
          // The roll-up earns its brevity by expanding exactly what did not pass.
          const shown = verbose
            ? rung.checks
            : rung.checks.filter((c) => c.verdict !== 'pass');
          for (const check of shown) {
            line(`     ${glyph(check.verdict)} ${check.label}`);
            for (const evidence of check.evidence ?? []) {
              line(`         ${chalk.dim(evidence)}`);
            }
            if (check.cause && check.verdict !== 'pass') {
              line(`         ${chalk.dim(check.cause)}`);
            }
          }
        },
      };
    },

    matrix(how?: string, section = voice.firstSection) {
      currentSection = section;
      line(
        `${chalk.bold(`  ${section} matrix`)}${
          how ? chalk.dim(`   (${how})`) : ''
        }`
      );
    },

    cell(state: string, section?: string): CellHandle {
      const tracked = track(state, '  ');
      return {
        phase: tracked.phase,
        done(cell: Cell) {
          const ms = tracked.stop();
          cell.durationMs = cell.durationMs ?? ms;
          line(
            row(
              `   ${glyph(cell.verdict)}`,
              state,
              cell.summary ??
                voice.cellSummary(cell, section ?? currentSection),
              cell.durationMs ?? ms,
              columns
            )
          );
          if (verbose || cell.verdict !== 'pass') {
            for (const evidence of cell.evidence) {
              line(`         ${chalk.dim(evidence)}`);
            }
            if (cell.cause) line(`         ${chalk.dim(cell.cause)}`);
          }
        },
      };
    },

    note(text: string) {
      if (verbose) line(`  ${chalk.dim(text)}`);
    },

    pause() {
      paused = spinnerText;
      stopSpinner();
    },

    resume() {
      if (paused !== undefined) {
        const text = paused;
        paused = undefined;
        setSpinner(text);
      }
    },

    summary(report: Report) {
      stopSpinner();
      if (level === 'json') return;
      const body: string[] = [''];

      // Blockers first: the thing that stopped the run should not be read after an aside.
      const ordered = [...report.causes].sort((a, b) =>
        a.severity === b.severity ? 0 : a.severity === 'blocker' ? -1 : 1
      );
      for (const cause of ordered) {
        const head =
          cause.severity === 'blocker'
            ? chalk.red('why')
            : chalk.yellow('note');
        body.push(`  ${head}  ${cause.summary}`);
        body.push(`       ${cause.remedy}`);
        if (cause.docs) body.push(`       ${chalk.dim(cause.docs)}`);
        body.push('');
      }

      // A section that never ran never streamed a line, so it says so here. Without this
      // the reason a matrix was skipped — "pass --send", "opened needs a real tap" —
      // vanished from the output entirely, leaving only "nothing was proven".
      for (const section of report.matrices ?? []) {
        if (!section.skipped) continue;
        body.push(`  ${chalk.bold(`${voice.sectionName(section)} matrix`)}`);
        body.push(`     ${chalk.dim(section.skipped)}`);
        body.push('');
      }

      for (const note of report.advice ?? []) {
        body.push(`  ${chalk.dim('fyi')}  ${chalk.dim(note)}`);
        body.push('');
      }

      const failing = report.rungs.find((rung) =>
        rung.checks.some((check) => check.verdict === 'fail')
      );
      if (failing) {
        body.push(
          chalk.red(
            `  stopped at rung ${report.rungs.indexOf(failing) + 1} — ${
              failing.title
            }.`
          )
        );
      } else if (report.verdict === 'fail') {
        body.push(chalk.red(`  ${voice.failed}`));
      } else if (report.verdict === 'skip') {
        body.push(chalk.yellow('  nothing was proven. skipped is not passed.'));
      } else {
        // Only the area knows what its run proved, and it says that and nothing more.
        const [claim, ...caveats] = voice.conclusion(report);
        body.push(chalk.green(`  ${claim}`));
        for (const caveat of caveats) body.push(chalk.dim(`  ${caveat}`));
      }

      const totalMs =
        new Date(report.finishedAt).getTime() -
        new Date(report.startedAt).getTime();
      const facts = [formatMs(totalMs), provenanceOf(report)];
      const evidencePath = (report.matrices ?? []).find(
        (section) => section.logs?.evidencePath
      )?.logs?.evidencePath;
      if (evidencePath) facts.push(`evidence ${evidencePath}`);
      body.push(chalk.dim(`  ${facts.join(' · ')}`));
      if (level === 'human' && report.causes.length === 0) {
        body.push(chalk.dim('  detail  re-run with --verbose'));
      }
      body.push('');
      write(out, body.join('\n'));
    },
  };
}

function write(stream: { write(chunk: string): unknown }, text: string): void {
  stream.write(text);
}

/** Label-value rows, labels padded so the values line up. */
export function factLines(facts: [string, string][]): string[] {
  return facts.map(
    ([label, value]) => `  ${chalk.dim(label.padEnd(9))}  ${value}`
  );
}

/** `read` says the facts came out of storage; `observed` says we watched them happen. */
function provenanceOf(report: Report): string {
  return report.provenance === 'observed' ? 'observed' : 'read';
}

function row(
  glyphText: string,
  title: string,
  summary: string,
  ms: number,
  columns?: number
): string {
  const head = `${glyphText} ${title.padEnd(TITLE_WIDTH)} ${summary}`;
  const took = formatMs(ms);
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, columns ?? MIN_WIDTH));
  const pad = Math.max(2, width - visibleLength(head) - took.length);
  return `${head}${' '.repeat(pad)}${chalk.dim(took)}`;
}

/** Padding has to count characters a terminal draws, not the escapes chalk adds. */
export function visibleLength(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, '').length;
}

function summarise(rung: Rung): string {
  // A cause code says more than a count, and it is the thing worth searching for.
  const failed = rung.checks.filter((c) => c.verdict === 'fail');
  if (failed.length > 0) {
    return failed[0].cause ?? `${failed.length} failed`;
  }
  const warned = rung.checks.filter((c) => c.verdict === 'warn').length;
  if (warned > 0) return `${warned} to look at`;
  return `${rung.checks.length} checks`;
}

function verdictOf(rung: Rung): Verdict {
  if (rung.skipped) return 'skip';
  if (rung.checks.some((c) => c.verdict === 'fail')) return 'fail';
  if (rung.checks.length === 0) return 'skip';
  if (rung.checks.every((c) => c.verdict === 'skip')) return 'skip';
  if (rung.checks.some((c) => c.verdict === 'warn')) return 'warn';
  return 'pass';
}

function glyph(verdict: Verdict): string {
  switch (verdict) {
    case 'pass':
      return chalk.green('✔');
    case 'fail':
      return chalk.red('✖');
    case 'warn':
      return chalk.yellow('!');
    default:
      return chalk.dim('-');
  }
}
