import * as os from 'os';
import * as path from 'path';
import { ALL_STATES, AppState } from '../../platform/app_state';

export type VerifyPushOptions = {
  json: boolean;
  report?: string;
  appTarget?: string;
  configuration: string;
  target?: string;
  workspace?: string;
  platform?: string;
  appModule?: string;
  profile?: string;
  send: boolean;
  dryRun: boolean;
  resend: boolean;
  yes: boolean;
  quiet: boolean;
  verbose: boolean;
  package?: string;
  nonInteractive: boolean;
  observe: boolean;
  opened: boolean;
  link?: string;
  states?: string;
  evidence?: string;
};

export function parseStates(list?: string): AppState[] | undefined {
  if (!list) return undefined;
  const wanted = list
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean) as AppState[];
  const unknown = wanted.filter((state) => !ALL_STATES.includes(state));
  if (unknown.length > 0) {
    throw new Error(
      `unknown app state${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`
    );
  }
  return wanted;
}

export function evidenceDirectoryFor(options: VerifyPushOptions): string {
  return (
    options.evidence ??
    path.join(
      os.tmpdir(),
      `cio-verify-${new Date().toISOString().slice(0, 19)}`
    )
  );
}
