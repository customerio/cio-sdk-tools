import { stopwatch } from '../../../core/clock';
import { Reporter } from '../../../core/report/render';
import { MatrixCell, MatrixSection } from '../types';
import {
  DeliveryRecord,
  LIMITS,
  ReadDelivery,
  RecordAnswer,
  Wait,
  awaitRecord,
} from './read';

/**
 * Customer.io's record of the pushes a run sent, read once the last one is done.
 *
 * One read serves two purposes. At any level that sends, a tap the device's log could not
 * prove is settled by the record of the open: an iPhone's log drops lines, and a launch is
 * where it drops the most. At end-to-end, every push's record is judged in a section of its
 * own: Customer.io heard each push was delivered, and opened when it was tapped.
 *
 * Every push is read at once, so the slowest sets the wait, and no tap waits on a read.
 */
export interface ReadBackInput {
  environmentId: string;
  /** End to end: every push's record is read and judged in a section of its own. */
  judge: boolean;
  delivered: MatrixSection;
  opened?: MatrixSection;
  /** A deep link was sent; where a tap went is in the device's log alone. */
  linkSent: boolean;
  reporter?: Reporter;
  /** Replaced in tests. */
  read?: ReadDelivery;
  limits?: Partial<typeof LIMITS>;
}

export interface ReadBack {
  delivered: MatrixSection;
  opened?: MatrixSection;
  /** Present when the record was judged. */
  recorded?: MatrixSection;
}

/** The opened verdicts the device could not settle, which the record of the open can. */
export const RECORD_DECIDES = [
  'runtime.tap_lines_lost',
  'runtime.tap_not_seen',
  'runtime.capture_silent',
  'runtime.capture_stopped',
  'runtime.cold_tap_not_handled',
  'runtime.opened_not_tracked',
];

interface Plan {
  delivered: MatrixCell;
  opened?: MatrixCell;
  ids: string[];
  wait: Wait;
  /** The opened cell is the device's best guess, which the record settles. */
  settles: boolean;
  answer?: Promise<RecordAnswer>;
}

export async function readBack(input: ReadBackInput): Promise<ReadBack> {
  const timer = stopwatch();
  const plans = input.delivered.cells.map((delivered): Plan => {
    const opened = input.opened?.cells.find(
      (cell) => cell.state === delivered.state
    );
    const ids = delivered.sentIds ?? [];
    const tapped = opened?.tapped === true;
    const settles = tapped && RECORD_DECIDES.includes(opened?.cause ?? '');
    const wait: Wait = {
      // A push the device never got has no delivery to wait for; its record is read once.
      delivered: input.judge && delivered.verdict !== 'fail',
      opened: tapped && (input.judge || settles),
    };
    const plan: Plan = { delivered, opened, ids, wait, settles };
    if (ids.length > 0 && (input.judge || settles)) {
      plan.answer = awaitRecord(input.environmentId, ids, wait, {
        read: input.read,
        limits: input.limits,
      }).catch((error) => ({
        error: { notFound: false, message: String(error) },
        waitedMs: 0,
      }));
    }
    return plan;
  });

  // The opens the log left unproven come first, each printed again with what settled it.
  const openedCells = new Map<string, MatrixCell>();
  for (const plan of plans) {
    if (!plan.opened || !plan.settles) continue;
    if (!plan.answer) {
      openedCells.set(
        plan.opened.state,
        withRecordedOpen(
          plan.opened,
          {
            answer: 'unavailable',
            reason:
              'the send returned no delivery id, so Customer.io kept no record of it',
          },
          input.linkSent
        )
      );
      continue;
    }
    const handle = input.reporter?.cell(
      `${plan.opened.state}, recorded`,
      'opened'
    );
    handle?.phase("waiting for Customer.io's record of the open");
    const answer = await plan.answer;
    const settled = withRecordedOpen(
      plan.opened,
      openedAnswer(answer, plan.ids),
      input.linkSent
    );
    handle?.done({ ...settled, durationMs: answer.waitedMs });
    openedCells.set(plan.opened.state, settled);
  }

  const recorded = input.judge
    ? await judgeRecords(plans, input.reporter)
    : undefined;
  if (recorded) recorded.durationMs = timer();

  // What the record said about each push stays on the device's cells too, as a fact.
  const facts = new Map<MatrixCell, DeliveryRecord | undefined>();
  for (const plan of plans) {
    facts.set(plan.delivered, plan.answer && (await plan.answer).record);
  }
  const delivered = input.delivered.cells.map((cell) => {
    const record = facts.get(cell);
    if (!input.judge || !record) return cell;
    return {
      ...cell,
      recorded:
        record.delivered !== undefined
          ? ('recorded' as const)
          : ('not_recorded' as const),
    };
  });
  const opened = input.opened?.cells.map((cell) => {
    const settled = openedCells.get(cell.state);
    if (settled) return settled;
    const plan = plans.find((each) => each.delivered.state === cell.state);
    const record = plan && facts.get(plan.delivered);
    if (!input.judge || !record || !plan?.wait.opened) return cell;
    return {
      ...cell,
      recorded:
        record.opened !== undefined
          ? ('recorded' as const)
          : ('not_recorded' as const),
    };
  });

  return {
    delivered: { ...input.delivered, cells: delivered },
    opened: input.opened && opened && { ...input.opened, cells: opened },
    recorded,
  };
}

/** One cell per push: whether Customer.io recorded what the device reported. */
async function judgeRecords(
  plans: Plan[],
  reporter?: Reporter
): Promise<MatrixSection> {
  const skipped = nothingToRead(plans);
  if (skipped) return { metric: 'recorded', cells: [], skipped };

  reporter?.matrix('read through cio', 'recorded');
  const cells: MatrixCell[] = [];
  for (const plan of plans) {
    const handle = reporter?.cell(plan.delivered.state, 'recorded');
    handle?.phase(
      plan.wait.opened
        ? 'waiting for delivered and opened'
        : plan.wait.delivered
        ? 'waiting for delivered'
        : 'reading'
    );
    const cell = recordedCell(plan, plan.answer && (await plan.answer));
    handle?.done(cell);
    cells.push(cell);
  }
  return { metric: 'recorded', cells };
}

/** Why the whole section has nothing to read, if it has nothing. */
function nothingToRead(plans: Plan[]): string | undefined {
  if (plans.every((plan) => plan.delivered.sentIds === undefined)) {
    return 'no push was sent, so there is no record to read';
  }
  if (plans.every((plan) => plan.ids.length === 0)) {
    return "the sends returned no delivery id: Customer.io isn't keeping test pushes for this workspace yet, so there is no record to read";
  }
  return undefined;
}

function recordedCell(plan: Plan, answer?: RecordAnswer): MatrixCell {
  const state = plan.delivered.state;
  const sentIds = plan.delivered.sentIds;
  const durationMs = answer?.waitedMs ?? 0;
  if (sentIds === undefined) {
    return {
      state,
      verdict: 'skip',
      summary: 'not sent',
      evidence: ['no push was sent in this state'],
      durationMs,
    };
  }
  if (!answer) {
    return {
      state,
      sentIds,
      verdict: 'skip',
      summary: 'no delivery id',
      evidence: [
        'the send returned no delivery id, so Customer.io kept no record of it',
      ],
      durationMs,
    };
  }
  if (!answer.record) {
    const error = answer.error ?? { notFound: false, message: 'no answer' };
    return {
      state,
      sentIds,
      verdict: 'skip',
      cause: error.notFound
        ? 'backend.delivery_not_found'
        : 'backend.record_unreadable',
      evidence: [`${sentIds.join(' or ')}: ${error.message}`],
      detail: error.notFound
        ? `delivery ${sentIds.join(' or ')}`
        : error.message,
      durationMs,
    };
  }

  const record = answer.record;
  const base = {
    state,
    sentIds,
    deliveryId: record.id,
    durationMs,
  };
  const evidence = [describe(record)];
  if (record.failed !== undefined) {
    return {
      ...base,
      verdict: 'fail',
      cause: 'send.provider_rejected',
      evidence: [
        ...evidence,
        `Customer.io recorded it as failed${
          record.failureMessage ? `: ${record.failureMessage}` : ''
        }${record.failureDetail ? ` (${record.failureDetail})` : ''}`,
      ],
      detail: record.failureMessage
        ? `the provider said: ${record.failureMessage}${
            record.failureDetail ? ` (${record.failureDetail})` : ''
          }`
        : undefined,
    };
  }
  const missing = [
    plan.wait.delivered && record.delivered === undefined ? 'delivered' : '',
    plan.wait.opened && record.opened === undefined ? 'opened' : '',
  ].filter(Boolean);
  if (missing.length > 0) {
    return {
      ...base,
      verdict: 'skip',
      cause: 'backend.metric_not_recorded',
      evidence: [
        ...evidence,
        `${missing.join(' and ')} not recorded within ${seconds(
          answer.waitedMs
        )}; it can still arrive later`,
      ],
    };
  }
  const got = [
    record.delivered !== undefined ? 'delivered' : '',
    record.opened !== undefined ? 'opened' : '',
  ].filter(Boolean);
  if (got.length === 0) {
    return {
      ...base,
      verdict: 'skip',
      summary: 'not delivered',
      evidence: [
        ...evidence,
        "the device check didn't pass, so no delivery was waited for",
      ],
    };
  }
  return { ...base, verdict: 'pass', summary: got.join(' · '), evidence };
}

/**
 * "Customer.io's record: delivery dgS_…, provider 200, sent 14:02:11Z, delivered 3s later,
 * opened …".
 */
function describe(record: DeliveryRecord): string {
  const parts = [`delivery ${record.id}`];
  if (record.providerStatus !== undefined) {
    parts.push(`provider ${record.providerStatus}`);
  }
  if (record.sent !== undefined) parts.push(`sent ${clock(record.sent)}`);
  for (const [name, at] of [
    ['delivered', record.delivered],
    ['opened', record.opened],
    ['failed', record.failed],
  ] as const) {
    if (at === undefined) continue;
    parts.push(
      record.sent !== undefined
        ? `${name} ${Math.max(0, at - record.sent)}s later`
        : `${name} ${clock(at)}`
    );
  }
  return `Customer.io's record: ${parts.join(', ')}`;
}

function clock(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().slice(11, 19)}Z`;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

export type RecordedOpen =
  | { answer: 'opened'; deliveryId: string; at?: number }
  | { answer: 'not_opened'; deliveryIds: string[]; waitedMs: number }
  | { answer: 'unavailable'; reason: string };

function openedAnswer(answer: RecordAnswer, ids: string[]): RecordedOpen {
  if (!answer.record) {
    return {
      answer: 'unavailable',
      reason: `${ids.join(' or ')}: ${answer.error?.message ?? 'no answer'}`,
    };
  }
  if (answer.record.opened !== undefined) {
    return {
      answer: 'opened',
      deliveryId: answer.record.id,
      at: answer.record.opened,
    };
  }
  return { answer: 'not_opened', deliveryIds: ids, waitedMs: answer.waitedMs };
}

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
        )} within ${seconds(recorded.waitedMs)}; it can still arrive later`,
      ],
    };
  }
  const when = recorded.at ? ` at ${clock(recorded.at)}` : '';
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
