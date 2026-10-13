import { Target } from '../ios/device';
import { MatrixCell, MatrixSection, Verdict } from '../types';
import {
  LogCapture,
  NSE_MARKERS,
  blameStoppedCapture,
  deliveryIdsIn,
  ranInExtension,
  startCapture,
} from './logs';
import {
  SendRequest,
  eachState,
  markLateArrivals,
  rejectedCell,
  sendVerifyPush,
} from './send';
import { ALL_STATES, AppState, setAppState } from './states';
import { stopwatch } from '../clock';
import { CellHandle, Reporter } from '../report';
import { ProbeResult, probeLocalDelivery } from './probe';
import { waitForTitle } from './notifications';
import { PushProvider } from '../cio/push';
import { deliveredTitle, pushTag } from './identity';

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
  /** The extension's process, whose lines are the OS's word that it ran. */
  extensionName?: string;
  evidenceDirectory?: string;
  /** How long one cell waits for the extension to finish. */
  cellTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** First attempt: long enough that a slow simulator is not called a failure. */
const ARRIVAL_TIMEOUT_MS = 45_000;
/**
 * The re-send is a "maybe it was just slow" check, not a fresh attempt, so it gets a
 * fraction of the budget. Two full windows per dead cell is how one run spent 8m37s
 * arriving at a verdict it could have reached in seconds.
 */
const RETRY_ARRIVAL_TIMEOUT_MS = 12_000;
/** Confirming a condition an earlier cell already proved. */
const CONFIRMING_TIMEOUT_MS = 10_000;

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
    options.processNames,
    options.extensionName
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
    // Established once, then trusted: a target that would not deliver a locally injected
    // push in one cell is not going to deliver one in the next, and re-proving it costs a
    // full arrival window every time.
    const known: RunState = {};
    const startedAt = Date.now();
    section.cells = await eachState(
      states,
      (state) => runCell(state, options, capture, seenIds, known),
      // Sustained sends to one token appear to throttle; a pause between cells costs
      // nothing and removes a whole class of confusing near-misses.
      { pauseMs: 8_000, reporter: options.reporter }
    );
    // Only a simulator has a notification store to read afterwards; a phone has none.
    if (options.target.kind === 'simulator') {
      section.cells = await markLateArrivals(
        section.cells,
        async (title) =>
          (await waitForTitle({
            target: options.target,
            title,
            timeoutMs: 1_500,
            sinceMs: startedAt,
          })) === true,
        options.reporter
      );
    }
  } finally {
    await capture.stop();
    section.durationMs = sectionTimer();
  }

  return section;
}

/**
 * One push of the delivered matrix. The first send and the re-send both come from here:
 * built separately, the re-send left out the provider and went over APNs for an app that
 * receives push through Firebase, so the one retry meant to tell slow from broken could
 * not succeed.
 */
export function deliveredRequest(
  options: Pick<
    MatrixOptions,
    'dryRun' | 'environmentId' | 'token' | 'sandbox' | 'provider'
  >,
  title: string
): SendRequest {
  return {
    dryRun: options.dryRun,
    environmentId: options.environmentId,
    token: options.token,
    sandbox: options.sandbox,
    platform: 'ios',
    provider: options.provider,
    title,
    body: 'Sent by cio-sdk-tools verify push.',
  };
}

/**
 * One handle per cell, closed on every return path. The body reports phases; only this
 * wrapper closes the line, so a cell can never finish without saying how it went.
 */
/** What one cell learned that the rest of the run should not have to learn again. */
interface RunState {
  /** Set once a local-injection probe has answered for this target. */
  localProbe?: ProbeResult;
  /**
   * Set when a cell established that an accepted send reaches nothing at all. The later
   * cells still run — a failure in one app state hiding a pass in another is the bug this
   * matrix exists for — but they are confirming a known condition, not waiting for a first
   * answer, so they get seconds rather than two full windows each.
   */
  nothingArrives?: boolean;
}

async function runCell(
  state: AppState,
  options: MatrixOptions,
  capture: LogCapture,
  seenIds: Set<string>,
  known: RunState
): Promise<MatrixCell> {
  const handle = options.reporter?.cell(state);
  const cell = blameStoppedCapture(
    await runCellBody(state, options, capture, seenIds, handle, known),
    capture.stoppedReason?.(),
    SILENT
  );
  handle?.done(cell);
  return cell;
}

async function runCellBody(
  state: AppState,
  options: MatrixOptions,
  capture: LogCapture,
  seenIds: Set<string>,
  handle: CellHandle | undefined,
  known: RunState
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

  const mark = capture.mark();
  const sinceMs = Date.now() - 1_000;

  const title = deliveredTitle(state, pushTag());
  handle?.phase('sending');
  const sent = await sendVerifyPush(deliveredRequest(options, title));

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

  if (!sent.accepted) return rejectedCell(state, sent, evidence);
  evidence.push(
    sent.deliveryId
      ? `sent, delivery ${sent.deliveryId}`
      : 'sent (this route returns no delivery id, so the log supplies it)'
  );

  const since = () => capture.since(mark);
  const confirming = known.nothingArrives === true;
  const timeout = confirming
    ? CONFIRMING_TIMEOUT_MS
    : options.cellTimeoutMs ?? 60_000;

  /**
   * Wait for the *end* of the sequence, never the middle: `delivered` fires part way
   * through, so stopping there truncates the capture and loses the rich-push outcome.
   */
  const awaitSequence = async (budget: number): Promise<boolean> => {
    if (!capture.available) return false;
    handle?.phase('waiting for the extension to finish');
    return waitFor(
      () =>
        since().some((line) => NSE_MARKERS.completion.test(line.message)) &&
        since().some((line) => NSE_MARKERS.accepted.test(line.message)),
      budget
    );
  };

  // Arrival comes first, because it is the precondition for everything the extension
  // does: waiting a minute for an extension to finish handling a push that never landed
  // is a minute spent proving nothing, three times per run. Where arrival cannot be read
  // at all — every physical device — the old order stands, since there is nothing to gate
  // the wait on.
  handle?.phase('waiting for the push to arrive');
  let arrived = await waitForArrival(
    options.target,
    title,
    sinceMs,
    evidence,
    confirming ? CONFIRMING_TIMEOUT_MS : ARRIVAL_TIMEOUT_MS
  );
  if (confirming) {
    evidence.push(
      'an earlier cell established that nothing arrives, so this one confirmed it rather than waiting again'
    );
  }

  let finished = arrived === false ? false : await awaitSequence(timeout);

  // Nothing arrived and the extension never woke: on a simulator that is as often APNs
  // being slow as it is a real failure, and the tool has no business calling a delayed
  // push a broken one. One re-send, said out loud in the evidence, settles which it was.
  if (
    options.resend !== false &&
    arrived === false &&
    !ranInExtension(since()) &&
    known.localProbe !== 'absent' &&
    !confirming
  ) {
    handle?.phase('nothing arrived — sending once more');
    const again = await sendVerifyPush(
      deliveredRequest(options, `${title} (retry)`)
    );
    if (again.rateLimited) {
      return rejectedCell(state, again, evidence, 're-send rejected');
    }
    evidence.push(
      again.accepted
        ? 'nothing arrived on the first send; re-sent once'
        : `re-send rejected: ${again.error ?? 'unknown error'}`
    );
    if (again.accepted) {
      arrived = await waitForArrival(
        options.target,
        title,
        sinceMs,
        evidence,
        RETRY_ARRIVAL_TIMEOUT_MS
      );
      // It arrived on the second attempt: give the extension the full budget, because a
      // slow delivery is exactly the case where patience is the difference between a
      // right answer and a wrong one.
      if (arrived !== false) finished = await awaitSequence(timeout);
    }
  }

  // Nothing arrived: before blaming the integration, find out whether this target is
  // delivering anything at all.
  let localProbe = known.localProbe;
  if (arrived === false && !ranInExtension(since())) {
    if (localProbe === undefined) {
      handle?.phase('nothing arrived — testing the target itself');
      const probe = await probeLocalDelivery({
        target: options.target,
        bundleId: options.bundleId,
      });
      localProbe = probe.result;
      known.localProbe = probe.result;
      evidence.push(probe.evidence);
    } else {
      evidence.push(
        localProbe === 'absent'
          ? 'this target already failed a local-injection check in an earlier cell'
          : 'this target passed a local-injection check in an earlier cell'
      );
    }
  }

  if (arrived === false && !ranInExtension(since())) {
    known.nothingArrives = true;
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
    title,
    deliveryId: sent.deliveryId,
    ...judge({
      localProbe,
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

/** The causes a cell gets when nothing at all reached the app in its state. */
const SILENT = [
  'runtime.push_never_arrived',
  'runtime.no_evidence',
  'runtime.nse_did_not_run',
];

/**
 * When no state received anything and the profile says notifications are off, say that,
 * rather than a separate "never arrived" or "extension did not run" per state.
 *
 * iOS drops an alert push for an app with notifications off before its extension runs, so
 * the silence looks exactly like a broken extension. On its own, `push_enabled: false` is
 * only a hint — it has read false while permission was granted — but with nothing arriving
 * in any state, it is the likeliest reason, and the cheapest one to check. A single state
 * that received something means notifications are on, and the section is left alone.
 */
export function explainNotificationsOff(
  section: MatrixSection,
  pushDisabled: boolean
): MatrixSection {
  const silent =
    section.cells.length > 0 &&
    section.cells.every((cell) => cell.cause && SILENT.includes(cell.cause));
  if (!pushDisabled || !silent) return section;
  return {
    ...section,
    cells: section.cells.map((cell) => ({
      ...cell,
      verdict: 'fail',
      cause: 'device.notifications_disabled',
      summary: undefined,
      evidence: [
        ...cell.evidence,
        `nothing reached the app in any state, and the profile reports push_enabled false (was: ${cell.cause})`,
      ],
    })),
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
  /**
   * Only consulted when nothing arrived: `absent` means a locally injected push did not
   * display either, so the target is not delivering anything and the integration has not
   * been proven wrong — it has not been tested.
   */
  localProbe?: ProbeResult;
}): { verdict: Verdict; cause?: string } {
  if (!observed.available) {
    return { verdict: 'skip' };
  }
  // Arrival is read from the notification store, which is independent of the log capture,
  // so a definite "nothing arrived" outranks a silent log. Without this the run reports
  // three inconclusive cells while holding positive evidence that the push never landed
  // and that the target itself is healthy.
  if (observed.arrived === false) {
    return observed.localProbe === 'absent'
      ? { verdict: 'skip', cause: 'device.notifications_wedged' }
      : { verdict: 'fail', cause: 'runtime.push_never_arrived' };
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
    // Arrival has already been ruled on above, so reaching here means the push did arrive
    // (or arrival could not be read) and the extension still never woke.
    if (!observed.extensionRan) {
      return { verdict: 'fail', cause: 'runtime.nse_did_not_run' };
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

/**
 * Did the push this cell sent arrive?
 *
 * By title, never by counting. The first version diffed a fingerprint of every app's
 * notification store, so any unrelated system notification read as our push arriving —
 * a false positive in the one check that must not have one, and it sent a person looking
 * for a banner that was never sent to them.
 */
async function waitForArrival(
  target: Target,
  title: string,
  sinceMs: number,
  evidence: string[],
  timeoutMs = ARRIVAL_TIMEOUT_MS
): Promise<boolean | undefined> {
  const arrived = await waitForTitle({ target, title, sinceMs, timeoutMs });
  if (arrived === undefined) return undefined;
  evidence.push(
    arrived
      ? 'arrived: the notification is in the delivered store'
      : 'nothing with this title reached the notification store'
  );
  return arrived;
}
