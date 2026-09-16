import { Command } from 'commander';
import { promises as fs } from 'fs';
import * as path from 'path';
import { cioContext } from './cio/cli';
import { Ladder } from './ladder';
import { deviceReady, gatherDevice } from './rungs/device_ready';
import { profileLinked } from './rungs/profile_linked';
import { projectWiring } from './rungs/project_wiring';
import { gatherWorkspace, workspaceReady } from './rungs/workspace_ready';
import { EXIT, Report, RungId } from './types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require('../../package.json');

type VerifyPushOptions = {
  json: boolean;
  report?: string;
  appTarget?: string;
  configuration: string;
  target?: string;
  workspace?: string;
};

const RUNG_TITLES: Record<RungId, string> = {
  project_wiring: 'Project wiring',
  workspace_ready: 'Workspace ready',
  device_ready: 'Device ready',
  profile_linked: 'Profile linked to this device',
};

/**
 * `verify push` is the deterministic half of push verification. Its whole reason to exist
 * is that an agent asked "did push work?" will answer yes from a clean build — so the
 * answer has to come from evidence, with a stable name for whatever went wrong.
 *
 * Preflight (this command today) proves the integration *could* report a push. The runtime
 * matrix that proves one actually was is the next step, and deliberately separate.
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
  .option('--target <name|udid>', 'simulator or device to verify against')
  .option(
    '--workspace <id>',
    'workspace (environment) id, skipping auto-selection'
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
  const projectName = await climb(ladder, projectPath, options);

  const built = ladder.toReport({
    schema: 1,
    tool: { name: packageJson.name, version: packageJson.version },
    command: 'verify push',
    startedAt,
    finishedAt: new Date().toISOString(),
    project: { path: projectPath, framework: 'iOS', name: projectName },
  });

  await emit(built, ladder, options);
  return built.exitCode;
}

/**
 * The climb itself. Each rung is adopted in the order it is reported, and the first failure
 * turns the rest into explicit skips — a later rung's answer is not merely unknown after an
 * early failure, it is meaningless.
 */
async function climb(
  ladder: Ladder,
  projectPath: string,
  options: VerifyPushOptions
): Promise<string | undefined> {
  const wiring = await projectWiring({
    projectPath,
    scanRoot: path.dirname(projectPath),
    configuration: options.configuration,
    appTargetName: options.appTarget,
  });
  ladder.adopt(wiring.rung);
  if (ladder.halted) {
    skipRest(ladder, ['workspace_ready', 'device_ready', 'profile_linked']);
    return wiring.model.projectName;
  }

  // The device is read before the workspace rung is evaluated, though it is reported after
  // it: the siteId the SDK stored on the device is the only thing tying this build to a
  // workspace, so rung 2's subject comes out of rung 3's evidence.
  const device = await gatherDevice({
    bundleId: wiring.bundleId,
    selector: options.target,
  });

  try {
    const cio = await cioContext();
    const workspace = await gatherWorkspace({
      cio,
      explicit: options.workspace,
      siteId: device.sdk?.siteId,
      cacheKey: projectPath,
    });
    ladder.adopt(workspaceReady(workspace, wiring.apsEnvironment));
    if (ladder.halted) {
      skipRest(ladder, ['device_ready', 'profile_linked']);
      return wiring.model.projectName;
    }

    ladder.adopt(deviceReady(device, wiring.bundleId));
    if (ladder.halted) {
      skipRest(ladder, ['profile_linked']);
      return wiring.model.projectName;
    }

    ladder.adopt(
      await profileLinked({
        cio,
        environmentId: workspace.resolution?.workspace?.id,
        userId: device.sdk?.userId,
        anonymousId: device.sdk?.anonymousId,
        token: device.sdk?.pushDeviceToken,
        bundleId: wiring.bundleId,
      })
    );
    return wiring.model.projectName;
  } finally {
    // Anything pulled off a physical device lives in a temp directory.
    await device.cleanup?.();
  }
}

function skipRest(ladder: Ladder, ids: RungId[]): void {
  for (const id of ids) {
    ladder.skip(id, RUNG_TITLES[id], 'an earlier rung failed');
  }
}

async function emit(
  built: Report,
  ladder: Ladder,
  options: VerifyPushOptions
): Promise<void> {
  if (options.report) {
    await fs.writeFile(
      path.resolve(process.cwd(), options.report),
      `${JSON.stringify(built, null, 2)}\n`,
      'utf8'
    );
  }
  process.stdout.write(
    options.json ? `${JSON.stringify(built, null, 2)}\n` : ladder.render()
  );
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
