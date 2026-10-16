import chalk from 'chalk';
import ora, { Ora } from 'ora';
import { formatMs, stopwatch } from '../clock';
import { setTracer } from '../exec';
import { BriefKeys } from './brief';
import { Cell, Check, Report, Rung, Section, Verdict } from './types';

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
  /** The heading over a section's cells, e.g. `Pushes`. */
  matrixTitle?(section: string): string;
  /** A cell's roll-up phrase, when the cell did not write its own. */
  cellSummary(cell: Cell, section: string): string;
  /** A cell named in a sentence about the whole run: "killed tap". */
  cellLabel(cell: Cell, section: string): string;
  /** The closing line when a section of cells did not pass. */
  failed: string;
  /** The closing lines of a run that passed: what it proved, in the area's words. */
  conclusion(report: Report): string[];
  /** What names the area's sections and cells, kept when the report is cut down. */
  reportKeys?: BriefKeys;
}

/** Used when no area speaks: says what passed and claims nothing more. */
export const PLAIN_VOICE: Voice = {
  command: 'verify',
  firstSection: 'checks',
  sectionName: () => 'section',
  cellSummary: (cell) =>
    cell.verdict === 'pass' ? 'passed' : cell.cause ?? cell.verdict,
  cellLabel: (_cell, section) => section,
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
  let matrices = 0;
  let timer: NodeJS.Timeout | undefined;
  /** Notes already printed in a block, so the closing facts do not say them twice. */
  const shownNotes = new Set<string>();

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

  function remember(facts: [string, string][]): void {
    for (const [label, value] of facts) {
      if (label === 'note' && !quiet) shownNotes.add(value);
    }
  }

  /**
   * Under a row that did not pass: the fact needed to act on it, and with `--verbose` the
   * evidence and the cause code behind it.
   */
  function findings(item: Pick<Check, 'detail' | 'evidence' | 'cause'>): void {
    if (item.detail) line(`         ${item.detail}`);
    if (!verbose) return;
    for (const evidence of item.evidence ?? []) {
      if (evidence !== item.detail) line(`         ${chalk.dim(evidence)}`);
    }
    if (item.cause) line(`         ${chalk.dim(item.cause)}`);
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
      remember(facts);
      line();
    },

    block(title: string, facts: [string, string][]) {
      line();
      line(chalk.bold(title));
      factLines(facts).forEach((text) => line(text));
      remember(facts);
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
              verbose ? rung.durationMs ?? ms : undefined,
              columns
            )
          );
          // The roll-up earns its brevity by expanding exactly what did not pass.
          const shown = verbose
            ? rung.checks
            : rung.checks.filter((c) => c.verdict !== 'pass');
          for (const check of shown) {
            line(`     ${glyph(check.verdict)} ${check.label}`);
            findings({
              ...check,
              cause: check.verdict === 'pass' ? undefined : check.cause,
            });
          }
        },
      };
    },

    matrix(how?: string, section = voice.firstSection) {
      currentSection = section;
      // A later block of cells is set apart from the rows above it.
      if (matrices++ > 0) line();
      const title = voice.matrixTitle?.(section) ?? `${section} matrix`;
      // How the log is read is the tool's business, unless someone is debugging it.
      line(
        `${chalk.bold(title)}${how && verbose ? chalk.dim(`   (${how})`) : ''}`
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
              `  ${glyph(cell.verdict)}`,
              state,
              cell.summary ??
                voice.cellSummary(cell, section ?? currentSection),
              verbose ? cell.durationMs ?? ms : undefined,
              columns
            )
          );
          if (verbose || cell.verdict !== 'pass') findings(cell);
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
      const where = findingsByCause(report, voice);
      for (const cause of ordered) {
        const head =
          cause.severity === 'blocker'
            ? chalk.red('why')
            : chalk.yellow('note');
        // Which rows it explains, so two failures are not left to be matched up by eye.
        const rows = where.get(cause.code);
        body.push(
          `  ${head}  ${rows ? `${chalk.bold(rows)}: ` : ''}${cause.summary}`
        );
        body.push(`       ${cause.remedy}`);
        if (cause.docs) body.push(`       ${chalk.dim(cause.docs)}`);
        body.push('');
      }

      // A section that never ran never streamed a line, so it says so here. Without this
      // the reason a section was skipped — "opened needs a real tap", "nothing was confirmed" —
      // vanished from the output entirely, leaving only "nothing was proven".
      const rungs = report.sections.filter(
        (section): section is Extract<typeof section, { kind: 'checks' }> =>
          section.kind === 'checks'
      );
      const cells = report.sections.filter(
        (section): section is Extract<typeof section, { kind: 'cells' }> =>
          section.kind === 'cells'
      );
      // Sections skipped for the same reason share one line: a declined go-ahead skips every
      // section, and saying so once per section read as several problems.
      const skippedFor = new Map<string, string[]>();
      for (const section of cells) {
        if (!section.skipped) continue;
        const names = skippedFor.get(section.skipped) ?? [];
        names.push(voice.sectionName(section));
        skippedFor.set(section.skipped, names);
      }
      for (const [reason, names] of skippedFor) {
        body.push(
          `  ${chalk.dim('-')} ${names.join(', ')}: ${chalk.dim(reason)}`
        );
      }
      if (skippedFor.size > 0) body.push('');

      // The verdict comes first and stands alone: the one line a reader looks for.
      const failing = rungs.find((rung) =>
        rung.checks.some((check) => check.verdict === 'fail')
      );
      if (failing) {
        body.push(
          chalk.red(
            `${glyph('fail')} ${sentence(
              `stopped at rung ${rungs.indexOf(failing) + 1} — ${
                failing.title
              }.`
            )}`
          )
        );
      } else if (report.verdict === 'fail') {
        body.push(chalk.red(`${glyph('fail')} ${sentence(voice.failed)}`));
      } else if (report.verdict === 'skip') {
        body.push(
          chalk.yellow(`- ${sentence(unprovenLine(cells, voice, verbose))}`)
        );
      } else {
        // Only the area knows what its run proved, and it says that and nothing more.
        const [claim, ...caveats] = voice.conclusion(report);
        body.push(`${glyph('pass')} ${chalk.green(sentence(claim))}`);
        for (const caveat of caveats) {
          body.push(chalk.dim(`  ${sentence(caveat)}`));
        }
      }

      // Then the facts about the run, each under its own label.
      const totalMs =
        new Date(report.finishedAt).getTime() -
        new Date(report.startedAt).getTime();
      const evidencePath = cells.find((section) => section.logs?.evidencePath)
        ?.logs?.evidencePath;
      const facts: [string, string][] = (report.advice ?? [])
        .filter((note) => !shownNotes.has(note))
        .map((note): [string, string] => ['note', note]);
      // How the run knows and how long it took are for whoever is debugging it.
      if (verbose) {
        if (report.provenance === 'observed') {
          facts.push(['watched', 'the install, push token and login happen']);
        }
        facts.push(['took', formatMs(totalMs)]);
        if (evidencePath) facts.push(['evidence', evidencePath]);
      }
      if (level === 'human') facts.push(['detail', 're-run with --verbose']);
      body.push('', ...factLines(facts), '');
      write(out, body.join('\n'));
    },
  };
}

/**
 * The closing line of a run that was not all proven. "Nothing was proven" is only true when
 * nothing was: a run where four cells passed and one could not be read says that, and names
 * the one.
 */
export function unprovenLine(
  sections: (Section & { kind: 'cells' })[],
  voice: Voice,
  withCodes = false
): string {
  const cells = sections
    .filter((section) => !section.skipped)
    .flatMap((section) =>
      section.cells.map((cell) => ({
        cell,
        section: voice.sectionName(section),
      }))
    );
  const proven = cells.filter(
    ({ cell }) => cell.verdict === 'pass' || cell.verdict === 'warn'
  );
  if (proven.length === 0) return 'nothing was proven. Skipped is not passed.';
  const parts = [`${proven.length} of ${cells.length} proven`];
  const unproven = cells.filter(({ cell }) => cell.verdict === 'skip');
  if (unproven.length > 0) {
    parts.push(
      `not proven: ${unproven
        .map(
          ({ cell, section }) =>
            `${voice.cellLabel(cell, section)}${
              cell.cause && withCodes ? ` (${cell.cause})` : ''
            }`
        )
        .join(', ')}`
    );
  }
  const notRun = sections
    .filter((section) => section.skipped)
    .map((section) => voice.sectionName(section));
  if (notRun.length > 0) parts.push(`${notRun.join(', ')} did not run`);
  return `${parts.join('; ')}. Skipped is not passed.`;
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

/** A closing line reads as a sentence: it starts with a capital. */
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Which rows each cause explains: the rung's title for a check, the area's name for a cell.
 * A cause named nowhere — a note about the run as a whole — gets no prefix.
 */
function findingsByCause(report: Report, voice: Voice): Map<string, string> {
  const rows = new Map<string, string[]>();
  const add = (code: string | undefined, label: string) => {
    if (!code) return;
    const labels = rows.get(code) ?? [];
    if (!labels.includes(label)) labels.push(label);
    rows.set(code, labels);
  };
  for (const section of report.sections) {
    if (section.kind === 'checks') {
      for (const check of section.checks) {
        if (check.verdict !== 'pass') add(check.cause, section.title);
      }
      continue;
    }
    const name = voice.sectionName(section);
    for (const cell of section.cells) {
      if (cell.verdict !== 'pass') add(cell.cause, voice.cellLabel(cell, name));
    }
  }
  return new Map([...rows].map(([code, labels]) => [code, labels.join(', ')]));
}

function row(
  glyphText: string,
  title: string,
  summary: string,
  ms: number | undefined,
  columns?: number
): string {
  const head = `${glyphText} ${title.padEnd(TITLE_WIDTH)} ${summary}`;
  if (ms === undefined) return head;
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
  // The checks that did not pass are listed under the row, and explained at the end.
  const failed = rung.checks.filter((c) => c.verdict === 'fail');
  if (failed.length > 0) return `${failed.length} failed`;
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
