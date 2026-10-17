import * as os from 'os';
import * as path from 'path';
import { ALL_STATES, AppState } from '../../platform/app_state';

/** The `verify push` flags, as commander hands them over. */
export interface PushFlags {
  depth?: string;
  appStates?: string;
  checkOpens?: boolean;
  deepLink?: string;
  dryRun?: boolean;
  retry?: boolean;
  watchRegistration?: boolean;
  evidenceDir?: string;
  workspace?: string;
  device?: string;
  cioProfile?: string;
  platform?: string;
  iosTarget?: string;
  iosConfiguration?: string;
  androidModule?: string;
  androidAppId?: string;
}

/**
 * What push's flows run with, settled from the flags and the answers. Each field is named
 * for what it does inside the run, not for the flag that set it.
 */
export type VerifyPushOptions = {
  appTarget?: string;
  configuration: string;
  target?: string;
  workspace?: string;
  platform?: string;
  appModule?: string;
  package?: string;
  profile?: string;
  /** The level sends real pushes. */
  send: boolean;
  /** The level reads Customer.io's record of each push and judges it. */
  recorded: boolean;
  dryRun: boolean;
  /** A push that never arrived is sent once more. */
  resend: boolean;
  /** Watch the install, token and login happen instead of reading what they left. */
  observe: boolean;
  /** A person taps the pushes, so the open and the deep link are checked too. */
  opened: boolean;
  link?: string;
  states?: string;
  evidence?: string;
  /**
   * The command line named the depth, the workspace and the device: the go-ahead to send
   * without asking.
   */
  named: boolean;
};

/** The flags that only mean something when pushes are sent; each implies on-device. */
export const SENDING_FLAGS: [keyof PushFlags, string][] = [
  ['appStates', '--app-states'],
  ['checkOpens', '--check-opens'],
  ['deepLink', '--deep-link'],
  ['dryRun', '--dry-run'],
  ['retry', '--no-retry'],
];

export function settingsFrom(flags: PushFlags): VerifyPushOptions {
  return {
    appTarget: flags.iosTarget,
    configuration: flags.iosConfiguration ?? 'Debug',
    target: flags.device,
    workspace: flags.workspace,
    platform: flags.platform,
    appModule: flags.androidModule,
    package: flags.androidAppId,
    profile: flags.cioProfile,
    send: false,
    recorded: false,
    dryRun: Boolean(flags.dryRun),
    resend: flags.retry !== false,
    observe: Boolean(flags.watchRegistration),
    opened: Boolean(flags.checkOpens),
    link: flags.deepLink,
    states: flags.appStates,
    evidence: flags.evidenceDir,
    named: false,
  };
}

export function parseStates(list?: string): AppState[] | undefined {
  if (!list) return undefined;
  const wanted = list
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean) as AppState[];
  const unknown = wanted.filter((state) => !ALL_STATES.includes(state));
  if (unknown.length > 0) {
    throw new Error(
      `unknown app state${unknown.length > 1 ? 's' : ''}: ${unknown.join(
        ', '
      )} — --app-states takes ${ALL_STATES.join(', ')}`
    );
  }
  return wanted;
}

export function evidenceDirectoryFor(options: VerifyPushOptions): string {
  return (
    options.evidence ??
    path.join(os.tmpdir(), `cio-verify-${localStamp(new Date())}`)
  );
}

/**
 * `2026-10-15T23:15:06` in the machine's own time, which is what the device log and the
 * person's clock show: a folder named in UTC read four hours off against both.
 */
export function localStamp(at: Date): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(
    at.getDate()
  )}T${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
}
