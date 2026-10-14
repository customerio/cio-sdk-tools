import { Command } from 'commander';
import { PUSH_AREA } from './areas/push';
import { Area } from './core/area';
import { registerCauses } from './core/report/causes';

/**
 * Every area `verify` knows. Adding one is a folder under `areas/` and a line here; the core
 * and the platform code never learn its name.
 */
export const AREAS: Area[] = [PUSH_AREA];

export const verifyCommand = new Command('verify').description(
  'Verify a Customer.io mobile SDK integration with evidence rather than optimism'
);

for (const area of AREAS) {
  registerCauses(area.name, area.causes);
  verifyCommand.addCommand(area.command());
}
