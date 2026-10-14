import { ReplayPart, replayCommand } from '../../core/replay';
import { ALL_STATES } from '../../platform/app_state';
import { PushFlags, VerifyPushOptions } from './options';
import { Selection } from './select';

/**
 * Push's run as flags: every answer, whether it was given, picked or the only one there was,
 * so the command repeats the run without a question. It names the depth, the workspace and
 * the device, which is also the go-ahead to send.
 */
export function pushRerun(input: {
  program: string;
  pathArg: string;
  level: string;
  options: VerifyPushOptions;
  flags: PushFlags;
  selection: Selection;
}): string {
  const { options, selection } = input;
  const parts: ReplayPart[] = [];
  if (input.pathArg && input.pathArg !== '.') parts.push(input.pathArg);
  parts.push(['--depth', input.level]);

  if (options.send) {
    const states = selection.states ?? ALL_STATES;
    const everyState =
      states.length === ALL_STATES.length &&
      ALL_STATES.every((state) => states.includes(state));
    if (!everyState) parts.push(['--app-states', states.join(',')]);
    if (options.opened) parts.push('--check-opens');
    if (options.link) parts.push(['--deep-link', options.link]);
    if (options.dryRun) parts.push('--dry-run');
    if (!options.resend) parts.push('--no-retry');
  }

  const workspace = selection.resolution.workspace;
  if (workspace) parts.push(['--workspace', workspace.id]);
  if (selection.targetSelector) {
    parts.push(['--device', selection.targetSelector]);
  }
  if (options.platform) parts.push(['--platform', options.platform]);
  if (selection.appTargetName && selection.appTargetSource !== 'only one') {
    parts.push(['--ios-target', selection.appTargetName]);
  }
  if (options.configuration !== 'Debug') {
    parts.push(['--ios-configuration', options.configuration]);
  }
  if (options.appModule) parts.push(['--android-module', options.appModule]);
  if (selection.packageName && selection.packageSource !== 'only one') {
    parts.push(['--android-app-id', selection.packageName]);
  }
  if (options.profile) parts.push(['--cio-profile', options.profile]);
  if (options.observe) parts.push('--watch-registration');
  if (input.flags.evidenceDir) {
    parts.push(['--evidence-dir', input.flags.evidenceDir]);
  }
  return replayCommand(input.program, parts);
}
