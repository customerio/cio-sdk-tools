import { stopwatch } from '../clock';
import { Target } from '../ios/device';
import { Asker } from '../prompt';
import { CellHandle, Reporter } from '../report';
import { MatrixCell, MatrixSection, Verdict } from '../types';
import { LogCapture, startCapture } from './logs';
import { sendVerifyPush } from './send';
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
    for (const state of states) {
      const handle = options.reporter?.cell(state);
      const cellTimer = stopwatch();
      const cell = await runOpenedCell(state, options, capture, handle);
      cell.durationMs = cellTimer();
      section.cells.push(cell);
      await sleep(4_000);
    }
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

  const mark = capture.lines.length;
  handle?.phase('sending');
  const sent = await sendVerifyPush({
    environmentId: options.environmentId,
    token: options.token,
    sandbox: options.sandbox,
    platform: 'ios',
    provider: options.provider,
    title: `cio verify · tap me · ${state}`,
    body: 'Tap this notification to verify the opened metric.',
    link: options.link,
  });

  if (!sent.accepted) {
    return {
      state,
      verdict: 'fail',
      cause: 'send.provider_rejected',
      evidence: [
        ...evidence,
        `send rejected: ${sent.error ?? 'unknown error'}`,
      ],
    };
  }
  evidence.push(`sent with link ${options.link}`);

  // The one place this tool waits on a person. Said plainly, because a prompt nobody
  // understands is answered by pressing Enter without doing the thing.
  const tapped = await options.asker.confirm(
    `Tap the "${`cio verify · tap me · ${state}`}" notification on ${
      options.target.name
    }, then press Enter`,
    { timeoutMs: options.tapTimeoutMs ?? TAP_TIMEOUT_MS }
  );
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

  const lines = capture.lines.slice(mark).map((line) => line.message);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
