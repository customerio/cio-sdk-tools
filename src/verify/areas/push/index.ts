import { Command } from 'commander';
import { PUSH_VOICE } from './voice';
import { ALL_STATES } from '../../platform/app_state';
import { runArea } from '../../core/run';
import { runPush } from './run';
import { VerifyPushOptions } from './options';
import { Area } from '../../core/area';
import { CAUSES } from './causes';
import { PUSH_LEVELS, PUSH_STEPS } from './levels';

/**
 * `verify push` is the deterministic half of push verification. Its whole reason to exist
 * is that an agent asked "did push work?" will answer yes from a clean build — so the
 * answer has to come from evidence, with a stable name for whatever went wrong.
 */
const pushCommand = new Command('push')
  .description(
    'Verify an iOS or Android push integration, then send real pushes and follow each one until the app receives it'
  )
  .argument(
    '[path]',
    'path to the project: an .xcodeproj, a Gradle app module, or a directory holding one',
    '.'
  )
  .option('--json', 'emit the machine-readable report on stdout', false)
  .option('--report <path>', 'write the machine-readable report to a file')
  .option(
    '--app-target <name>',
    'app target to verify, when the project builds several'
  )
  .option(
    '--configuration <name>',
    'build configuration to read settings from',
    'Debug'
  )
  .option(
    '--target <name|udid|serial>',
    'simulator, device or emulator to verify against'
  )
  .option('--platform <ios|android>', 'skip platform detection')
  .option(
    '--package <applicationId>',
    'Android application id to verify, when the module builds several variants'
  )
  .option(
    '--non-interactive',
    'never prompt; every choice must come from a flag',
    false
  )
  .option(
    '--opened',
    'also verify the opened metric and the deep link, by tapping the push each app state already gets (killed and background by default) — it needs a person, so it never runs unattended (implies --send)',
    false
  )
  .option(
    '--link <url>',
    'deep link the tapped pushes carry (must be a URL the app routes)'
  )
  .option(
    '--observe',
    'watch the install, the token and the login happen, instead of reading what they left behind',
    false
  )
  .option(
    '--app-module <name>',
    'Gradle app module to verify, when the project builds several'
  )
  .option(
    '--workspace <id>',
    'workspace (environment) id, skipping auto-selection'
  )
  .option(
    '--profile <name>',
    'cio CLI credential profile to read (defaults to its current_profile)'
  )
  .option(
    '--send',
    'send real pushes and follow each one until it reaches the device and the app handles it',
    false
  )
  .option(
    '--states <list>',
    `app states to cover when sending (${ALL_STATES.join(', ')})`
  )
  .option(
    '--dry-run',
    'with --send, do everything except the send itself',
    false
  )
  .option(
    '--no-resend',
    'never send a second push when the first does not arrive'
  )
  .option(
    '-y, --yes',
    'send real pushes without asking first; required to send when nobody can be asked (--non-interactive, --json, no terminal)',
    false
  )
  .option(
    '-v, --verbose',
    'print every check, every command and every phase (also CIO_VERBOSE=1)',
    false
  )
  .option(
    '-q, --quiet',
    'print only the verdict and what to do about it',
    false
  )
  .option('--evidence <dir>', 'directory to write captured logs into')
  .action(async (pathArg: string, options: VerifyPushOptions) => {
    process.exitCode = await runArea(options, PUSH_VOICE, (context) =>
      runPush(pathArg, options, context)
    );
  });

/** Push, as `verify` sees it: its command, its steps and levels, and its causes. */
export const PUSH_AREA: Area = {
  name: 'push',
  summary: 'real pushes reach the app; a tap opens it and its deep link',
  steps: PUSH_STEPS,
  levels: PUSH_LEVELS,
  causes: CAUSES,
  command: () => pushCommand,
};
