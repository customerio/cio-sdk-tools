import { promises as fs } from 'fs';
import * as path from 'path';
import { ERROR_CODES, ErrorCode, printError } from './errors';
import {
  Asker,
  MissingInput,
  createAsker,
  describeMissingInput,
} from './prompt';
import { Level, Reporter, Voice, createReporter } from './report/render';
import { Report } from './report/types';

/** The options every area takes: how the run is shown, and whether it may ask. */
export interface OutputOptions {
  json: boolean;
  report?: string;
  verbose: boolean;
  quiet: boolean;
  nonInteractive: boolean;
}

/** What an area is handed to run with. */
export interface RunContext {
  level: Level;
  reporter: Reporter;
  asker: Asker;
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
  if (options.verbose || process.env.CIO_VERBOSE === '1') return 'verbose';
  if (options.quiet) return 'quiet';
  return 'human';
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
    report = await body({ level, reporter, asker });
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

  await emit(report, reporter, options);
  return report.exitCode;
}

async function emit(
  built: Report,
  reporter: Reporter,
  options: OutputOptions
): Promise<void> {
  if (options.report) {
    await fs.writeFile(
      path.resolve(process.cwd(), options.report),
      `${JSON.stringify(built, null, 2)}\n`,
      'utf8'
    );
  }
  if (options.json) process.stdout.write(`${JSON.stringify(built, null, 2)}\n`);
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
