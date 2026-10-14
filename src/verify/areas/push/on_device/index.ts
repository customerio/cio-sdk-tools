import { Target } from '../../../platform/ios/device';
import { Verdict } from '../../../core/report/types';
import { MatrixCell, MatrixSection } from '../types';
import { startCapture } from '../../../platform/ios/logs';
import { LogCapture } from '../../../platform/logs';
import {
  NSE_MARKERS,
  blameStoppedCapture,
  SDK_PUSH_LINE,
  deliveryIdsIn,
  explainSdkSilence,
  extensionRanIn,
  simulatorPredicate,
} from './sdk_lines';
import {
  SendRequest,
  SendResult,
  eachState,
  markLateArrivals,
  rejectedCell,
  sendVerifyPush,
} from './send';
import { setAppState } from '../../../platform/ios/app_state';
import {
  describePushService,
  restartSimulator,
  simulatorPushService,
} from '../../../platform/ios/push_service';
import { ALL_STATES, AppState } from '../../../platform/app_state';
import { stopwatch } from '../../../core/clock';
import { CellHandle, Reporter } from '../../../core/report/render';
import { ProbeResult, probeLocalDelivery } from './probe';
import {
  StoredNotification,
  waitForNotification,
  waitForTitle,
} from './notifications';
import { PushProvider } from '../credentials';
import { deliveredTitle, pushTag, tapBody } from './identity';
import { SentPush, TapPlan, notTappedCell, tapIosPush } from './opened';

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
  /** Ask for a tap on the push of these states, once it arrives. */
  tap?: TapPlan;
}

/**
 * Both sections from one pass over the states. With a tap plan, each tapped state's push
 * serves both checks, so a run sends one push per state and the notification list holds one
 * banner per state.
 */
export interface PushMatrices {
  delivered: MatrixSection;
  /** Present when a tap plan was given. */
  opened?: MatrixSection;
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
/** After the extension runs, how long to wait for its own account to finish, as evidence. */
const EVIDENCE_SETTLE_MS = 8_000;

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
): Promise<PushMatrices> {
  const states = options.states ?? ALL_STATES;
  const capture = await startCapture(
    options.target,
    options.evidenceDirectory,
    {
      processes: options.processNames,
      predicate: simulatorPredicate(options.extensionName),
    }
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

  const tapped: MatrixCell[] = [];
  options.reporter?.matrix(
    capture.how,
    options.tap ? 'delivered and opened' : 'delivered'
  );
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
      (state) => runCell(state, options, capture, seenIds, known, tapped),
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
    const silence = {
      appSpoke: capture.lines.length > 0,
      sdkSpoke: capture.lines.some((line) => SDK_PUSH_LINE.test(line.message)),
      how: "the app's processes logged",
    };
    section.cells = explainSdkSilence(section.cells, silence, options.reporter);
    tapped.splice(
      0,
      tapped.length,
      ...explainSdkSilence(tapped, silence, options.reporter)
    );
  } finally {
    await capture.stop();
    section.durationMs = sectionTimer();
  }

  return {
    delivered: section,
    opened: options.tap
      ? {
          metric: 'opened',
          cells: completeTaps(options.tap, states, tapped),
          logs: section.logs,
          durationMs: section.durationMs,
        }
      : undefined,
  };
}

/**
 * A tapped state whose cell never ran — the provider began refusing sends — still gets a
 * line, so the opened section accounts for every state it was asked about.
 */
export function completeTaps(
  tap: TapPlan,
  states: AppState[],
  tapped: MatrixCell[]
): MatrixCell[] {
  return tap.states
    .filter((state) => states.includes(state))
    .map(
      (state) =>
        tapped.find((cell) => cell.state === state) ??
        notTappedCell(state, 'no push was sent for this state')
    );
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
  title: string,
  /** The push will be tapped: it carries the link, and its body says to tap it. */
  tap?: { link?: string; state: AppState }
): SendRequest {
  return {
    dryRun: options.dryRun,
    environmentId: options.environmentId,
    token: options.token,
    sandbox: options.sandbox,
    platform: 'ios',
    provider: options.provider,
    title,
    body: tap ? tapBody(tap.state) : 'Sent by cio-sdk-tools verify push.',
    link: tap?.link,
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

/**
 * The delivery ids a cell's sends returned, which is where Customer.io keeps its record of
 * them. `ids` stays absent until a send was accepted or refused with an id: a cell that sent
 * nothing has nothing to read back.
 */
export interface Sends {
  ids?: string[];
}

/** Keep what a send says about the record it left, and hand the result on. */
export function noteSend(sends: Sends, sent: SendResult): SendResult {
  if (sent.accepted || sent.deliveryId) {
    sends.ids ??= [];
    if (sent.deliveryId) sends.ids.push(sent.deliveryId);
  }
  return sent;
}

async function runCell(
  state: AppState,
  options: MatrixOptions,
  capture: LogCapture,
  seenIds: Set<string>,
  known: RunState,
  tapped: MatrixCell[]
): Promise<MatrixCell> {
  const handle = options.reporter?.cell(state);
  const sends: Sends = {};
  const body = await runCellBody(
    state,
    options,
    capture,
    seenIds,
    handle,
    known,
    sends
  );
  const cell = blameStoppedCapture(
    { ...body.cell, sentIds: sends.ids },
    capture.stoppedReason?.(),
    SILENT
  );
  handle?.done(cell);

  // The same push, tapped: asked for straight after it arrived, while the banner is up.
  if (options.tap?.states.includes(state)) {
    const tapHandle = options.reporter?.cell(state, 'opened');
    const opened = body.push
      ? await tapIosPush(
          state,
          body.push,
          {
            target: options.target,
            tap: options.tap,
            evidenceDirectory: options.evidenceDirectory,
            reporter: options.reporter,
            appProcess: options.processNames?.[0],
          },
          capture,
          tapHandle
        )
      : notTappedCell(
          state,
          body.noPush ?? 'the push never arrived, so nobody was asked to tap it'
        );
    tapHandle?.done(opened);
    tapped.push(opened);
  }
  return cell;
}

async function runCellBody(
  state: AppState,
  options: MatrixOptions,
  capture: LogCapture,
  seenIds: Set<string>,
  handle: CellHandle | undefined,
  known: RunState,
  sends: Sends
): Promise<{ cell: MatrixCell; push?: SentPush; noPush?: string }> {
  const evidence: string[] = [];
  const tapping = options.tap?.states.includes(state) === true;
  const send = async (title: string) =>
    noteSend(
      sends,
      await sendVerifyPush(
        deliveredRequest(
          options,
          title,
          tapping && options.tap ? { link: options.tap.link, state } : undefined
        )
      )
    );

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
  const sent = await send(title);

  if (sent.wouldSend) {
    return {
      cell: {
        state,
        verdict: 'skip',
        evidence: [
          ...evidence,
          `dry run — would POST /v1/environments/${options.environmentId}/verify/push`,
          JSON.stringify(sent.wouldSend),
        ],
      },
      noPush: 'a dry run sends nothing, so there is nothing to tap',
    };
  }

  if (!sent.accepted) {
    return {
      cell: rejectedCell(state, sent, evidence),
      noPush: 'the push was not sent, so nobody was asked to tap it',
    };
  }
  evidence.push(
    sent.deliveryId
      ? `sent, delivery ${sent.deliveryId}`
      : 'sent (this route returns no delivery id, so the log supplies it)'
  );

  const since = () => capture.since(mark);
  const ranNow = () => extensionRanIn(since(), options.extensionName);
  const confirming = known.nothingArrives === true;
  const timeout = confirming
    ? CONFIRMING_TIMEOUT_MS
    : options.cellTimeoutMs ?? 60_000;

  /**
   * Wait for the extension to run, then a little longer so the evidence holds the SDK's own
   * account of what it did. That account is evidence, never the verdict, so the extra wait
   * ends early on the SDK's end-of-processing line and otherwise simply runs out.
   */
  const awaitExtension = async (budget: number): Promise<void> => {
    if (!capture.available) return;
    handle?.phase('waiting for the extension to run');
    if (!(await waitFor(ranNow, budget))) return;
    // A tap is asked for next, and the banner is up now: the extension's account keeps
    // arriving in the capture while the person taps.
    if (tapping) return;
    handle?.phase('collecting the extension’s account');
    await waitFor(
      () => since().some((line) => NSE_MARKERS.completion.test(line.message)),
      EVIDENCE_SETTLE_MS
    );
  };

  // Arrival comes first, because it is the precondition for everything the extension
  // does: waiting a minute for an extension to handle a push that never landed is a
  // minute spent proving nothing, three times per run. Where arrival cannot be read at
  // all — every physical device — the wait is for the extension itself.
  handle?.phase('waiting for the push to arrive');
  let stored = await waitForArrival(
    options.target,
    [title],
    sinceMs,
    evidence,
    confirming ? CONFIRMING_TIMEOUT_MS : ARRIVAL_TIMEOUT_MS
  );
  if (confirming) {
    evidence.push(
      'an earlier cell established that nothing arrives, so this one confirmed it rather than waiting again'
    );
  }

  if (stored !== false) await awaitExtension(timeout);

  // Nothing arrived. A simulator whose push service has lost Apple's servers can receive
  // nothing, and a re-send would only be held with the first, so it is said as that rather
  // than blamed on the integration. The connection can drop mid-run, so it is read again here.
  if (stored === false && !ranNow() && options.target.kind === 'simulator') {
    handle?.phase("nothing arrived — reading the simulator's push connection");
    const service = await simulatorPushService(options.target.udid);
    if (service && !service.connected) {
      known.nothingArrives = true;
      return {
        cell: {
          state,
          title,
          verdict: 'skip',
          cause: 'device.apns_offline',
          evidence: [
            ...evidence,
            describePushService(service),
            `restart it: ${restartSimulator(options.target.udid)}`,
          ],
        },
        noPush:
          "the simulator has no connection to Apple's push servers, so nothing arrived to tap",
      };
    }
  }

  // Nothing arrived and the extension never woke: on a simulator that is as often APNs
  // being slow as it is a real failure, and the tool has no business calling a delayed
  // push a broken one. One re-send, said out loud in the evidence, settles which it was.
  // It carries its own tag, and either push arriving counts: the first may just be late.
  if (
    options.resend !== false &&
    stored === false &&
    !ranNow() &&
    known.localProbe !== 'absent' &&
    !confirming
  ) {
    handle?.phase('nothing arrived — sending once more');
    const retryTitle = deliveredTitle(state, pushTag());
    const again = await send(retryTitle);
    if (again.rateLimited) {
      return {
        cell: rejectedCell(state, again, evidence, 're-send rejected'),
        noPush: 'the push was not sent, so nobody was asked to tap it',
      };
    }
    evidence.push(
      again.accepted
        ? `nothing arrived on the first send; re-sent once as "${retryTitle}"`
        : `re-send rejected: ${again.error ?? 'unknown error'}`
    );
    if (again.accepted) {
      stored = await waitForArrival(
        options.target,
        [title, retryTitle],
        sinceMs,
        evidence,
        RETRY_ARRIVAL_TIMEOUT_MS
      );
      // It arrived on the second attempt: give the extension the full budget, because a
      // slow delivery is exactly the case where patience is the difference between a
      // right answer and a wrong one.
      if (stored !== false) await awaitExtension(timeout);
    }
  }

  // Nothing arrived: before blaming the integration, find out whether this target is
  // delivering anything at all.
  let localProbe = known.localProbe;
  if (stored === false && !ranNow()) {
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

  if (stored === false && !ranNow()) {
    known.nothingArrives = true;
  }

  const lines = since();
  const extensionRan = ranNow();
  // Kept as evidence of what the SDK did, never judged: whether a report landed is
  // Customer.io's to say, and the device's log of it is the part most often missing.
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
  // Without an id from the send or the OS's stored copy, freshness stands in for
  // correlation: a cell that reads an id an earlier cell already saw is reading a leftover
  // delivery, and proves less than it appears to.
  const freshIds = ids.filter((id) => !seenIds.has(id));
  for (const id of ids) seenIds.add(id);
  const expectedId =
    sent.deliveryId ?? (stored ? stored.deliveryId : undefined);

  if (capture.available) {
    evidence.push(`log: ${lines.length} lines, extension ran: ${extensionRan}`);
    evidence.push(
      `SDK lines, not judged: tracking delivered ${tracking}, report accepted ${accepted}, rich push ${rich}`
    );
    if (ids.length > 0) evidence.push(`delivery ids in log: ${ids.join(', ')}`);
  } else {
    evidence.push(`no log capture: ${capture.unavailableReason}`);
  }

  const deliveryId =
    expectedId ?? (freshIds.length === 1 ? freshIds[0] : undefined);
  const cell: MatrixCell = {
    state,
    title,
    deliveryId,
    ...judge({
      localProbe,
      available: capture.available,
      lossy: capture.lossy,
      arrived: stored === undefined ? undefined : stored !== false,
      extensionRan,
      sawLines: lines.length > 0,
      expectedId,
      loggedIds: ids,
      freshIds,
    }),
    evidence,
  };
  if (stored === false) {
    return {
      cell,
      noPush: 'the push never arrived, so nobody was asked to tap it',
    };
  }
  return {
    cell,
    push: {
      // After a re-send, whichever of the two arrived is the one to tap.
      title: stored ? stored.title : title,
      expectedId: deliveryId,
      arrivalSeen: stored ? true : extensionRan,
      mark,
    },
  };
}

/** The causes a cell gets when nothing at all reached the app in its state. */
const SILENT = [
  'runtime.push_never_arrived',
  'runtime.no_evidence',
  'runtime.nse_did_not_run',
  'runtime.push_not_seen',
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
 * "Received" means this push reached the device and the app's extension ran on it. Both
 * come from the OS — its notification store, and which process wrote a line — so neither
 * depends on what the SDK chooses to log. Whether a report then reached Customer.io is not
 * decided here: the device's log of it is the evidence most often missing, and only
 * Customer.io can say what it recorded.
 */
export function judge(observed: {
  available: boolean;
  /** The capture can drop lines (a phone's), so a missing line proves nothing. */
  lossy?: boolean;
  /** From the OS's notification store: definite on a simulator, unknown on a phone. */
  arrived: boolean | undefined;
  /** The extension's own process logged after the send. */
  extensionRan: boolean;
  sawLines: boolean;
  /** This push's delivery id, when the send or the OS's stored copy says what it is. */
  expectedId?: string;
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
  // so a definite "nothing arrived" outranks a silent log.
  if (observed.arrived === false) {
    return observed.localProbe === 'absent'
      ? { verdict: 'skip', cause: 'device.notifications_wedged' }
      : { verdict: 'fail', cause: 'runtime.push_never_arrived' };
  }
  // The app's processes say nothing at all: that points at the capture, not at the push.
  if (!observed.sawLines) {
    return { verdict: 'skip', cause: 'runtime.no_evidence' };
  }
  if (!observed.extensionRan) {
    // On a simulator the store says the push is there and the capture drops nothing, so an
    // extension that never logged never ran. On a phone nothing says the push arrived at
    // all, and the stream may have dropped the very lines that would have.
    return observed.arrived === true && !observed.lossy
      ? { verdict: 'fail', cause: 'runtime.nse_did_not_run' }
      : { verdict: 'skip', cause: 'runtime.push_not_seen' };
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
 * Did the push this cell sent arrive? Read from the OS's notification store, which also says
 * which delivery it is.
 *
 * By title, never by counting. The first version diffed a fingerprint of every app's
 * notification store, so any unrelated system notification read as our push arriving —
 * a false positive in the one check that must not have one, and it sent a person looking
 * for a banner that was never sent to them.
 */
async function waitForArrival(
  target: Target,
  titles: string[],
  sinceMs: number,
  evidence: string[],
  timeoutMs = ARRIVAL_TIMEOUT_MS
): Promise<StoredNotification | false | undefined> {
  const stored = await waitForNotification({
    target,
    title: titles,
    sinceMs,
    timeoutMs,
  });
  if (stored === undefined) return undefined;
  evidence.push(
    stored
      ? `arrived: "${stored.title}" is in the notification store${
          stored.deliveryId ? `, delivery ${stored.deliveryId}` : ''
        }`
      : 'nothing with this title reached the notification store'
  );
  return stored;
}
