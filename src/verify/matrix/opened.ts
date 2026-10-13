import * as path from 'path';
import { stopwatch } from '../clock';
import { run } from '../exec';
import { waitForNotification } from './notifications';
import { probeLocalDelivery } from './probe';
import { Target } from '../ios/device';
import { Asker, TapAnswer } from '../prompt';
import { CellHandle, Reporter } from '../report';
import { MatrixCell, MatrixSection, Verdict } from '../types';
import {
  LogCapture,
  SDK_PUSH_LINE,
  blameStoppedCapture,
  explainSdkSilence,
  deliveryIdsIn,
  extensionRanIn,
  ranInExtension,
  startCapture,
} from './logs';
import { eachState, rejectedCell, sendVerifyPush } from './send';
import { AppState, setAppState } from './states';
import { pushTag, tapTitle } from './identity';

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
  /** The SDK handling the open, naming the delivery it belongs to. */
  tracked: /Tracking push message opened with deliveryId: (\S+)/,
  /** The SDK saw a click it decided was not ours. */
  foreign: /Clicked non CIO push message/,
  emptyId: /Clicked message with empty deliveryId/,
  /** Deep link: attempted, then one of four outcomes, then the failure. */
  linkHandling: /Handling push notification deep link with url: (\S+)/,
  linkHandled:
    /Deep link handled by (?:host app callback implementation|internal host app navigation|system)/,
  linkUnhandled: /Deep link was not handled/,
  /**
   * iOS itself handing the tap to the app, logged by UIKit in the app's own process. It
   * proves the tap happened whatever the SDK does next — on a phone, a cold launch from a
   * tap logged these and the SDK logged nothing, which the cell used to call a tap that
   * never arrived. (A simulator's capture is filtered to the SDK, so it never sees them.)
   */
  osDelivered:
    /Decode <UINotificationResponseAction|Received action\(s\) in scene-(?:create|update): <UINotificationResponseAction/,
};

/** Only the states where a banner exists to tap. */
export const OPENED_STATES: AppState[] = ['killed', 'background'];

/**
 * Why the tap test does not run though it was asked for, if it does not. A dry run comes
 * first: it skips the consent question because it sends nothing, so a tap test that went
 * ahead would send real pushes nobody agreed to. A provider that refused the delivered
 * sends as too frequent will refuse these too.
 */
export function openedSkipReason(options: {
  dryRun: boolean;
  rateLimited: boolean;
}): string | undefined {
  if (options.dryRun)
    return 'a dry run sends nothing, so there is nothing to tap';
  if (options.rateLimited) {
    return 'the provider was refusing sends, so no tap test was sent';
  }
  return undefined;
}

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
  /** The extension's process, whose lines are the OS's word that it ran. */
  extensionName?: string;
  evidenceDirectory?: string;
  asker: Asker;
  reporter?: Reporter;
  /** How long to leave the tap prompt open. Longer than a picker: a person has to look. */
  tapTimeoutMs?: number;
}

const TAP_TIMEOUT_MS = 180_000;
/** Matches the delivered matrix: long enough that a slow simulator is not a failure. */
const ARRIVAL_TIMEOUT_MS = 45_000;
/**
 * How long a tap's sequence gets to finish after the person confirms it. A fixed six
 * seconds was not enough on a phone: a cold start from the tap, or iOS replacing a frozen
 * process, took longer, and the next cell then suspended the app before it had said how the
 * deep link ended. The wait ends as soon as the sequence is complete.
 */
const TAP_SEQUENCE_TIMEOUT_MS = 30_000;
const TAP_POLL_MS = 500;

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
    options.processNames ?? [],
    options.extensionName
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
    section.cells = explainSdkSilence(
      section.cells,
      {
        appSpoke: capture.lines.length > 0,
        sdkSpoke: capture.lines.some((line) =>
          SDK_PUSH_LINE.test(line.message)
        ),
        how: "the app's processes logged",
      },
      options.reporter
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
  const title = tapTitle(state, pushTag());
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
  //
  // Arrival also says which delivery this push is, so the open can be matched to it: the
  // simulator's notification store holds the push's id; on a phone, the extension logs it
  // when the push lands.
  handle?.phase('waiting for the notification to land');
  const stored = await waitForNotification({
    target: options.target,
    title,
    timeoutMs: ARRIVAL_TIMEOUT_MS,
    sinceMs,
  });
  if (stored === false) {
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
  let expectedId = sent.deliveryId ?? (stored ? stored.deliveryId : undefined);
  let arrivalSeen = Boolean(stored);
  if (stored) {
    evidence.push(
      `arrived: in the notification store${
        stored.deliveryId ? `, delivery ${stored.deliveryId}` : ''
      }`
    );
  } else if (capture.available) {
    // A phone: the extension waking is the only sign the push landed.
    const ran = await waitFor(
      () => extensionRanIn(capture.since(mark), options.extensionName),
      ARRIVAL_TIMEOUT_MS
    );
    const ids = deliveryIdsIn(
      capture
        .since(mark)
        .filter((line) => ranInExtension([line], options.extensionName))
    );
    expectedId ??= ids.length === 1 ? ids[0] : undefined;
    arrivalSeen = ran;
    evidence.push(
      ran
        ? `the extension ran on it${
            ids.length === 1 ? `, delivery ${ids[0]}` : ''
          }`
        : "the phone's log never showed the push landing; asking for the tap anyway"
    );
  }

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
  const answer = await options.asker.askTap(
    [
      `Tap the "${title}" notification on ${options.target.name}.`,
      'If the banner has gone, swipe down from the top edge to find it in Notification Centre.',
      'The app may not visibly change — the verdict comes from the log, not the screen.',
    ].join('\n  '),
    { timeoutMs: options.tapTimeoutMs ?? TAP_TIMEOUT_MS }
  );
  options.reporter?.resume();
  if (answer !== 'tapped') {
    return untappedCell(state, answer, evidence, arrivalSeen);
  }

  // The SDK's click path runs after the OS hands over the notification, which takes a
  // moment on a cold start — so wait for the end of the sequence, not a fixed time.
  handle?.phase('reading what the SDK did with the tap');
  const afterTap = capture.mark();
  if (capture.available) {
    const deadline = Date.now() + TAP_SEQUENCE_TIMEOUT_MS;
    while (
      Date.now() < deadline &&
      !openedSequenceComplete(
        observeOpened(capture.since(mark).map((line) => line.message)).observed,
        { linkSent: Boolean(options.link) }
      )
    ) {
      await sleep(TAP_POLL_MS);
    }
  }

  const lines = capture.since(mark).map((line) => line.message);
  const { observed, deliveryId } = observeOpened(lines);
  const matched =
    expectedId && deliveryId ? deliveryId === expectedId : undefined;

  if (capture.available) {
    evidence.push(
      `log: ${lines.length} lines, click seen: ${observed.clicked}, opened tracked: ${observed.tracked}, deep link handled: ${observed.linkHandled}`
    );
    if (deliveryId) {
      evidence.push(
        matched === false
          ? `the SDK opened ${deliveryId}, which is not this push (${expectedId})`
          : `the SDK opened ${deliveryId}${matched ? ', this push' : ''}`
      );
    }
    if (observed.osDelivered && !observed.clicked) {
      const handed = capture
        .since(mark)
        .find((line) => OPENED_MARKERS.osDelivered.test(line.message));
      evidence.push(
        `iOS handed the tap to the app${
          handed ? ` at ${handed.at}` : ''
        }, and no SDK line for it reached the log`
      );
    }
  } else {
    evidence.push(`no log capture: ${capture.unavailableReason}`);
  }

  const judged: MatrixCell = {
    state,
    title,
    deliveryId: deliveryId ?? expectedId,
    ...judgeOpened({
      available: capture.available,
      lossy: capture.lossy,
      matched,
      ...observed,
    }),
    evidence,
  };
  const all = capture.since(mark);
  return explainUnseenTap(judged, {
    stoppedReason: capture.stoppedReason?.(),
    linesAfterTap: capture.since(afterTap).length,
    lastLineAt: all.length > 0 ? all[all.length - 1].at : undefined,
  });
}

/**
 * The cell for a tap prompt that did not end in a tap. "It never showed up" is only as
 * strong as the arrival evidence behind it: with the OS holding the push, delivery worked
 * and the banner is what went missing; with nothing showing arrival, the push may simply
 * never have come.
 */
export function untappedCell(
  state: AppState,
  answer: Exclude<TapAnswer, 'tapped'>,
  evidence: string[],
  arrivalSeen: boolean
): MatrixCell {
  if (answer === 'not_shown') {
    return {
      state,
      verdict: 'skip',
      cause: arrivalSeen ? 'runtime.banner_not_seen' : 'runtime.push_not_seen',
      evidence: [...evidence, 'the person asked to tap it saw no banner'],
    };
  }
  return {
    state,
    verdict: 'skip',
    cause: 'runtime.tap_not_confirmed',
    evidence: [
      ...evidence,
      answer === 'skipped'
        ? 'skipped at the prompt'
        : 'nobody answered the tap prompt',
    ],
  };
}

/**
 * A tap the SDK "did not see" is re-judged when the log can account for it: a capture that
 * stopped partway saw nothing because it was reading nothing, and a stream that produced
 * not one line after the tap, though it was busy before it, may have stalled — on a phone
 * the log relay has gone quiet mid-run without the reader exiting. Either way, telling the
 * person their tap did not arrive would be a guess presented as a finding.
 */
export function explainUnseenTap(
  cell: MatrixCell,
  context: {
    stoppedReason?: string;
    linesAfterTap: number;
    lastLineAt?: string;
  }
): MatrixCell {
  if (
    cell.cause !== 'runtime.tap_not_seen' &&
    cell.cause !== 'runtime.tap_lines_lost'
  ) {
    return cell;
  }
  if (context.stoppedReason) {
    return blameStoppedCapture(cell, context.stoppedReason, [
      'runtime.tap_not_seen',
      'runtime.tap_lines_lost',
    ]);
  }
  if (cell.cause !== 'runtime.tap_not_seen') return cell;
  if (context.linesAfterTap === 0 && context.lastLineAt) {
    return {
      ...cell,
      cause: 'runtime.capture_silent',
      evidence: [
        ...cell.evidence,
        `not one log line arrived after the tap; the last was at ${context.lastLineAt}`,
      ],
    };
  }
  return cell;
}

/**
 * Whether the SDK has finished with a tap: the open is tracked and, when a deep link was
 * started, its outcome is in — or the tap was refused outright. Until then the app is left
 * alone, because moving on to the next state suspends it mid-sequence.
 */
export function openedSequenceComplete(
  observed: ReturnType<typeof observeOpened>['observed'],
  options: { linkSent: boolean }
): boolean {
  if (observed.foreign || observed.emptyId || observed.linkUnhandled) {
    return true;
  }
  if (!observed.tracked) return false;
  // A push that carried a link is not finished until the link is: the open is tracked
  // first and the link is started after it, so "tracked and no link yet" is the middle of
  // the sequence, not its end. Moving on there suspended the app before it followed it.
  if (options.linkSent) return observed.linkHandled;
  return !observed.linkAttempted || observed.linkHandled;
}

/**
 * What the SDK's lines say happened to a tap. Pure, so it is tested against real captures.
 *
 * A handled deep link counts as the click: the SDK only follows a push's link from its
 * click path, and some builds follow it without printing "Clicked …" first.
 */
export function observeOpened(lines: string[]): {
  observed: Omit<Parameters<typeof judgeOpened>[0], 'available'>;
  deliveryId?: string;
} {
  const seen = (marker: RegExp) => lines.some((line) => marker.test(line));
  const deliveryId = lines
    .map((line) => OPENED_MARKERS.tracked.exec(line)?.[1])
    .find(Boolean);
  const linkAttempted = seen(OPENED_MARKERS.linkHandling);
  return {
    observed: {
      clicked: seen(OPENED_MARKERS.clicked) || linkAttempted,
      tracked: seen(OPENED_MARKERS.tracked),
      foreign: seen(OPENED_MARKERS.foreign),
      emptyId: seen(OPENED_MARKERS.emptyId),
      linkAttempted,
      linkHandled: seen(OPENED_MARKERS.linkHandled),
      linkUnhandled: seen(OPENED_MARKERS.linkUnhandled),
      osDelivered: seen(OPENED_MARKERS.osDelivered),
    },
    deliveryId,
  };
}

/**
 * Pure, like the delivered judge, and for the same reason: every wrong verdict this
 * project has produced came from reading evidence, never from deciding on it.
 *
 * Only positive evidence fails a cell. On a phone the log stream drops lines — during a
 * cold launch it lost the SDK's lines for seven taps the app's own record shows were all
 * handled — so a line that is missing there makes a cell inconclusive, never failed.
 */
export function judgeOpened(observed: {
  available: boolean;
  /** The capture can drop lines (a phone's), so a missing line proves nothing. */
  lossy?: boolean;
  /** The open names this push (true), another push (false), or cannot be matched. */
  matched?: boolean;
  clicked: boolean;
  tracked: boolean;
  foreign: boolean;
  emptyId: boolean;
  linkAttempted: boolean;
  linkHandled: boolean;
  linkUnhandled: boolean;
  /** iOS logged handing the tap to the app (phone captures only). */
  osDelivered?: boolean;
}): { verdict: Verdict; cause?: string } {
  if (!observed.available) return { verdict: 'skip' };

  if (!observed.clicked && !observed.tracked) {
    if (observed.foreign)
      return { verdict: 'fail', cause: 'runtime.tap_not_ours' };
    // iOS says the tap reached the app, and not one SDK line for it reached the log.
    if (observed.osDelivered) {
      return { verdict: 'skip', cause: 'runtime.tap_lines_lost' };
    }
    return { verdict: 'skip', cause: 'runtime.tap_not_seen' };
  }
  // The open belongs to a different push — an older banner, usually — so it says nothing
  // about this one.
  if (observed.matched === false) {
    return { verdict: 'skip', cause: 'runtime.tap_other_push' };
  }
  if (observed.emptyId) {
    return { verdict: 'fail', cause: 'runtime.opened_without_delivery_id' };
  }
  if (!observed.tracked) {
    return observed.lossy
      ? { verdict: 'skip', cause: 'runtime.tap_lines_lost' }
      : { verdict: 'fail', cause: 'runtime.opened_not_tracked' };
  }
  // The open was handled. The deep link is a second, independent claim: a push that opens
  // but routes nowhere is a real defect, and a common one — when the SDK says so.
  if (observed.linkUnhandled) {
    return { verdict: 'fail', cause: 'runtime.deep_link_not_handled' };
  }
  // Started and never finished is not the same claim. On a phone the app was suspended by
  // the next cell before it said how the link ended; silence convicted nothing.
  if (observed.linkAttempted && !observed.linkHandled) {
    return { verdict: 'warn', cause: 'runtime.deep_link_outcome_unseen' };
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

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(TAP_POLL_MS);
  }
  return predicate();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
