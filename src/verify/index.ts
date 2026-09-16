import { Command } from 'commander';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Ladder } from './ladder';
import { projectWiring } from './rungs/project_wiring';
import { EXIT } from './types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require('../../package.json');

type VerifyPushOptions = {
  json: boolean;
  report?: string;
  appTarget?: string;
  configuration: string;
};

/**
 * `verify push` is the deterministic half of push verification. Its whole reason to exist
 * is that an agent asked "did push work?" will answer yes from a clean build — so the
 * answer has to come from evidence, with a stable name for whatever went wrong.
 *
 * Preflight (this command today) proves the integration *could* report a push. The runtime
 * matrix that proves one actually was reported is the next step, and deliberately separate:
 * preflight needs nothing but the project on disk.
 */
export const verifyCommand = new Command('verify').description(
  'Verify a Customer.io mobile SDK integration with evidence rather than optimism'
);

const pushCommand = new Command('push')
  .description('Verify the iOS push integration (APNs)')
  .argument('[path]', 'path to the iOS project directory or .xcodeproj', '.')
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
  .action(async (pathArg: string, options: VerifyPushOptions) => {
    process.exitCode = await verifyPush(pathArg, options);
  });

verifyCommand.addCommand(pushCommand);

async function verifyPush(
  pathArg: string,
  options: VerifyPushOptions
): Promise<number> {
  if (process.platform !== 'darwin') {
    return toolError(
      options,
      'iOS verification needs macOS: it reads the project with Xcode tooling and the device with simctl.'
    );
  }

  const projectPath = await locateProject(path.resolve(process.cwd(), pathArg));
  if (!projectPath) {
    return toolError(options, `No .xcodeproj found at or under ${pathArg}`);
  }

  const startedAt = new Date().toISOString();
  const ladder = new Ladder();

  const wiring = await projectWiring({
    projectPath,
    scanRoot: path.dirname(projectPath),
    configuration: options.configuration,
    appTargetName: options.appTarget,
  });
  ladder.adopt(wiring.rung);

  // Later rungs need a workspace, a device and a real send. Until they land, saying so
  // keeps the verdict honest: preflight passing is not push working.
  if (!ladder.halted) {
    ladder.skip('workspace_ready', 'Workspace ready', 'not implemented yet');
    ladder.skip('device_ready', 'Device ready', 'not implemented yet');
    ladder.skip(
      'profile_linked',
      'Profile linked to this device',
      'not implemented yet'
    );
  }

  const built = ladder.toReport({
    schema: 1,
    tool: { name: packageJson.name, version: packageJson.version },
    command: 'verify push',
    startedAt,
    finishedAt: new Date().toISOString(),
    project: {
      path: projectPath,
      framework: 'iOS',
      name: wiring.model.projectName,
    },
  });

  if (options.report) {
    await fs.writeFile(
      path.resolve(process.cwd(), options.report),
      `${JSON.stringify(built, null, 2)}\n`,
      'utf8'
    );
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(built, null, 2)}\n`);
  } else {
    process.stdout.write(ladder.render());
  }

  return built.exitCode;
}

/** Report a failure of the tool itself, which is never a verdict about the integration. */
function toolError(options: VerifyPushOptions, message: string): number {
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        { schema: 1, error: message, exitCode: EXIT.toolError },
        null,
        2
      )}\n`
    );
  } else {
    process.stderr.write(`${message}\n`);
  }
  return EXIT.toolError;
}

/** Accept either a project directory or the `.xcodeproj` itself. */
async function locateProject(root: string): Promise<string | undefined> {
  if (root.endsWith('.xcodeproj')) return root;

  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        entry.startsWith('.') ||
        entry === 'node_modules' ||
        entry === 'Pods'
      ) {
        continue;
      }
      const full = path.join(dir, entry);
      if (entry.endsWith('.xcodeproj')) {
        found.push(full);
        continue;
      }
      const stat = await fs.stat(full).catch(() => undefined);
      if (stat?.isDirectory()) await walk(full, depth + 1);
    }
  };

  await walk(root, 0);
  if (found.length === 0) return undefined;
  // The shallowest project: a sample app nested under a package is the common shape.
  found.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
  return found[0];
}
