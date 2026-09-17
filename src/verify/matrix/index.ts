import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { run } from '../exec';
import { Target } from '../ios/device';
import { MatrixCell, MatrixSection, Verdict } from '../types';
import {
  LogCapture,
  NSE_MARKERS,
  deliveryIdsIn,
  ranInExtension,
  startCapture,
} from './logs';
import { sendVerifyPush } from './send';
import { ALL_STATES, AppState, setAppState } from './states';
import { stopwatch } from '../clock';
import { CellHandle, Reporter } from '../report';
import { PushProvider } from '../cio/push';

export interface MatrixOptions {
  /** Exercise every step except the send itself. */
  dryRun?: boolean;
  /**
   * Re-send once when nothing arrives. On by default because a delayed push is common and
   * a false "never arrived" is expensive; off when duplicate sends are unacceptable, which
   * is the stance `cio`'s own send path takes by never retrying a POST implicitly.
   */
  resend?: boolean;
  reporter?: Reporter;
  target: Target;
  bundleId: string;
  environmentId: string;
  token: string;
  sandbox: boolean;
  /** Read off the linked SDK product; an iOS app can deliver push over Firebase. */
  provider: PushProvider;
  states?: AppState[];
  /** App and extension process names, so a device log can be filtered to them. */
  processNames?: string[];
  evidenceDirectory?: string;
  /** How long one cell waits for the extension to finish. */
  cellTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The delivered matrix: one real push per app state, followed to the metric.
 *
 * Unlike preflight this never halts. A background failure hiding a killed one is precisely
 * the shape of bug this is meant to catch, so every cell runs and every cell reports.
 *
 * `delivered` should hold in all three states — the extension runs regardless of what the
 * app is doing — so a state-dependent failure here is a real defect, never an expected
 * caveat. That is what makes this a regression net rather than a table of footnotes.
 */
export async function runDeliveredMatrix(
  options: MatrixOptions
): Promise<MatrixSection> {
  const states = options.states ?? ALL_STATES;
  const capture = await startCapture(
    options.target,
    options.evidenceDirectory,
    options.processNames
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
    // Give the stream a moment to attach, or the first cell's lines are simply missing.
    if (capture.available) await sleep(2_500);

    const seenIds = new Set<string>();
    for (const state of states) {
      const cellTimer = stopwatch();
      const cell = await runCell(state, options, capture, seenIds);
      cell.durationMs = cellTimer();
      section.cells.push(cell);
      // Sustained sends to one token appear to throttle; a pause between cells costs
      // nothing and removes a whole class of confusing near-misses.
      await sleep(8_000);
    }
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
  options: MatrixOptions,
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
  options: MatrixOptions,
  capture: LogCapture,
  seenIds: Set<string>,
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
  if (staged.error) evidence.push(`state warning: ${staged.error}`);

  const mark = capture.lines.length;
  const before = await deliveredNotificationBlobs(options.target);

  const title = `cio verify · ${state} · ${new Date()
    .toISOString()
    .slice(11, 19)}`;
  handle?.phase('sending');
  const sent = await sendVerifyPush({
    dryRun: options.dryRun,
    environmentId: options.environmentId,
    token: options.token,
    sandbox: options.sandbox,
    platform: 'ios',
    provider: options.provider,
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
    sent.deliveryId
      ? `sent, delivery ${sent.deliveryId}`
      : 'sent (this route returns no delivery id, so the log supplies it)'
  );

  const since = () => capture.lines.slice(mark);
  const timeout = options.cellTimeoutMs ?? 60_000;

  // Wait for the *end* of the sequence. `delivered` fires part way through, so stopping
  // there truncates the capture and loses the rich-push outcome entirely.
  handle?.phase('waiting for the extension to finish');
  const finished = capture.available
    ? await waitFor(
        () =>
          since().some((line) => NSE_MARKERS.completion.test(line.message)) &&
          since().some((line) => NSE_MARKERS.accepted.test(line.message)),
        timeout
      )
    : false;

  handle?.phase('waiting for the push to arrive');
  let arrived = await waitForArrival(options.target, before, evidence);

  // Nothing arrived and the extension never woke: on a simulator that is as often APNs
  // being slow as it is a real failure, and the tool has no business calling a delayed
  // push a broken one. One re-send, said out loud in the evidence, settles which it was.
  if (
    options.resend !== false &&
    arrived === false &&
    !ranInExtension(since())
  ) {
    handle?.phase('nothing arrived — sending once more');
    const again = await sendVerifyPush({
      dryRun: options.dryRun,
      environmentId: options.environmentId,
      token: options.token,
      sandbox: options.sandbox,
      title: `${title} (retry)`,
      body: 'Sent by cio-sdk-tools verify push.',
    });
    evidence.push(
      again.accepted
        ? 'nothing arrived on the first send; re-sent once'
        : `re-send rejected: ${again.error ?? 'unknown error'}`
    );
    if (again.accepted) {
      await waitFor(
        () =>
          since().some((line) => NSE_MARKERS.completion.test(line.message)) &&
          since().some((line) => NSE_MARKERS.accepted.test(line.message)),
        timeout
      );
      arrived = await waitForArrival(options.target, before, evidence);
    }
  }

  const lines = since();
  const extensionRan = ranInExtension(lines);
  const tracking = lines.some((line) =>
    NSE_MARKERS.tracking.test(line.message)
  );
  const accepted = lines.some((line) =>
    NSE_MARKERS.accepted.test(line.message)
  );
  const rich = lines.some((line) =>
    NSE_MARKERS.richFinished.test(line.message)
  );
  const ids = deliveryIdsIn(lines);
  // The route that lets us keep the workspace credential alone returns no delivery id, so
  // freshness stands in for correlation: a cell that counted an id an earlier cell already
  // saw is reading a leftover delivery, and proves less than it appears to.
  const freshIds = ids.filter((id) => !seenIds.has(id));
  for (const id of ids) seenIds.add(id);

  if (capture.available) {
    evidence.push(
      `log: ${lines.length} lines, extension ran: ${extensionRan}, ` +
        `tracked: ${tracking}, accepted: ${accepted}, rich: ${rich}` +
        (finished ? '' : ' (sequence did not complete in time)')
    );
    if (ids.length > 0) evidence.push(`delivery ids in log: ${ids.join(', ')}`);
  } else {
    evidence.push(`no log capture: ${capture.unavailableReason}`);
  }

  return {
    state,
    deliveryId: sent.deliveryId,
    ...judge({
      available: capture.available,
      arrived,
      extensionRan,
      tracked: tracking,
      accepted,
      sawLines: lines.length > 0,
      sentId: sent.deliveryId,
      loggedIds: ids,
      freshIds,
    }),
    evidence,
  };
}

/**
 * What the evidence adds up to.
 *
 * The distinction that matters is between "never arrived" and "arrived and was not
 * counted". The first is a send or credential problem; the second is the invisible failure
 * this tool exists for, and the two look identical from the dashboard.
 */
export function judge(observed: {
  available: boolean;
  arrived: boolean | undefined;
  extensionRan: boolean;
  /** The SDK's own "tracking delivered" line: proof it was handed the request at all. */
  tracked: boolean;
  accepted: boolean;
  sawLines: boolean;
  sentId?: string;
  loggedIds: string[];
  freshIds: string[];
}): { verdict: Verdict; cause?: string } {
  if (!observed.available) {
    return { verdict: 'skip' };
  }
  // The app itself says nothing at all: that points at the capture, not at the push.
  // Accusing the extension here is how a broken log filter got reported three times as
  // the invisible failure.
  if (!observed.sawLines) {
    return { verdict: 'skip', cause: 'runtime.no_evidence' };
  }
  // The metric landing is the assertion; which process reported it is evidence. Judging
  // on the process first is how a log-parser bug turned three successful deliveries into
  // three accusations of the invisible failure.
  if (!observed.accepted) {
    if (!observed.extensionRan) {
      return observed.arrived === false
        ? { verdict: 'fail', cause: 'runtime.push_never_arrived' }
        : { verdict: 'fail', cause: 'runtime.nse_did_not_run' };
    }
    // Ran but never tried: the extension exists and never forwarded the request. That is a
    // different defect from a report that was attempted and did not land, and it is the
    // runtime proof of the static wiring.nse_does_not_forward warning.
    return observed.tracked
      ? { verdict: 'fail', cause: 'runtime.metric_not_accepted' }
      : { verdict: 'fail', cause: 'runtime.nse_did_not_forward' };
  }
  if (observed.loggedIds.length > 0) {
    const wrongId = observed.sentId
      ? !observed.loggedIds.includes(observed.sentId)
      : observed.freshIds.length === 0;
    if (wrongId) {
      return { verdict: 'warn', cause: 'runtime.delivery_id_mismatch' };
    }
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

/** The filesystem variant: the notification store has to be re-read to be re-checked. */
async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 700
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

async function waitForArrival(
  target: Target,
  before: Set<string> | undefined,
  evidence: string[]
): Promise<boolean | undefined> {
  if (!before) return undefined;
  let newBlobs: string[] = [];
  await waitForAsync(async () => {
    const after = await deliveredNotificationBlobs(target);
    newBlobs = [...(after ?? [])].filter((blob) => !before.has(blob));
    return newBlobs.length > 0;
  }, 45_000);
  if (newBlobs.length > 0) {
    evidence.push(
      `arrived: ${newBlobs.length} new entries in the notification store`
    );
    return true;
  }
  evidence.push('nothing new in the notification store');
  return false;
}

/**
 * Arrival, independent of the SDK: the simulator keeps delivered notifications in a plist
 * whose payload blobs can be diffed across a send. On a phone there is no equivalent to
 * read, so arrival there is whatever the log says.
 *
 * Diffed rather than matched on purpose — the store's format is undocumented and a match
 * would break the day it changes, while a diff only needs it to keep changing.
 */
async function deliveredNotificationBlobs(
  target: Target
): Promise<Set<string> | undefined> {
  if (target.kind !== 'simulator') return undefined;

  const root = path.join(
    os.homedir(),
    'Library/Developer/CoreSimulator/Devices',
    target.udid,
    'data/Library/UserNotifications'
  );
  const directories = await fs.readdir(root).catch(() => undefined);
  if (!directories) return new Set();

  const blobs = new Set<string>();
  for (const directory of directories) {
    const file = path.join(root, directory, 'DeliveredNotifications.plist');
    const { stdout, code } = await run('strings', [file], 30_000);
    if (code !== 0) continue;
    // base64url, because delivery ids carry `_` and `-`; a charset without them reports no
    // correlation when the correlation is perfect.
    for (const match of stdout.matchAll(/[A-Za-z0-9+/_-]{22,}={0,2}/g)) {
      blobs.add(match[0]);
    }
  }
  return blobs;
}
