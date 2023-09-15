#!/usr/bin/env node

import { program } from 'commander';
import { doctorCommand } from './doctor';

const packageJson = require('../package.json');

program
  .name(packageJson.name)
  .version(packageJson.version, '--version')
  .description(packageJson.description);

program.addCommand(doctorCommand);

program.parse();
