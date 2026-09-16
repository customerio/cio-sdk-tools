import { packageStopped } from '../android/device';
import { MatrixCell, MatrixSection, Verdict } from '../types';
import {
  ANDROID_MARKERS,
  androidDeliveryIds,
  startAndroidCapture,
} from './android_logs';
import { setAndroidState } from './android_states';
import { LogCapture } from './logs';
import { sendVerifyPush } from './send';
import { ALL_STATES, AppState } from './states';

export interface AndroidMatrixOptions {
  dryRun?: boolean;
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

  try {
    if (capture.available) await sleep(1_500);
    const seenIds = new Set<string>();
    for (const state of states) {
      section.cells.push(await runCell(state, options, capture, seenIds));
      await sleep(5_000);
    }
  } finally {
    await capture.stop();
  }

  return section;
}

async function runCell(
  state: AppState,
  options: AndroidMatrixOptions,
  capture: LogCapture,
  seenIds: Set<string>
): Promise<MatrixCell> {
  const evidence: string[] = [];

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

  const mark = capture.lines.length;
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
    title: `cio verify · ${state} · ${new Date().toISOString().slice(11, 19)}`,
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
  evidence.push(
    'sent (this route returns no delivery id, so the log supplies it)'
  );

  const since = () => capture.lines.slice(mark);
  const timeout = options.cellTimeoutMs ?? 45_000;
  await waitFor(
    () => since().some((line) => ANDROID_MARKERS.tracked.test(line.message)),
    timeout
  );

  const lines = since();
  const received = lines.some((line) =>
    ANDROID_MARKERS.received.test(line.message)
  );
  const tracked = lines.some((line) =>
    ANDROID_MARKERS.tracked.test(line.message)
  );
  const shown = lines.some((line) => ANDROID_MARKERS.shown.test(line.message));
  const duplicate = lines.some((line) =>
    ANDROID_MARKERS.duplicate.test(line.message)
  );
  const ids = androidDeliveryIds(lines);
  const freshIds = ids.filter((id) => !seenIds.has(id));
  for (const id of ids) seenIds.add(id);

  if (capture.available) {
    evidence.push(
      `log: ${lines.length} lines, received: ${received}, tracked: ${tracked}, ` +
        `notification shown: ${shown}${duplicate ? ', deduplicated' : ''}`
    );
    if (ids.length > 0) evidence.push(`delivery ids in log: ${ids.join(', ')}`);
  } else {
    evidence.push(`no log capture: ${capture.unavailableReason}`);
  }

  return {
    state,
    deliveryId: sent.deliveryId,
    ...judgeAndroid({
      available: capture.available,
      sawLines: lines.length > 0,
      stopped: Boolean(stopped),
      received,
      tracked,
      loggedIds: ids,
      freshIds,
    }),
    evidence,
  };
}

/**
 * Android's evidence is thinner than iOS's by one step, and saying so is the honest move.
 *
 * The SDK hands the delivered event to the CDP pipeline, which flushes in batches, and
 * logs nothing when that succeeds. So `tracked` — the SDK counted the delivery — is as far
 * as the device can testify; server-side confirmation is a different question from a
 * different source.
 */
export function judgeAndroid(observed: {
  available: boolean;
  sawLines: boolean;
  stopped: boolean;
  received: boolean;
  tracked: boolean;
  loggedIds: string[];
  freshIds: string[];
}): { verdict: Verdict; cause?: string } {
  if (!observed.available) return { verdict: 'skip' };
  if (!observed.sawLines)
    return { verdict: 'skip', cause: 'runtime.no_evidence' };

  if (!observed.received) {
    // The stopped state explains a silence completely, and blaming the integration for it
    // is the misdiagnosis this whole check exists to prevent.
    return observed.stopped
      ? { verdict: 'skip', cause: 'runtime.app_force_stopped' }
      : { verdict: 'fail', cause: 'runtime.push_never_arrived' };
  }
  if (!observed.tracked) {
    return { verdict: 'fail', cause: 'runtime.metric_not_tracked' };
  }
  if (observed.loggedIds.length > 0 && observed.freshIds.length === 0) {
    return { verdict: 'warn', cause: 'runtime.delivery_id_mismatch' };
  }
  return { verdict: 'pass' };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 400
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}
