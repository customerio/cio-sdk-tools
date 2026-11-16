import { run } from '../../core/exec';

/**
 * Whether a simulator's push service is connected to Apple's push servers.
 *
 * Every push reaches a device down one connection its `apsd` keeps open to Apple. When that
 * connection drops and does not come back, Apple still accepts every send, keeps only the
 * latest push for each app until the device reconnects, and nothing arrives: from the sending
 * side it looks exactly like a broken integration.
 *
 * A simulator has no tool that reports the connection, but `apsd` logs it as "Connected on N
 * interfaces" whenever it adjusts it: at every retry while it is down (every seven minutes)
 * and whenever an app launches or changes state while it is up. So the last such line in the
 * last ten minutes is the state now, and no line means it cannot be told.
 */
export interface PushServiceState {
  connected: boolean;
  /** When `apsd` said so, as its log printed it. */
  at: string;
  said: string;
}

const WINDOW = '10m';

export async function simulatorPushService(
  udid: string
): Promise<PushServiceState | undefined> {
  const { stdout, code } = await run(
    'xcrun',
    [
      'simctl',
      'spawn',
      udid,
      'log',
      'show',
      '--last',
      WINDOW,
      '--style',
      'compact',
      '--predicate',
      'process == "apsd" AND eventMessage CONTAINS "Connected on"',
    ],
    30_000
  );
  return code === 0 ? lastPushServiceState(stdout) : undefined;
}

/**
 * The last word in `apsd`'s log about its sandbox ("development") connection, the one a
 * simulator's pushes come down.
 */
export function lastPushServiceState(
  log: string
): PushServiceState | undefined {
  let last: PushServiceState | undefined;
  for (const line of log.split('\n')) {
    if (!/\bdevelopment\b/.test(line)) continue;
    const match = /Connected on (\d+) interfaces/.exec(line);
    if (!match) continue;
    last = {
      connected: Number(match[1]) > 0,
      at: /^\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2})/.exec(line)?.[1] ?? '',
      said: match[0],
    };
  }
  return last;
}

/** One line of evidence: what the push service said, and when. */
export function describePushService(state: PushServiceState): string {
  return `the simulator's push service last said "${state.said}"${
    state.at ? ` at ${state.at}` : ''
  }: ${
    state.connected
      ? "it is connected to Apple's push servers"
      : "it has no connection to Apple's push servers"
  }`;
}

/** The command that restarts a simulator, which brings its push service back. */
export function restartSimulator(udid: string): string {
  return `xcrun simctl shutdown ${udid} && xcrun simctl boot ${udid}`;
}
