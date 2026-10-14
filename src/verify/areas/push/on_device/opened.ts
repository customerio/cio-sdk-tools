import * as path from 'path';
import { run } from '../../../core/exec';
import { Target } from '../../../platform/ios/device';
import { Asker, TapAnswer } from '../../../core/prompt';
import { CellHandle, Reporter } from '../../../core/report/render';
import { Verdict } from '../../../core/report/types';
import { MatrixCell } from '../types';
import { LogCapture, StreamAgreement } from '../../../platform/logs';
import {
  WINDOW_SIZE as WATCHED,
  WindowOutcome,
  openPidWindow,
} from '../../../platform/ios/pid_window';
import { RecordedOpen, readRecordedOpen } from './recorded';
import { blameStoppedCapture } from './sdk_lines';
import { AppState } from '../../../platform/app_state';

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
 * first: it skips the go-ahead because it sends nothing, so a tap test that went ahead
 * would send real pushes nobody agreed to. A tap needs someone to ask; a deep link is
 * optional, and without one the open is still checked.
 */
export function openedSkipReason(options: {
  dryRun: boolean;
  rateLimited?: boolean;
  interactive?: boolean;
}): string | undefined {
  if (options.dryRun)
    return 'a dry run sends nothing, so there is nothing to tap';
  if (options.interactive === false) {
    return 'opened needs a real tap, and this run cannot ask for one — run it in a terminal';
  }
  if (options.rateLimited) {
    return 'the provider was refusing sends, so no tap test was sent';
  }
  return undefined;
}

/**
 * Which states get a tap, and how. Each tap is on the push that state's delivered check sent:
 * one push per state, so the notification list holds one banner per state rather than a
 * delivered push and a tap-test push side by side.
 */
export interface TapPlan {
  asker: Asker;
  /**
   * The URL the pushes carry, which the app is expected to route. Without one the open is
   * checked and where the tap goes is not.
   */
  link?: string;
  /** The states that get a tap; always a subset of the states that get a push. */
  states: AppState[];
  /** How long to leave the tap prompt open. Longer than a picker: a person has to look. */
  tapTimeoutMs?: number;
}

/** The push a delivered cell sent, which that state's tap test then asks for. */
export interface SentPush {
  title: string;
  /** Its delivery id, when the send, the OS or the extension said what it is. */
  expectedId?: string;
  /** Something other than the tap showed the push arrive. */
  arrivalSeen: boolean;
  /** Where this push's lines begin in the capture. */
  mark: number;
  /**
   * The ids the sends returned, a re-send's included. Only these are kept by Customer.io, so
   * only these can be read back; ids from the log are the payload's and are not stored.
   */
  recordedIds?: string[];
}

export const TAP_TIMEOUT_MS = 180_000;
/**
 * How long a tap's sequence gets to finish after the person confirms it. A fixed six
 * seconds was not enough on a phone: a cold start from the tap, or iOS replacing a frozen
 * process, took longer, and the next cell then suspended the app before it had said how the
 * deep link ended. The wait ends as soon as the sequence is complete.
 */
const TAP_SEQUENCE_TIMEOUT_MS = 30_000;
const TAP_POLL_MS = 500;

/**
 * Ask for a tap on the push a delivered cell just sent, and read what the SDK did with it.
 *
 * Asked straight after the push is seen to arrive, so the banner is usually still on screen.
 * Prompting before arrival was wrong twice over: the banner was still in flight, and when the
 * push never came it asked for something impossible.
 */
export async function tapIosPush(
  state: AppState,
  push: SentPush,
  options: {
    target: Target;
    tap: TapPlan;
    evidenceDirectory?: string;
    reporter?: Reporter;
    /** The app's process name, so a launch from the tap can be caught on a phone. */
    appProcess?: string;
    /** The workspace the push went through, where Customer.io's record of it is read. */
    environmentId?: string;
    /** Read Customer.io's record of the open; replaced in tests. */
    readRecorded?: typeof readRecordedOpen;
  },
  capture: LogCapture,
  handle?: CellHandle
): Promise<MatrixCell> {
  const evidence: string[] = [
    `the push this state's delivered check sent, "${push.title}"${
      push.expectedId ? `, delivery ${push.expectedId}` : ''
    }`,
  ];

  // A screenshot here is the cheapest record of what was actually on screen when the tap
  // was asked for, and on a simulator it costs nothing.
  const shot = await screenshot(
    options.target,
    options.evidenceDirectory,
    state
  );
  if (shot) evidence.push(`screen at the prompt: ${shot}`);

  // Watching before the question, so a tap is never made before it can be caught.
  const cold = await catchColdLaunch(state, options, capture, handle);

  // The one place this tool waits on a person. Said plainly, because a prompt nobody
  // understands is answered without doing the thing. The spinner has to come down first:
  // it repaints over the question, and a prompt nobody can read is a prompt nobody answers.
  options.reporter?.pause();
  let answer: TapAnswer;
  try {
    answer = await options.tap.asker.askTap(
      [
        `Tap the "${push.title}" notification on ${options.target.name}.`,
        'If the banner has gone, swipe down from the top edge to find it in Notification Centre.',
        'The app may not visibly change — the verdict comes from the log, not the screen.',
      ].join('\n  '),
      { timeoutMs: options.tap.tapTimeoutMs ?? TAP_TIMEOUT_MS }
    );
  } catch (error) {
    await cold?.finish();
    throw error;
  }
  options.reporter?.resume();
  if (answer !== 'tapped') {
    await cold?.finish();
    return untappedCell(state, answer, evidence, push.arrivalSeen);
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
        observeOpened(capture.since(push.mark).map((line) => line.message))
          .observed,
        { linkSent: Boolean(options.tap.link) }
      )
    ) {
      await sleep(TAP_POLL_MS);
    }
  }

  const launch = await cold?.finish();
  if (launch) evidence.push(launch.evidence);

  // Read from the push's own start, not from the answer: people tap first and answer after,
  // so the SDK's lines for the tap usually come before the prompt is answered. Nothing in
  // the delivered check's lines reads as a tap.
  const lines = capture.since(push.mark).map((line) => line.message);
  const { observed, deliveryId } = observeOpened(lines);
  const matched =
    push.expectedId && deliveryId ? deliveryId === push.expectedId : undefined;

  if (capture.available) {
    evidence.push(
      `log: ${lines.length} lines, click seen: ${observed.clicked}, opened tracked: ${observed.tracked}, deep link handled: ${observed.linkHandled}`
    );
    if (!options.tap.link) {
      evidence.push(
        'no deep link was sent, so where the tap goes was not checked'
      );
    }
    if (deliveryId) {
      evidence.push(
        matched === false
          ? `the SDK opened ${deliveryId}, which is not this push (${push.expectedId})`
          : `the SDK opened ${deliveryId}${matched ? ', this push' : ''}`
      );
    }
    if (observed.osDelivered && !observed.clicked) {
      const handed = capture
        .since(push.mark)
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
    title: push.title,
    deliveryId: deliveryId ?? push.expectedId,
    ...judgeOpened({
      available: capture.available,
      // A launch read from its first line has lost nothing, so what is missing is missing.
      lossy: launch?.complete ? false : capture.lossy,
      matched,
      linkSent: Boolean(options.tap.link),
      ...observed,
    }),
    evidence,
  };
  const all = capture.since(push.mark);
  const explained = explainUnseenTap(judged, {
    stoppedReason: capture.stoppedReason?.(),
    linesAfterTap: capture.since(afterTap).length,
    lastLineAt: all.length > 0 ? all[all.length - 1].at : undefined,
  });
  if (!RECORD_DECIDES.includes(explained.cause ?? '')) return explained;
  // The device could not prove the open, or says it never happened: Customer.io's own record
  // of this push answers either way, once it keeps one.
  handle?.phase("reading Customer.io's record of the open");
  const recorded = await (options.readRecorded ?? readRecordedOpen)(
    options.environmentId,
    push.recordedIds ?? []
  );
  return withRecordedOpen(explained, recorded, Boolean(options.tap.link));
}

/** The device-side verdicts Customer.io's record of the open can settle or overturn. */
const RECORD_DECIDES = [
  'runtime.tap_lines_lost',
  'runtime.tap_not_seen',
  'runtime.capture_silent',
  'runtime.capture_stopped',
  'runtime.cold_tap_not_handled',
  'runtime.opened_not_tracked',
];

/**
 * An open the device's log could not show, read from Customer.io's record instead. An open it
 * recorded is the SDK reporting this exact push's open, so it overturns a failure the log
 * suggested, which can only have come from lines the stream lost. Where the tap went is in
 * the log alone, so with a deep link sent that part stays unproven. No open recorded leaves
 * the device's verdict as it was: the metric may still be on its way.
 */
export function withRecordedOpen(
  cell: MatrixCell,
  recorded: RecordedOpen,
  linkSent: boolean
): MatrixCell {
  if (recorded.answer === 'unavailable') {
    return {
      ...cell,
      evidence: [
        ...cell.evidence,
        `Customer.io's record of the open was not read: ${recorded.reason}`,
      ],
    };
  }
  if (recorded.answer === 'not_opened') {
    return {
      ...cell,
      recorded: 'not_recorded',
      evidence: [
        ...cell.evidence,
        `Customer.io had recorded no open for ${recorded.deliveryIds.join(
          ' or '
        )} after ${recorded.waitedMs / 1000}s`,
      ],
    };
  }
  const when = recorded.at
    ? ` at ${new Date(recorded.at * 1000).toISOString().slice(11, 19)}Z`
    : '';
  return {
    ...cell,
    deliveryId: recorded.deliveryId,
    recorded: 'recorded',
    ...(linkSent
      ? { verdict: 'warn', cause: 'runtime.opened_recorded_link_unseen' }
      : { verdict: 'pass', cause: undefined }),
    summary: undefined,
    evidence: [
      ...cell.evidence,
      `Customer.io recorded the open of ${recorded.deliveryId}${when} (was: ${cell.cause})`,
    ],
  };
}

/** The watch on the launch a tap starts, from before the prompt to after the tap is read. */
interface ColdLaunch {
  /** Stop watching, and say whether the app was read from its first line. */
  finish(): Promise<{ complete: boolean; evidence: string }>;
}

/**
 * A tap on the killed state's push starts the app from nothing, and the SDK handles it about
 * 60ms in, inside the burst a phone's live log drops. About half of those taps left no SDK
 * line in the stream, though the app's own record shows every one was handled. So on a phone
 * the next pids are watched before the prompt (see platform/ios/pid_window), and the app
 * lands in a stream that was already reading.
 *
 * When it lands outside the window the cell is judged as before: a missing line is unproven,
 * never a failure.
 */
async function catchColdLaunch(
  state: AppState,
  options: { target: Target; appProcess?: string },
  capture: LogCapture,
  handle?: CellHandle
): Promise<ColdLaunch | undefined> {
  const appProcess = options.appProcess;
  if (
    state !== 'killed' ||
    options.target.kind !== 'device' ||
    !capture.available ||
    !capture.followProcess ||
    !appProcess
  ) {
    return undefined;
  }
  handle?.phase('getting ready to catch the launch');
  const opened = await openPidWindow(options.target, capture, appProcess);
  const window = opened.window;
  if (!window) {
    const why = opened.unavailableReason;
    return {
      finish: async () => ({
        complete: false,
        evidence: `the launch from the tap was not watched for, so its first lines could be lost: ${why}`,
      }),
    };
  }
  return {
    finish: async () =>
      describeCaughtLaunch(
        await window.stop(),
        capture.compareStreams?.(appProcess)
      ),
  };
}

/**
 * What the window proved. Complete only when the app landed in a stream that was reading
 * before the process existed, and that stream then missed nothing the whole-log stream saw.
 * Every run checks the second part itself: a line only the whole-log stream has means the
 * window's stream dropped one, and then a missing SDK line is unproven again rather than a
 * failure. Lines only the window's stream has are the whole-log stream's losses, which is
 * how a run shows the window mattered.
 */
export function describeCaughtLaunch(
  outcome: WindowOutcome,
  agreement?: StreamAgreement
): { complete: boolean; evidence: string } {
  if (outcome.missed) {
    const { pid, from, to } = outcome.missed;
    return {
      complete: false,
      evidence: `the app launched as pid ${pid}, outside the pids watched for it (${from}–${to}), so its first lines could be lost`,
    };
  }
  if (!outcome.caught) {
    return {
      complete: false,
      evidence: outcome.reason
        ? `the launch from the tap was not caught: ${outcome.reason}`
        : 'no launch of the app came while the tap was asked for, so none was caught',
    };
  }
  const { pid, slot, fromFirstLine, how } = outcome.caught;
  const caught = `the app launched as pid ${pid}, into \`${how}\`, opened before that pid was in use (pid ${slot} of the ${WATCHED} watched)`;
  if (!fromFirstLine) {
    return {
      complete: false,
      evidence: `the app launched as pid ${pid}, but its stream may have opened after the app started, so its first lines could be lost`,
    };
  }
  if (!agreement) return { complete: true, evidence: caught };
  const tally = `of the app's lines since, ${agreement.both} reached both streams, ${agreement.onlyFollowed} only the pid's (the whole-log stream dropped them), ${agreement.onlyMain} only the whole-log one`;
  if (agreement.onlyMain > 0) {
    return {
      complete: false,
      evidence: `${caught}, but that stream missed lines too, so a missing line proves nothing: ${tally}`,
    };
  }
  return { complete: true, evidence: `${caught}; ${tally}` };
}

/**
 * The opened cell for a state whose push was never there to tap: it was not sent, or it
 * never arrived. The delivered cell already says which; this one only says nothing was asked.
 */
export function notTappedCell(state: AppState, why: string): MatrixCell {
  return {
    state,
    verdict: 'skip',
    summary: 'not tapped',
    evidence: [why],
  };
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
  const unseen = [
    'runtime.tap_not_seen',
    'runtime.tap_lines_lost',
    'runtime.cold_tap_not_handled',
  ];
  if (!unseen.includes(cell.cause ?? '')) return cell;
  if (context.stoppedReason) {
    return blameStoppedCapture(cell, context.stoppedReason, unseen);
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
  /**
   * The capture can drop lines (a phone's), so a missing line proves nothing. False when the
   * app's launch was held until a stream for it was open: nothing it wrote was dropped.
   */
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
  /**
   * The push carried a deep link. Without one, where the tap goes is not judged: the open is
   * the whole claim. Absent counts as sent, the way every push used to carry one.
   */
  linkSent?: boolean;
  /** iOS logged handing the tap to the app (phone captures only). */
  osDelivered?: boolean;
}): { verdict: Verdict; cause?: string } {
  if (!observed.available) return { verdict: 'skip' };

  if (!observed.clicked && !observed.tracked) {
    if (observed.foreign)
      return { verdict: 'fail', cause: 'runtime.tap_not_ours' };
    // iOS says the tap reached the app, and not one SDK line for it reached the log. From a
    // stream that read the launch from its first line, that silence is the SDK's: a tap
    // that starts the app reaches only a handler set up before launch finished.
    if (observed.osDelivered) {
      return observed.lossy === false
        ? { verdict: 'fail', cause: 'runtime.cold_tap_not_handled' }
        : { verdict: 'skip', cause: 'runtime.tap_lines_lost' };
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
  // No link was sent, so the open is everything this cell claims.
  if (observed.linkSent === false) return { verdict: 'pass' };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
