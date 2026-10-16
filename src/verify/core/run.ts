import chalk from 'chalk';
import { Command } from 'commander';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ERROR_CODES, ErrorCode, printError } from './errors';
import {
  Asker,
  MissingInput,
  createAsker,
  describeMissingInput,
} from './prompt';
import { briefReport } from './report/brief';
import { Level, Reporter, Voice, createReporter } from './report/render';
import { Report } from './report/types';
import { wrapCommand } from './replay';

/** The options every area takes: how the run is shown, and whether it may ask. */
export interface OutputOptions {
  json?: boolean;
  report?: string;
  verbose?: boolean;
  quiet?: boolean;
  nonInteractive?: boolean;
}

/**
 * The options every area takes, defined once on `verify` and read by each area's command
 * through `optsWithGlobals()`, so they work before or after the area's name.
 */
export function addOutputOptions(command: Command): Command {
  return command
    .option('--json', 'print the report as JSON on stdout')
    .option('--report <file>', 'also write the JSON report to a file')
    .option(
      '-v, --verbose',
      'print every check, command, phase and the evidence behind them, and keep the device logs; with --json or --report, the full report (env: CIO_VERBOSE=1)'
    )
    .option('-q, --quiet', 'print only the verdict and what to do about it')
    .option(
      '--non-interactive',
      'never ask; anything missing is an error naming its option (--json implies this)'
    );
}

/** What an area is handed to run with. */
export interface RunContext {
  level: Level;
  reporter: Reporter;
  asker: Asker;
  /** `--verbose` was asked for, with or without `--json`: keep the evidence. */
  verbose: boolean;
}

/**
 * A failure of the tool itself, raised anywhere in an area's run: a bad argument, an
 * unusable path. It is never a verdict about the integration.
 */
export class ToolFailure extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode = ERROR_CODES.general,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'ToolFailure';
  }
}

/**
 * `CIO_VERBOSE` exists because Expo's `EXPO_DEBUG` habit is worth borrowing: the moment
 * you want detail is usually inside a script you are not editing.
 */
export function outputLevel(options: OutputOptions): Level {
  if (options.json) return 'json';
  if (wantsVerbose(options)) return 'verbose';
  if (options.quiet) return 'quiet';
  return 'human';
}

/** Asked for the detail behind the verdict: on screen, or in `--json` and `--report`. */
export function wantsVerbose(options: OutputOptions): boolean {
  return Boolean(options.verbose) || process.env.CIO_VERBOSE === '1';
}

/**
 * Run one area: set up how the run is shown and whether it may ask, let the area produce its
 * report, then emit it. Every area gets the same output, the same questions and the same
 * exit codes, whatever it verifies.
 */
export async function runArea(
  options: OutputOptions,
  voice: Voice,
  body: (context: RunContext) => Promise<Report>
): Promise<number> {
  const level = outputLevel(options);
  const reporter = createReporter({ level, voice });

  // Questions come before anything is touched, and a run that cannot ask says which flag
  // would have answered it. `--json` implies non-interactive: a machine reading stdout is
  // not going to type a number.
  const asker = createAsker({
    interactive:
      level !== 'json' &&
      !options.nonInteractive &&
      Boolean(process.stdin.isTTY),
  });

  let report: Report;
  try {
    report = await body({
      level,
      reporter,
      asker,
      verbose: wantsVerbose(options),
    });
  } catch (error) {
    if (error instanceof ToolFailure) {
      return toolError(options, error.message, error.code, {
        details: error.details,
      });
    }
    if (error instanceof MissingInput) {
      // The message stays one line and the candidates go in `details`, so an agent reads
      // a list instead of parsing a paragraph.
      return toolError(options, error.message, ERROR_CODES.validation, {
        details: { flag: error.flag, candidates: error.candidates },
        humanSuffix: describeMissingInput(error)
          .split('\n')
          .slice(1)
          .join('\n'),
      });
    }
    throw error;
  }

  await emit(report, reporter, options, voice);
  const human = level === 'human' || level === 'verbose';
  // A run that had to ask hands over the command that would not have: the next run, the
  // CI job, the agent. One that asked nothing was already that command, and one whose
  // go-ahead was refused does not get a command that would skip it.
  const declined = report.consent?.granted === false;
  if (report.rerun && asker.asked > 0 && human && !declined) {
    printCommand('Run it again without the questions:', report.rerun);
  }
  // What to do about an inconclusive result is to try it again, so the narrower command is
  // printed even in quiet mode, which keeps "what to do about it".
  if (report.rerunUnproven && (human || level === 'quiet')) {
    printCommand("Run what couldn't be proven again:", report.rerunUnproven);
  }
  return report.exitCode;
}

/**
 * The JSON is cut to what a customer acts on — verdicts, causes, fixes — unless `--verbose`
 * asked for the evidence too: an agent reading a failing command keeps only so much of it,
 * and log lines crowded out the fix.
 */
async function emit(
  built: Report,
  reporter: Reporter,
  options: OutputOptions,
  voice: Voice
): Promise<void> {
  const shown = wantsVerbose(options)
    ? built
    : briefReport(built, voice.reportKeys);
  if (options.report) {
    await fs.writeFile(
      path.resolve(process.cwd(), options.report),
      `${JSON.stringify(shown, null, 2)}\n`,
      'utf8'
    );
  }
  if (options.json) process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
  else reporter.summary(built);
}

/**
 * A failure of the tool itself, which is never a verdict about the integration — written to
 * stderr in the `cio` CLI's envelope so one consumer can read both tools.
 */
function toolError(
  options: OutputOptions,
  message: string,
  code: ErrorCode = ERROR_CODES.general,
  extra?: { details?: unknown; humanSuffix?: string }
): number {
  const exitCode = printError(code, message, { details: extra?.details });
  if (!options.json) {
    process.stderr.write(`${message}\n`);
    if (extra?.humanSuffix) process.stderr.write(`${extra.humanSuffix}\n`);
  }
  return exitCode;
}

function printCommand(title: string, command: string): void {
  process.stdout.write(
    ['', chalk.bold(title), ...wrapCommand(command, 78, '  '), '', ''].join(
      '\n'
    )
  );
}
