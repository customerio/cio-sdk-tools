import { run } from '../exec';
import { Target } from '../ios/device';

export type AppState = 'foreground' | 'background' | 'killed';

export const ALL_STATES: AppState[] = ['killed', 'background', 'foreground'];

export interface StateResult {
  ok: boolean;
  /** How the state was reached, which matters for how much the cell proves. */
  how: string;
  error?: string;
}

/** Launching another app is the only way to background the target on a simulator. */
const BACKGROUND_FOIL = 'com.apple.Preferences';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function setAppState(
  target: Target,
  bundleId: string,
  state: AppState
): Promise<StateResult> {
  return target.kind === 'simulator'
    ? simulatorState(target, bundleId, state)
    : deviceState(target, bundleId, state);
}

async function simulatorState(
  target: Target,
  bundleId: string,
  state: AppState
): Promise<StateResult> {
  if (state === 'killed') {
    const { code, stderr } = await run(
      'xcrun',
      ['simctl', 'terminate', target.udid, bundleId],
      60_000
    );
    // Terminating something already dead is a success for our purposes.
    return {
      ok: true,
      how: 'simctl terminate',
      error: code === 0 ? undefined : stderr.trim().split('\n')[0],
    };
  }

  const launch = await run(
    'xcrun',
    ['simctl', 'launch', target.udid, bundleId],
    120_000
  );
  if (launch.code !== 0) {
    return {
      ok: false,
      how: 'simctl launch',
      error: launch.stderr.trim().split('\n')[0],
    };
  }
  await sleep(3_000);

  if (state === 'background') {
    await run(
      'xcrun',
      ['simctl', 'launch', target.udid, BACKGROUND_FOIL],
      60_000
    );
    await sleep(2_000);
    return { ok: true, how: `simctl launch ${BACKGROUND_FOIL} over the app` };
  }

  return { ok: true, how: 'simctl launch' };
}

async function deviceState(
  target: Target,
  bundleId: string,
  state: AppState
): Promise<StateResult> {
  if (state === 'killed') {
    const pid = await devicePid(target, bundleId);
    if (!pid) return { ok: true, how: 'process was not running' };
    const { code, stderr } = await run(
      'xcrun',
      [
        'devicectl',
        'device',
        'process',
        'terminate',
        '--device',
        target.udid,
        '--pid',
        pid,
      ],
      120_000
    );
    return {
      ok: code === 0,
      how: 'devicectl process terminate',
      error: code === 0 ? undefined : stderr.trim().split('\n')[0],
    };
  }

  const launch = await run(
    'xcrun',
    [
      'devicectl',
      'device',
      'process',
      'launch',
      '--device',
      target.udid,
      bundleId,
    ],
    180_000
  );
  if (launch.code !== 0) {
    return {
      ok: false,
      how: 'devicectl process launch',
      error: launch.stderr.trim().split('\n')[0],
    };
  }
  await sleep(4_000);

  if (state === 'background') {
    const pid = await devicePid(target, bundleId);
    if (!pid) {
      return {
        ok: false,
        how: 'devicectl process suspend',
        error: 'no pid to suspend',
      };
    }
    const { code, stderr } = await run(
      'xcrun',
      [
        'devicectl',
        'device',
        'process',
        'suspend',
        '--device',
        target.udid,
        '--pid',
        pid,
      ],
      120_000
    );
    // Worth naming in the report: suspend stops the process rather than sending the app
    // through the lifecycle, so the app may never see applicationDidEnterBackground.
    return {
      ok: code === 0,
      how: 'devicectl process suspend (process-level, not a lifecycle transition)',
      error: code === 0 ? undefined : stderr.trim().split('\n')[0],
    };
  }

  return { ok: true, how: 'devicectl process launch' };
}

async function devicePid(
  target: Target,
  bundleId: string
): Promise<string | undefined> {
  const { stdout, code } = await run(
    'xcrun',
    ['devicectl', 'device', 'info', 'processes', '--device', target.udid],
    180_000
  );
  if (code !== 0) return undefined;
  const line = stdout
    .split('\n')
    .find(
      (entry) => entry.includes(`${bundleId}`) || entry.includes(`/${bundleId}`)
    );
  return line?.trim().split(/\s+/)[0];
}
