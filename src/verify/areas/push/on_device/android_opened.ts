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

/**
 * `opened` on Android: the same claim, a different set of sentences.
 *
 * The SDK's wording differs from iOS — the metric line carries the whole parsed payload
 * rather than a bare delivery id, and there are two extra deep-link outcomes because
 * Android can hand a URL to another app or fall back to the launcher. The *judgement* is
 * shared with iOS on purpose: one cause vocabulary is what lets the plugin learn a single
 * contract instead of one per platform.
 *
 * The push tapped is the one the delivered check just sent and saw arrive, in the
 * notification list or by the SDK's own "Showing notification" line.
 */
export const ANDROID_OPENED_MARKERS = {
  tracked: /Tracking push message opened with payload: (.+)/,
  skippedNoId:
    /Skipping opened metric for notification without a delivery id\/token/,
  failedClick: /Failed to handle push click/,
  linkHandling:
    /Handling push notification deep link with payload: .* - pushClickBehavior: (\S+)/,
  linkHandled:
    /Deep link handled by (?:host app callback implementation|internal host app navigation|external app|opening default host app)/,
  linkUnhandled: /Deep link was not handled/,
};

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
  const seen = (marker: RegExp) => since().some((line) => marker.test(line));

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
  await waitFor(
    () =>
      seen(ANDROID_OPENED_MARKERS.skippedNoId) ||
      seen(ANDROID_OPENED_MARKERS.failedClick) ||
      seen(ANDROID_OPENED_MARKERS.linkUnhandled) ||
      (seen(ANDROID_OPENED_MARKERS.tracked) &&
        (!linkSent || seen(ANDROID_OPENED_MARKERS.linkHandled))),
    TAP_SEQUENCE_TIMEOUT_MS
  );

  const lines = since();
  const tracked = seen(ANDROID_OPENED_MARKERS.tracked);
  const emptyId = seen(ANDROID_OPENED_MARKERS.skippedNoId);
  const failed = seen(ANDROID_OPENED_MARKERS.failedClick);
  const linkAttempted = seen(ANDROID_OPENED_MARKERS.linkHandling);

  // The opened line names the tapped push by title and id, so an open of an older banner
  // is recognised as that rather than counted for this push.
  const opens = lines
    .filter((line) => ANDROID_OPENED_MARKERS.tracked.test(line))
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
      `log: ${
        lines.length
      } lines, opened tracked: ${tracked}, deep link handled: ${seen(
        ANDROID_OPENED_MARKERS.linkHandled
      )}`
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
      .map((line) => ANDROID_OPENED_MARKERS.linkHandling.exec(line)?.[1])
      .find(Boolean);
    if (behaviour) evidence.push(`pushClickBehavior: ${behaviour}`);
  } else {
    evidence.push(`no log capture: ${capture.unavailableReason}`);
  }

  return {
    state,
    title: push.title,
    deliveryId: opened?.deliveryId ?? push.expectedId,
    ...judgeOpened({
      available: capture.available,
      lossy: capture.lossy,
      matched,
      // Android logs no separate "clicked" line: the open, the skip and the failure are
      // each evidence that the click reached the SDK at all.
      clicked: tracked || emptyId || failed,
      tracked,
      foreign: false,
      emptyId,
      linkAttempted,
      linkHandled: seen(ANDROID_OPENED_MARKERS.linkHandled),
      linkUnhandled: seen(ANDROID_OPENED_MARKERS.linkUnhandled),
      linkSent,
    }),
    evidence,
  };
}

async function screenshot(
  serial: string,
  directory: string | undefined,
  state: AppState
): Promise<string | undefined> {
  if (!directory) return undefined;
  const file = `${directory}/opened-${state}.png`;
  // `exec-out` keeps the PNG bytes off the shell's line endings, which `shell screencap`
  // corrupts on some devices.
  const { code, stdout } = await adb(serial, ['exec-out', 'screencap', '-p']);
  if (code !== 0 || !stdout) return undefined;
  const { promises: fs } = await import('fs');
  await fs.writeFile(file, Buffer.from(stdout, 'binary'));
  return file;
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
