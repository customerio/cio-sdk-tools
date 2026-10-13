import { packageStopped } from '../android/device';
import { MatrixCell, MatrixSection, Verdict } from '../types';
import {
  ANDROID_MARKERS,
  androidDeliveryIds,
  startAndroidCapture,
} from './android_logs';
import { setAndroidState } from './android_states';
import { LogCapture } from './logs';
import {
  eachState,
  markLateArrivals,
  rejectedCell,
  sendVerifyPush,
} from './send';
import { adb } from '../android/adb';
import { ALL_STATES, AppState } from './states';
import { stopwatch } from '../clock';
import { CellHandle, Reporter } from '../report';
import { androidIdForTitle, deliveredTitle, pushTag } from './identity';

export interface AndroidMatrixOptions {
  dryRun?: boolean;
  reporter?: Reporter;
  serial: string;
  packageName: string;
  environmentId: string;
  token: string;
  states?: AppState[];
  evidenceDirectory?: string;
  cellTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The Android delivered matrix.
 *
 * Structurally simpler than iOS because there is no extension: the FCM receiver runs in the
 * app process, so there is no "did a second process wake up" question. What replaces it is
 * Android's stopped state, which silently blocks delivery and is checked per cell.
 */
export async function runAndroidDeliveredMatrix(
  options: AndroidMatrixOptions
): Promise<MatrixSection> {
  const states = options.states ?? ALL_STATES;
  const capture = await startAndroidCapture(
    options.serial,
    options.evidenceDirectory
  );

  const section: MatrixSection = {
    metric: 'delivered',
    cells: [],
    logs: {
      how: capture.how,
      evidencePath: capture.evidencePath,
      unavailableReason: capture.unavailableReason,
    },
  };

  options.reporter?.matrix(capture.how);
  const sectionTimer = stopwatch();
  try {
    if (capture.available) await sleep(1_500);
    const seenIds = new Set<string>();
    section.cells = await eachState(
      states,
      (state) => runCell(state, options, capture, seenIds),
      { pauseMs: 5_000, reporter: options.reporter }
    );
    // One dumpsys lists every posted notification, so it is read once, and only if a cell
    // needs it.
    let posted: string[] | undefined;
    section.cells = await markLateArrivals(
      section.cells,
      async (title) =>
        (posted ??= await postedTitles(options.serial)).includes(title),
      options.reporter
    );
  } finally {
    await capture.stop();
    section.durationMs = sectionTimer();
  }

  return section;
}

/**
 * One handle per cell, closed on every return path. The body reports phases; only this
 * wrapper closes the line, so a cell can never finish without saying how it went.
 */
async function runCell(
  state: AppState,
  options: AndroidMatrixOptions,
  capture: LogCapture,
  seenIds: Set<string>
): Promise<MatrixCell> {
  const handle = options.reporter?.cell(state);
  const cell = await runCellBody(state, options, capture, seenIds, handle);
  handle?.done(cell);
  return cell;
}

async function runCellBody(
  state: AppState,
  options: AndroidMatrixOptions,
  capture: LogCapture,
  seenIds: Set<string>,
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
  if (staged.error) evidence.push(`state warning: ${staged.error}`);

  const stopped = await packageStopped(options.serial, options.packageName);
  if (stopped) {
    evidence.push('package is in the stopped state before the send');
  }

  const mark = capture.mark();
  const title = deliveredTitle(state, pushTag());
  handle?.phase('sending');
  const sent = await sendVerifyPush({
    dryRun: options.dryRun,
    environmentId: options.environmentId,
    token: options.token,
    // FCM has no sandbox and production split; the flag is meaningless here and the API
    // ignores it, so it is sent false rather than implying a distinction that exists only
    // on APNs.
    sandbox: false,
    platform: 'android',
    provider: 'fcm',
    title,
    body: 'Sent by cio-sdk-tools verify push.',
  });

  if (sent.wouldSend) {
    return {
      state,
      verdict: 'skip',
      evidence: [
        ...evidence,
        `dry run — would POST /v1/environments/${options.environmentId}/verify/push`,
        JSON.stringify(sent.wouldSend),
      ],
    };
  }
  if (!sent.accepted) {
    // `FCM_UNREGISTERED` belongs in the report verbatim: it means the token is invalid,
    // and the usual cause is a token scraped from logcat, which truncates long lines.
    return rejectedCell(state, sent, evidence);
  }
  evidence.push(
    'sent (this route returns no delivery id, so the log supplies it)'
  );

  const since = () => capture.since(mark);
  const messages = () => since().map((line) => line.message);
  const timeout = options.cellTimeoutMs ?? 45_000;

  // Two questions, each settled as soon as it can be. Is the notification on the device —
  // the OS's notification list, read with dumpsys — and did the app's SDK receive this push,
  // by its line naming the push's title and delivery id? The handoff worker that reports
  // the delivery to Customer.io is not waited for: what it reports is Customer.io's to
  // confirm, and it runs up to forty seconds later.
  handle?.phase('waiting for the push to arrive');
  let listed = false;
  const deadline = Date.now() + timeout;
  for (;;) {
    const now = messages();
    if (!listed) listed = (await postedTitles(options.serial)).includes(title);
    if (receivedBySdk(now, title) && (listed || shownBySdk(now, title))) break;
    if (Date.now() >= deadline) break;
    await sleep(1_500);
  }

  const lines = since();
  const now = lines.map((line) => line.message);
  const titledId = androidIdForTitle(now, title);
  const received = receivedBySdk(now, title);
  const shown = shownBySdk(now, title);
  const has = (marker: RegExp) => now.some((message) => marker.test(message));
  const duplicate = has(ANDROID_MARKERS.duplicate);
  // Kept as evidence of what the SDK did, never judged.
  const tracked = has(ANDROID_MARKERS.tracked);
  const reported =
    has(ANDROID_MARKERS.handoffDelivered) ||
    has(ANDROID_MARKERS.handoffAlreadyDelivered);
  const queued = has(ANDROID_MARKERS.handoffQueued);
  const ids = androidDeliveryIds(lines);
  const freshIds = ids.filter((id) => !seenIds.has(id));
  for (const id of ids) seenIds.add(id);
  const expectedId = sent.deliveryId ?? titledId;

  evidence.push(
    listed
      ? 'the notification list (dumpsys) shows it'
      : 'the notification list (dumpsys) does not show it'
  );
  if (capture.available) {
    evidence.push(
      `log: ${lines.length} lines, SDK received it: ${received}, SDK showed it: ${shown}` +
        (duplicate ? ', deduplicated' : '')
    );
    evidence.push(
      `SDK lines, not judged: tracking delivered ${tracked}, ` +
        (reported
          ? 'handoff worker reported it'
          : queued
          ? 'queued for the handoff worker'
          : 'no handoff queue activity')
    );
    if (ids.length > 0) evidence.push(`delivery ids in log: ${ids.join(', ')}`);
  } else {
    evidence.push(`no log capture: ${capture.unavailableReason}`);
  }

  return {
    state,
    title,
    deliveryId: expectedId ?? (freshIds.length === 1 ? freshIds[0] : undefined),
    ...judgeAndroid({
      available: capture.available,
      sawLines: lines.length > 0,
      stopped: Boolean(stopped),
      posted: listed || shown,
      received,
      expectedId,
      loggedIds: ids,
      freshIds,
    }),
    evidence,
  };
}

/**
 * Did the SDK receive this push? Its line naming the push's title says so exactly; an SDK
 * that prints only "Received new message with deliveryId" still counts, matched by
 * freshness instead.
 */
function receivedBySdk(messages: string[], title: string): boolean {
  return (
    androidIdForTitle(messages, title) !== undefined ||
    messages.some((message) => ANDROID_MARKERS.received.test(message))
  );
}

function shownBySdk(messages: string[], title: string): boolean {
  return (
    androidIdForTitle(
      messages.filter((message) => ANDROID_MARKERS.shown.test(message)),
      title
    ) !== undefined
  );
}

/**
 * What the Android evidence adds up to.
 *
 * "Received" means the push is on the device — the OS's notification list has it, or the
 * SDK said it showed it — and the app's SDK received it. Whether the delivery report then
 * reached Customer.io is not decided here: that is Customer.io's to say.
 */
export function judgeAndroid(observed: {
  available: boolean;
  sawLines: boolean;
  stopped: boolean;
  /** The OS's notification list has this push, or the SDK said it showed it. */
  posted: boolean;
  /** The SDK said it received this push. */
  received: boolean;
  /** This push's delivery id, from the line that names its title. */
  expectedId?: string;
  loggedIds: string[];
  freshIds: string[];
}): { verdict: Verdict; cause?: string } {
  if (!observed.available) return { verdict: 'skip' };
  if (!observed.sawLines)
    return { verdict: 'skip', cause: 'runtime.no_evidence' };

  if (!observed.posted && !observed.received) {
    // The stopped state explains a silence completely, and blaming the integration for it
    // is the misdiagnosis this whole check exists to prevent.
    return observed.stopped
      ? { verdict: 'skip', cause: 'runtime.app_force_stopped' }
      : { verdict: 'fail', cause: 'runtime.push_never_arrived' };
  }
  // On the device, and the SDK never said it received it: shown by something else — FCM
  // displays a notification message on its own while the app is in the background.
  if (!observed.received) {
    return { verdict: 'fail', cause: 'runtime.push_not_handled' };
  }
  if (observed.loggedIds.length > 0) {
    const wrongId = observed.expectedId
      ? !observed.loggedIds.includes(observed.expectedId)
      : observed.freshIds.length === 0;
    if (wrongId) {
      return { verdict: 'warn', cause: 'runtime.delivery_id_mismatch' };
    }
  }
  return { verdict: 'pass' };
}

/** Titles of the notifications posted on the target, from `dumpsys notification --noredact`. */
export function postedTitlesFrom(dumpsys: string): string[] {
  return [...dumpsys.matchAll(/android\.title=String \((.*)\)$/gm)].map(
    (match) => match[1]
  );
}

export async function postedTitles(serial: string): Promise<string[]> {
  const { stdout, code } = await adb(
    serial,
    ['shell', 'dumpsys', 'notification', '--noredact'],
    30_000
  );
  return code === 0 ? postedTitlesFrom(stdout) : [];
}
