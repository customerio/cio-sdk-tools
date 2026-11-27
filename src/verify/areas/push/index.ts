import { Command, Option } from 'commander';
import { Area } from '../../core/area';
import { EXIT_CODE_LINES, useGroupedHelp } from '../../core/help';
import { levelsHelp } from '../../core/levels';
import { OutputOptions, runArea } from '../../core/run';
import { CAUSES } from './causes';
import { PUSH_LEVELS, PUSH_STEPS } from './levels';
import { PushFlags, SENDING_FLAGS } from './options';
import { runPush } from './run';
import { PUSH_VOICE } from './voice';

/**
 * `verify push` is the deterministic half of push verification. Its whole reason to exist
 * is that an agent asked "did push work?" will answer yes from a clean build — so the
 * answer has to come from evidence, with a stable name for whatever went wrong.
 */
const sending = (flags: string, description: string) =>
  new Option(flags, description).implies({ depth: 'on-device' });

const pushCommand = new Command('push')
  .description(
    'Prove push works: real pushes go through your workspace to a device, and each one is followed until the app handles it.'
  )
  .usage('[path] [options]')
  .argument(
    '[path]',
    'the app project: an .xcodeproj, a Gradle app module, or a folder holding one',
    '.'
  )
  .option(
    '--depth <level>',
    'asked in a terminal; registration when nobody can be asked'
  )
  .addOption(
    sending(
      '--app-states <list>',
      'app states to test, one real push each: killed, background, foreground (default: all three)'
    )
  )
  .addOption(
    sending(
      '--check-opens',
      'you tap the pushes sent while the app was killed or in the background; the open and the deep link are checked'
    )
  )
  .addOption(
    sending(
      '--deep-link <url>',
      'URL the pushes carry, so a tap is checked to land there'
    )
  )
  .addOption(sending('-n, --dry-run', 'do everything except send the pushes'))
  .addOption(
    sending('--no-retry', "don't send a second push when the first is missing")
  )
  .option('--workspace <id>', 'Customer.io workspace the app should report to')
  .option(
    '-d, --device <id|name>',
    'simulator, phone or emulator: udid, serial or name. Picked for you when only one is connected'
  )
  .option('--cio-profile <name>', 'cio CLI login to use (env: CIO_PROFILE)')
  .option(
    '--platform <ios|android>',
    'when the folder holds both an Xcode and a Gradle project'
  )
  .option('--ios-target <name>', 'iOS app target')
  .option('--ios-configuration <name>', 'iOS build configuration', 'Debug')
  .option('--android-module <name>', 'Android Gradle app module')
  .option(
    '--android-app-id <id>',
    'Android applicationId of the installed variant'
  )
  .option(
    '--user <id>',
    "the identified user, when the tool can't read it off the device"
  )
  .option(
    '--token <token>',
    "the device's push token, when the tool can't read it off the device"
  )
  .option(
    '--watch-registration',
    'watch the install, push token and login happen, instead of reading what they left behind'
  )
  .option(
    '--evidence-dir <dir>',
    'keep captured logs and screenshots here (by default they are deleted when the run ends, unless --verbose keeps them in a temp folder)'
  )
  .action(async (pathArg: string, _flags: PushFlags, command: Command) => {
    const flags = command.optsWithGlobals() as PushFlags & OutputOptions;
    const source = (key: string) => command.getOptionValueSource(key);
    process.exitCode = await runArea(flags, PUSH_VOICE, (context) =>
      runPush(
        pathArg,
        flags,
        {
          depth: ['cli', 'implied'].includes(source('depth') ?? ''),
          workspace: source('workspace') === 'cli',
          device: source('device') === 'cli',
          sendingFlags: SENDING_FLAGS.filter(
            ([key]) => source(key) === 'cli'
          ).map(([, flag]) => flag),
        },
        context
      )
    );
  });

useGroupedHelp(pushCommand, (width) => ({
  description: [
    'Prove push works: real pushes go through your workspace to a device, and each one is followed until the app handles it.',
  ],
  groups: [
    {
      title: 'How far to check',
      entries: [
        { option: '--depth', lines: levelsHelp(PUSH_LEVELS, width - 32) },
      ],
    },
    {
      title: 'Pushes (each of these implies --depth on-device)',
      entries: [
        { option: '--app-states' },
        { option: '--check-opens' },
        { option: '--deep-link' },
        { option: '--dry-run' },
        { option: '--no-retry' },
      ],
    },
    {
      title: 'Where (asked when missing)',
      entries: [
        { option: '--workspace' },
        { option: '--device' },
        { option: '--cio-profile' },
      ],
    },
    {
      title: 'Which app (asked only when the project builds several)',
      entries: [
        { option: '--platform' },
        { option: '--ios-target' },
        { option: '--ios-configuration' },
        { option: '--android-module' },
        { option: '--android-app-id' },
      ],
    },
    {
      title: 'Registration',
      entries: [
        { option: '--watch-registration' },
        { option: '--user' },
        { option: '--token' },
      ],
    },
    {
      title: 'Sending',
      entries: [
        {
          lines: [
            'Pushes are sent without asking when --depth, --workspace and --device are all given: naming where they go is the go-ahead. If the run picked any of them itself, it asks first, or stops when no one can answer.',
          ],
        },
      ],
    },
    {
      title: 'Output',
      entries: [
        { option: '--evidence-dir' },
        { term: '-h, --help', text: 'show this help' },
      ],
    },
  ],
  after: [
    "Plus every area's options: --json, --report <file>, -v, -q, --non-interactive (see cio-sdk-tools verify --help).",
  ],
  footer: [
    { title: 'Exit codes', lines: EXIT_CODE_LINES },
    {
      title: 'Examples',
      lines: [
        'Answer the questions:',
        '  $ cio-sdk-tools verify push',
        '',
        'Pushes and taps, checked on the device:',
        '  $ cio-sdk-tools verify push ./ios --depth on-device --check-opens \\',
        '      --deep-link myapp://home --workspace 12345 --device "iPhone 16"',
        '',
        'CI or an agent, nothing asked:',
        '  $ cio-sdk-tools verify push ./android --depth on-device --json \\',
        '      --workspace 12345 --device emulator-5554 > verify.json',
      ],
    },
  ],
}));

/** Push, as `verify` sees it: its command, its steps and levels, and its causes. */
export const PUSH_AREA: Area = {
  name: 'push',
  summary: 'real pushes reach the app; a tap opens it and its deep link',
  steps: PUSH_STEPS,
  levels: PUSH_LEVELS,
  causes: CAUSES,
  command: () => pushCommand,
};
