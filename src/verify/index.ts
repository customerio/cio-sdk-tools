import { Command } from 'commander';
import { PUSH_AREA } from './areas/push';
import { Area } from './core/area';
import { EXIT_CODE_LINES, useGroupedHelp } from './core/help';
import { registerCauses } from './core/report/causes';
import { addOutputOptions } from './core/run';

/**
 * Every area `verify` knows. Adding one is a folder under `areas/` and a line here; the core
 * and the platform code never learn its name.
 */
export const AREAS: Area[] = [PUSH_AREA];

export const verifyCommand = addOutputOptions(
  new Command('verify')
    .description(
      'Verify a Customer.io mobile SDK integration with evidence rather than optimism'
    )
    .usage('<area> [options]')
);

for (const area of AREAS) {
  registerCauses(area.name, area.causes);
  verifyCommand.addCommand(area.command());
}

useGroupedHelp(verifyCommand, () => ({
  description: [
    'Prove a Customer.io SDK integration works, one area at a time.',
  ],
  commands: {
    title: 'Areas',
    rows: AREAS.map((area): [string, string] => [area.name, area.summary]),
  },
  groups: [
    {
      title: 'Every area',
      entries: [
        { option: '--json' },
        { option: '--report' },
        { option: '--verbose' },
        { option: '--quiet' },
        { option: '--non-interactive' },
      ],
    },
  ],
  after: ['Each area has its own options: cio-sdk-tools verify <area> --help'],
  footer: [{ title: 'Exit codes', lines: EXIT_CODE_LINES }],
}));
