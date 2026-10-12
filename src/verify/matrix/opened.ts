import * as path from 'path';
import { stopwatch } from '../clock';
import { run } from '../exec';
import { waitForTitle } from './notifications';
import { probeLocalDelivery } from './probe';
import { Target } from '../ios/device';
import { Asker } from '../prompt';
import { CellHandle, Reporter } from '../report';
import { MatrixCell, MatrixSection, Verdict } from '../types';
import { LogCapture, startCapture } from './logs';
import { eachState, rejectedCell, sendVerifyPush } from './send';
import { AppState, setAppState } from './states';

/**
 * The half of push verification that cannot be automated.
 *
 * `delivered` is reported by the extension with nobody watching, which is why the whole
 * matrix runs unattended. `opened` is reported only when a notification is genuinely
 * tapped, and there is no supported way to synthesise that tap: `simctl` has no tap
 * command, and `simctl openurl` invokes the URL directly without ever entering the SDK's
 * click path — so it proves the app can route a URL and nothing at all about push.
 *
 * So this section asks. A person taps, presses Enter, and the run reads what the SDK did
 * with the tap out of the log. Non-interactively the whole section is a skip with its own
 * exit code, never a pass: a silently skipped tap looks exactly like a passing one in a
 * green pipeline, and that is the one confusion worth refusing outright.
 */
export const OPENED_MARKERS = {
  /** The OS handed the click to the SDK at all. */
  clicked: /Clicked (?:notification for message|CIO push message)/,
  /** The metric itself, which is the assertion this section makes. */
  tracked: /Tracking push message opened with deliveryId: (\S+)/,
  /** The SDK saw a click it decided was not ours. */
  foreign: /Clicked non CIO push message/,
  emptyId: /Clicked message with empty deliveryId/,
  /** Deep link: attempted, then one of four outcomes, then the failure. */
  linkHandling: /Handling push notification deep link with url: (\S+)/,
  linkHandled:
    /Deep link handled by (?:host app callback implementation|internal host app navigation|system)/,
  linkUnhandled: /Deep link was not handled/,
};

/** Only the states where a banner exists to tap. */
export const OPENED_STATES: AppState[] = ['killed', 'background'];

export interface OpenedOptions {
  target: Target;
  bundleId: string;
  environmentId: string;
  token: string;
  sandbox: boolean;
  provider: 'apns' | 'fcm';
  /** The URL the app is expected to route. Must be one the app actually claims. */
  link: string;
  states?: AppState[];
  processNames?: string[];
  evidenceDirectory?: string;
  asker: Asker;
  reporter?: Reporter;
  /** How long to leave the tap prompt open. Longer than a picker: a person has to look. */
  tapTimeoutMs?: number;
}

const TAP_TIMEOUT_MS = 180_000;
/** Matches the delivered matrix: long enough that a slow simulator is not a failure. */
const ARRIVAL_TIMEOUT_MS = 45_000;
const AFTER_TAP_MS = 6_000;

export async function runOpenedMatrix(
  options: OpenedOptions
): Promise<MatrixSection> {
  const states = options.states ?? OPENED_STATES;
  const section: MatrixSection = { metric: 'opened', cells: [] };

  if (!options.asker.interactive) {
    section.skipped =
      'opened needs a real tap, and this run cannot ask for one — run it in a terminal';
    return section;
  }

  const capture = await startCapture(
    options.target,
    options.evidenceDirectory,
    options.processNames ?? []
  );
  options.reporter?.matrix(capture.how, 'opened');
  const sectionTimer = stopwatch();

  try {
    if (capture.available) await sleep(2_500);
    section.cells = await eachState(
      states,
      async (state) => {
        const handle = options.reporter?.cell(state);
        const cell = await runOpenedCell(state, options, capture, handle);
        // Closing the handle is what prints the result. Without it the cells ran, the
        // taps were read correctly, and the run said nothing about either.
        handle?.done(cell);
        return cell;
      },
      { pauseMs: 4_000, reporter: options.reporter }
    );
  } finally {
    await capture.stop();
    section.durationMs = sectionTimer();
    section.logs = {
      how: capture.how,
      evidencePath: capture.evidencePath,
      unavailableReason: capture.unavailableReason,
    };
  }

  return section;
}

async function runOpenedCell(
  state: AppState,
  options: OpenedOptions,
  capture: LogCapture,
  handle?: CellHandle
): Promise<MatrixCell> {
  const evidence: string[] = [];

  handle?.phase('staging the app state');
  const staged = await setAppState(
    options.target,
    options.bundleId,
    state,
    options.processNames?.[0]
  );
  evidence.push(`state via ${staged.how}`);

  const mark = capture.mark();
  const sinceMs = Date.now() - 1_000;
  const title = `cio verify · tap me · ${state}`;
  handle?.phase('sending');
  const sent = await sendVerifyPush({
    environmentId: options.environmentId,
    token: options.token,
    sandbox: options.sandbox,
    platform: 'ios',
    provider: options.provider,
    title,
    body: 'Tap this notification to verify the opened metric.',
    link: options.link,
  });

  if (!sent.accepted) return rejectedCell(state, sent, evidence);
  evidence.push(`sent with link ${options.link}`);

  // Wait for the notification to land before asking anyone to tap it.
  //
  // Prompting straight after the send was wrong twice over: it asked for a tap while the
  // banner was still in flight, so by the time a person read the prompt and looked, the
  // banner had auto-dismissed and the screen was idle — and when the push never arrived
  // at all it asked for something impossible, then waited three minutes for it. Waiting
  // for arrival first puts the question on screen while the banner is live.
  handle?.phase('waiting for the notification to land');
  const arrived = await waitForTitle({
    target: options.target,
    title,
    timeoutMs: ARRIVAL_TIMEOUT_MS,
    sinceMs,
  });
  if (arrived === false) {
    const probe = await probeLocalDelivery({
      target: options.target,
      bundleId: options.bundleId,
    });
    return {
      state,
      verdict: probe.result === 'absent' ? 'skip' : 'fail',
      cause:
        probe.result === 'absent'
          ? 'device.notifications_wedged'
          : 'runtime.push_never_arrived',
      evidence: [
        ...evidence,
        'nothing arrived, so nobody was asked to tap it',
        probe.evidence,
      ],
    };
  }
  if (arrived) evidence.push('notification landed');

  // A screenshot here is the cheapest record of what was actually on screen when the tap
  // was asked for, and on a simulator it costs nothing.
  const shot = await screenshot(
    options.target,
    options.evidenceDirectory,
    state
  );
  if (shot) evidence.push(`screen at the prompt: ${shot}`);

  // The one place this tool waits on a person. Said plainly, because a prompt nobody
  // understands is answered by pressing Enter without doing the thing.
  // The spinner has to come down first: it repaints over the question, and a prompt
  // nobody can read is a prompt nobody answers.
  options.reporter?.pause();
  const tapped = await options.asker.confirm(
    [
      `Tap the "${title}" notification on ${options.target.name}.`,
      'If the banner has gone, swipe down from the top edge to find it in Notification Centre.',
      'The app may not visibly change — the verdict comes from the log, not the screen.',
    ].join('\n  '),
    { timeoutMs: options.tapTimeoutMs ?? TAP_TIMEOUT_MS }
  );
  options.reporter?.resume();
  if (!tapped) {
    return {
      state,
      verdict: 'skip',
      cause: 'runtime.tap_not_confirmed',
      evidence: [...evidence, 'nobody confirmed the tap'],
    };
  }

  // The SDK's click path runs after the OS hands over the notification, which takes a
  // moment on a cold start.
  handle?.phase('reading what the SDK did with the tap');
  await sleep(AFTER_TAP_MS);

  const lines = capture.since(mark).map((line) => line.message);
  const seen = (marker: RegExp) => lines.some((line) => marker.test(line));
  const deliveryId = lines
    .map((line) => OPENED_MARKERS.tracked.exec(line)?.[1])
    .find(Boolean);

  if (capture.available) {
    evidence.push(
      `log: ${lines.length} lines, click seen: ${seen(
        OPENED_MARKERS.clicked
      )}, opened tracked: ${seen(
        OPENED_MARKERS.tracked
      )}, deep link handled: ${seen(OPENED_MARKERS.linkHandled)}`
    );
    if (deliveryId) evidence.push(`opened reported for ${deliveryId}`);
  } else {
    evidence.push(`no log capture: ${capture.unavailableReason}`);
  }

  return {
    state,
    deliveryId,
    ...judgeOpened({
      available: capture.available,
      clicked: seen(OPENED_MARKERS.clicked),
      tracked: seen(OPENED_MARKERS.tracked),
      foreign: seen(OPENED_MARKERS.foreign),
      emptyId: seen(OPENED_MARKERS.emptyId),
      linkAttempted: seen(OPENED_MARKERS.linkHandling),
      linkHandled: seen(OPENED_MARKERS.linkHandled),
      linkUnhandled: seen(OPENED_MARKERS.linkUnhandled),
    }),
    evidence,
  };
}

/**
 * Pure, like the delivered judge, and for the same reason: every wrong verdict this
 * project has produced came from reading evidence, never from deciding on it.
 */
export function judgeOpened(observed: {
  available: boolean;
  clicked: boolean;
  tracked: boolean;
  foreign: boolean;
  emptyId: boolean;
  linkAttempted: boolean;
  linkHandled: boolean;
  linkUnhandled: boolean;
}): { verdict: Verdict; cause?: string } {
  if (!observed.available) return { verdict: 'skip' };

  // Nothing at all: the tap did not reach the SDK. Could be the wrong notification, or a
  // banner that had already gone.
  if (!observed.clicked && !observed.tracked) {
    return observed.foreign
      ? { verdict: 'fail', cause: 'runtime.tap_not_ours' }
      : { verdict: 'skip', cause: 'runtime.tap_not_seen' };
  }
  if (observed.emptyId) {
    return { verdict: 'fail', cause: 'runtime.opened_without_delivery_id' };
  }
  if (!observed.tracked) {
    return { verdict: 'fail', cause: 'runtime.opened_not_tracked' };
  }
  // The metric landed. The deep link is a second, independent claim: a push that counts an
  // open but routes nowhere is a real defect, and a common one.
  if (
    observed.linkUnhandled ||
    (observed.linkAttempted && !observed.linkHandled)
  ) {
    return { verdict: 'fail', cause: 'runtime.deep_link_not_handled' };
  }
  if (!observed.linkAttempted) {
    return { verdict: 'warn', cause: 'runtime.deep_link_absent' };
  }
  return { verdict: 'pass' };
}

/** Best effort: skipped silently wherever it is unavailable. */
async function screenshot(
  target: Target,
  directory: string | undefined,
  state: AppState
): Promise<string | undefined> {
  if (!directory || target.kind !== 'simulator') return undefined;
  const file = path.join(directory, `opened-${state}.png`);
  const { code } = await run('xcrun', [
    'simctl',
    'io',
    target.udid,
    'screenshot',
    file,
  ]);
  return code === 0 ? file : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
