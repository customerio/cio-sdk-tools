import { Command, Option } from 'commander';
import { handler } from './doctor';
import pkg from '../package.json';

const program = new Command();

program
  .name(pkg.name)
  .version(pkg.version, '--version')
  .description(pkg.description);

program
  .command('doctor', { isDefault: true })
  .description('Check project for possible problems')
  .argument('[project_path]', 'Path to project directory', '.')
  .option('-v, --verbose', 'Enable verbose logging')
  .addOption(
    new Option('-r, --report [filename]', 'Output report to file').preset(
      'report.log'
    )
  )
  .action(handler);

program.parse(process.argv);
