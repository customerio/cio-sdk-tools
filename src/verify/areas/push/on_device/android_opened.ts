import { adb } from '../../../platform/android/adb';
import { CellHandle, Reporter } from '../../../core/report/render';
import { MatrixCell } from '../types';
import { LogCapture } from '../../../platform/logs';
import {
  SentPush,
  TAP_TIMEOUT_MS,
  TapPlan,
  judgeOpened,
  untappedCell,
} from './opened';
import { AppState } from '../../../platform/app_state';
import { androidOpenedIdentity } from './identity';
import { ANDROID_OPENED_MARKERS, Marker, lineMatch, matches } from './markers';

export { ANDROID_OPENED_MARKERS };

/** How long a tap's sequence gets to finish; the wait ends as soon as it does. */
const TAP_SEQUENCE_TIMEOUT_MS = 30_000;

/**
 * Ask for a tap on the push a delivered cell just sent, and read what the SDK did with it.
 * Asked straight after the push appeared, so the banner is usually still up.
 */
export async function tapAndroidPush(
  state: AppState,
  push: SentPush,
  options: {
    serial: string;
    /** What a person calls the device, for the prompt; the serial when unknown. */
    deviceName?: string;
    tap: TapPlan;
    evidenceDirectory?: string;
    reporter?: Reporter;
  },
  capture: LogCapture,
  handle?: CellHandle
): Promise<MatrixCell> {
  const evidence: string[] = [
    `the push this state's delivered check sent, "${push.title}"${
      push.expectedId ? `, delivery ${push.expectedId}` : ''
    }`,
  ];
  // From the push's own start, not from the answer: people tap first and answer after.
  const since = () => capture.since(push.mark).map((line) => line.message);
  const seen = (marker: Marker) =>
    since().some((line) => matches(marker, line));

  const shot = await screenshot(
    options.serial,
    options.evidenceDirectory,
    state
  );
  if (shot) evidence.push(`screen at the prompt: ${shot}`);

  options.reporter?.pause();
  const answer = await options.tap.asker.askTap(
    [
      `Tap the "${push.title}" notification on ${
        options.deviceName ?? options.serial
      }.`,
      'If the banner has gone, pull down the notification shade to find it.',
      'The app may not visibly change — the verdict comes from the log, not the screen.',
    ].join('\n  '),
    { timeoutMs: options.tap.tapTimeoutMs ?? TAP_TIMEOUT_MS }
  );
  options.reporter?.resume();
  if (answer !== 'tapped') {
    return untappedCell(state, answer, evidence, push.arrivalSeen);
  }

  // Wait for the end of the sequence, as on iOS: the open, then the deep link's outcome —
  // or a refusal. A fixed wait either cut a slow cold start short or wasted time.
  handle?.phase('reading what the SDK did with the tap');
  // Without a link the open is the end of the sequence.
  const linkSent = Boolean(options.tap.link);
  // Without a log capture none of these lines can appear, so nothing is waited for.
  if (capture.available) {
    await waitFor(
      () =>
        seen(ANDROID_OPENED_MARKERS.skippedNoId) ||
        seen(ANDROID_OPENED_MARKERS.failedClick) ||
        seen(ANDROID_OPENED_MARKERS.linkUnhandled) ||
        (seen(ANDROID_OPENED_MARKERS.tracked) &&
          (!linkSent ||
            seen(ANDROID_OPENED_MARKERS.linkHandled) ||
            seen(ANDROID_OPENED_MARKERS.linkFellBack))),
      TAP_SEQUENCE_TIMEOUT_MS
    );
  }

  const lines = since();
  const tracked = seen(ANDROID_OPENED_MARKERS.tracked);
  const emptyId = seen(ANDROID_OPENED_MARKERS.skippedNoId);
  const failed = seen(ANDROID_OPENED_MARKERS.failedClick);
  const linkAttempted = seen(ANDROID_OPENED_MARKERS.linkHandling);
  const linkWentNowhere = linkSent && seen(ANDROID_OPENED_MARKERS.linkFellBack);

  // The opened line names the tapped push by title and id, so an open of an older banner
  // is recognised as that rather than counted for this push.
  const opens = lines
    .filter((line) => matches(ANDROID_OPENED_MARKERS.tracked, line))
    .map(androidOpenedIdentity);
  const isThisPush = (open: { title?: string; deliveryId?: string }) =>
    open.title
      ? open.title === push.title
      : push.expectedId && open.deliveryId
      ? open.deliveryId === push.expectedId
      : undefined;
  const opened = opens.find((open) => isThisPush(open) === true) ?? opens[0];
  const matched = opened ? isThisPush(opened) : undefined;

  if (capture.available) {
    evidence.push(
      `log: ${lines.length} lines, opened tracked: ${tracked}, deep link: ${
        linkWentNowhere
          ? "nothing could open it, so the SDK opened the app's main screen"
          : seen(ANDROID_OPENED_MARKERS.linkHandled)
          ? 'handled'
          : 'not handled'
      }`
    );
    if (opened) {
      evidence.push(
        matched === false
          ? `the SDK opened "${
              opened.title ?? opened.deliveryId
            }", not this push`
          : `the SDK opened ${opened.deliveryId ?? 'a push'}${
              matched ? ', this push' : ''
            }`
      );
    }
    if (!linkSent) {
      evidence.push(
        'no deep link was sent, so where the tap goes was not checked'
      );
    }
    const behaviour = lines
      .map(
        (line) => lineMatch(ANDROID_OPENED_MARKERS.linkHandling, line)?.behavior
      )
      .find(Boolean);
    if (behaviour) evidence.push(`pushClickBehavior: ${behaviour}`);
  } else {
    evidence.push(`no log capture: ${capture.unavailableReason}`);
  }

  return {
    state,
    title: push.title,
    deliveryId: opened?.deliveryId ?? push.expectedId,
    tapped: true,
    ...judgeOpened({
      available: capture.available,
      lossy: capture.lossy,
      matched,
      // The open names neither a title nor an id this tool can read, so an open of an older
      // banner would look the same.
      idUnread: Boolean(
        opened && !opened.title && !opened.deliveryId && push.expectedId
      ),
      clicked: androidClicked({
        tracked,
        emptyId,
        failed,
        linkAttempted,
        linkHandled: seen(ANDROID_OPENED_MARKERS.linkHandled),
        linkUnhandled: seen(ANDROID_OPENED_MARKERS.linkUnhandled),
        linkFellBack: seen(ANDROID_OPENED_MARKERS.linkFellBack),
      }),
      tracked,
      foreign: false,
      emptyId,
      linkAttempted,
      linkHandled: seen(ANDROID_OPENED_MARKERS.linkHandled),
      linkUnhandled: seen(ANDROID_OPENED_MARKERS.linkUnhandled),
      linkOpenFailed: linkWentNowhere,
      linkSent,
    }),
    detail: linkWentNowhere
      ? "nothing on the device could open the link, so the SDK opened the app's main screen"
      : undefined,
    evidence,
  };
}

/**
 * Whether the click reached the SDK. Android logs no separate "clicked" line, so the open,
 * the skip and the failure are each evidence of it. So is anything the SDK says about the
 * deep link, as on iOS: it follows a push's link only from its click path.
 */
export function androidClicked(seen: {
  tracked: boolean;
  emptyId: boolean;
  failed: boolean;
  linkAttempted: boolean;
  linkHandled: boolean;
  linkUnhandled: boolean;
  /** The SDK opened the app's main screen because nothing could open the link. */
  linkFellBack: boolean;
}): boolean {
  return (
    seen.tracked ||
    seen.emptyId ||
    seen.failed ||
    seen.linkAttempted ||
    seen.linkHandled ||
    seen.linkUnhandled ||
    seen.linkFellBack
  );
}

export async function screenshot(
  serial: string,
  directory: string | undefined,
  state: AppState
): Promise<string | undefined> {
  if (!directory) return undefined;
  const file = `${directory}/opened-${state}.png`;
  // The PNG is written on the device and pulled: its bytes never pass through a string,
  // which decodes stdout as text and corrupts a binary stream.
  const remote = '/data/local/tmp/cio-verify-screen.png';
  const captured = await adb(serial, ['shell', 'screencap', '-p', remote]);
  if (captured.code !== 0) return undefined;
  const pulled = await adb(serial, ['pull', remote, file]);
  await adb(serial, ['shell', 'rm', '-f', remote]);
  return pulled.code === 0 ? file : undefined;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(400);
  }
  return predicate();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
