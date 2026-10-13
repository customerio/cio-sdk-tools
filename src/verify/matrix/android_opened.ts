import { adb } from '../android/adb';
import { stopwatch } from '../clock';
import { Asker } from '../prompt';
import { CellHandle, Reporter } from '../report';
import { MatrixCell, MatrixSection } from '../types';
import { LogCapture, SDK_PUSH_LINE, explainSdkSilence } from './logs';
import { ANDROID_MARKERS, startAndroidCapture } from './android_logs';
import { OPENED_STATES, judgeOpened } from './opened';
import { eachState, rejectedCell, sendVerifyPush } from './send';
import { AppState } from './states';
import { setAndroidState } from './android_states';
import {
  androidIdForTitle,
  androidOpenedIdentity,
  pushTag,
  tapTitle,
} from './identity';
import { postedTitles } from './android';

/**
 * `opened` on Android: the same claim, a different set of sentences.
 *
 * The SDK's wording differs from iOS — the metric line carries the whole parsed payload
 * rather than a bare delivery id, and there are two extra deep-link outcomes because
 * Android can hand a URL to another app or fall back to the launcher. The *judgement* is
 * shared with iOS on purpose: one cause vocabulary is what lets the plugin learn a single
 * contract instead of one per platform.
 *
 * Arrival is read from the log rather than a notification store. Android exposes no
 * readable delivered-notification store — `cmd notification list` has already been caught
 * reporting nothing while a notification was on screen — but the SDK says "Showing
 * notification for message:" when it posts one, which is a better signal anyway: it is the
 * SDK's own account of what it did.
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

export interface AndroidOpenedOptions {
  serial: string;
  packageName: string;
  environmentId: string;
  token: string;
  link: string;
  states?: AppState[];
  evidenceDirectory?: string;
  asker: Asker;
  reporter?: Reporter;
  tapTimeoutMs?: number;
}

const TAP_TIMEOUT_MS = 180_000;
const ARRIVAL_TIMEOUT_MS = 45_000;
/** How long a tap's sequence gets to finish; the wait ends as soon as it does. */
const TAP_SEQUENCE_TIMEOUT_MS = 30_000;

export async function runAndroidOpenedMatrix(
  options: AndroidOpenedOptions
): Promise<MatrixSection> {
  const states = options.states ?? OPENED_STATES;
  const section: MatrixSection = { metric: 'opened', cells: [] };

  if (!options.asker.interactive) {
    section.skipped =
      'opened needs a real tap, and this run cannot ask for one — run it in a terminal';
    return section;
  }

  const capture = await startAndroidCapture(
    options.serial,
    options.evidenceDirectory
  );
  options.reporter?.matrix(capture.how, 'opened');
  const sectionTimer = stopwatch();

  try {
    if (capture.available) await sleep(1_500);
    const known = { listed: false };
    section.cells = await eachState(
      states,
      async (state) => {
        const handle = options.reporter?.cell(state);
        const cell = await runCell(state, options, capture, known, handle);
        handle?.done(cell);
        return cell;
      },
      { pauseMs: 4_000, reporter: options.reporter }
    );
    section.cells = explainSdkSilence(
      section.cells,
      {
        appSpoke: known.listed,
        sdkSpoke: capture.lines.some((line) =>
          SDK_PUSH_LINE.test(line.message)
        ),
        how: "the notification list showed this run's pushes",
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

async function runCell(
  state: AppState,
  options: AndroidOpenedOptions,
  capture: LogCapture,
  known: { listed: boolean },
  handle?: CellHandle
): Promise<MatrixCell> {
  const evidence: string[] = [];

  handle?.phase('staging the app state');
  const staged = await setAndroidState(
    options.serial,
    options.packageName,
    state
  );
  evidence.push(`state via ${staged.how}`);

  const mark = capture.mark();
  const title = tapTitle(state, pushTag());
  handle?.phase('sending');
  const sent = await sendVerifyPush({
    environmentId: options.environmentId,
    token: options.token,
    sandbox: false,
    platform: 'android',
    provider: 'fcm',
    title,
    body: 'Tap this notification to verify the opened metric.',
    link: options.link,
  });

  if (!sent.accepted) return rejectedCell(state, sent, evidence);
  evidence.push(`sent with link ${options.link}`);

  const since = () => capture.since(mark).map((line) => line.message);
  const seen = (marker: RegExp) => since().some((line) => marker.test(line));
  const shownBySdk = () =>
    androidIdForTitle(
      since().filter((line) => ANDROID_MARKERS.shown.test(line)),
      title
    ) !== undefined;

  // Nobody is asked to tap a notification that has not appeared. The OS's notification
  // list says it has; the SDK saying it showed this push, by its title, says so too.
  handle?.phase('waiting for the notification to appear');
  let listed = false;
  const deadline = Date.now() + ARRIVAL_TIMEOUT_MS;
  for (;;) {
    if (!listed) listed = (await postedTitles(options.serial)).includes(title);
    if (listed || shownBySdk() || Date.now() >= deadline) break;
    await sleep(1_500);
  }
  if (listed) known.listed = true;
  if (!listed && !shownBySdk()) {
    return {
      state,
      verdict: capture.available ? 'fail' : 'skip',
      cause: capture.available
        ? 'runtime.push_never_arrived'
        : 'runtime.no_evidence',
      evidence: [
        ...evidence,
        capture.available
          ? 'neither the notification list nor the SDK showed this push, so nobody was asked to tap it'
          : `no log capture: ${capture.unavailableReason}`,
      ],
    };
  }
  const expectedId = sent.deliveryId ?? androidIdForTitle(since(), title);
  evidence.push(
    (listed
      ? 'the notification list (dumpsys) shows it'
      : 'the SDK showed it; the notification list (dumpsys) does not') +
      (expectedId ? `, delivery ${expectedId}` : '')
  );

  const shot = await screenshot(
    options.serial,
    options.evidenceDirectory,
    state
  );
  if (shot) evidence.push(`screen at the prompt: ${shot}`);

  options.reporter?.pause();
  const tapped = await options.asker.confirm(
    [
      `Tap the "${title}" notification on ${options.serial}.`,
      'If the banner has gone, pull down the notification shade to find it.',
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

  // Wait for the end of the sequence, as on iOS: the open, then the deep link's outcome —
  // or a refusal. A fixed wait either cut a slow cold start short or wasted time.
  handle?.phase('reading what the SDK did with the tap');
  await waitFor(
    () =>
      seen(ANDROID_OPENED_MARKERS.skippedNoId) ||
      seen(ANDROID_OPENED_MARKERS.failedClick) ||
      seen(ANDROID_OPENED_MARKERS.linkUnhandled) ||
      (seen(ANDROID_OPENED_MARKERS.tracked) &&
        seen(ANDROID_OPENED_MARKERS.linkHandled)),
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
      ? open.title === title
      : expectedId && open.deliveryId
      ? open.deliveryId === expectedId
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
    const behaviour = lines
      .map((line) => ANDROID_OPENED_MARKERS.linkHandling.exec(line)?.[1])
      .find(Boolean);
    if (behaviour) evidence.push(`pushClickBehavior: ${behaviour}`);
  }

  return {
    state,
    title,
    deliveryId: opened?.deliveryId ?? expectedId,
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
