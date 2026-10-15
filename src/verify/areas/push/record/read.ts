import { cioApi } from '../../../platform/cio/cli';

/**
 * Customer.io's own record of a test push.
 *
 * Once Customer.io keeps test pushes, the send returns a `delivery_id`, and
 * `GET /v1/environments/{id}/test_deliveries/{delivery_id}` reads that delivery back for 24
 * hours (a 404 after): `sent`, or `failed` with the provider's reason when it refused the
 * push, then `delivered` and `opened` as the device's SDK reports them. Until then the send
 * returns no id and there is nothing to read. Test deliveries are kept apart from real ones,
 * so the delivery routes never show them.
 *
 * It proves what the SDK reported for this exact push. It cannot say where a tap went: the
 * deep link's outcome is only ever in the device's log.
 */
export interface DeliveryRecord {
  id: string;
  /** Unix seconds, each absent until it happened. */
  sent?: number;
  delivered?: number;
  opened?: number;
  failed?: number;
  /** The HTTP status the provider (APNs or FCM) answered the send with. */
  providerStatus?: number;
  /**
   * The provider's reason for a refusal, e.g. BadDeviceToken. Null for a login that can't
   * see recipients, though `providerStatus` still shows the refusal.
   */
  failureMessage?: string;
  failureDetail?: string;
}

export type DeliveryRead =
  | { ok: true; record: DeliveryRecord }
  | { ok: false; notFound: boolean; error: string };

export type ReadDelivery = (
  environmentId: string,
  deliveryId: string
) => Promise<DeliveryRead>;

type Time = number | string | null | undefined;

interface RawTestDelivery {
  id?: string;
  state?: string;
  sent?: Time;
  failed?: Time;
  delivered?: Time;
  opened?: Time;
  provider_status?: number | null;
  failure_message?: string | null;
  failure_detail?: string | null;
}

export async function readDelivery(
  environmentId: string,
  deliveryId: string,
  api: typeof cioApi = cioApi
): Promise<DeliveryRead> {
  const res = await api<{ test_delivery?: RawTestDelivery }>(
    '/v1/environments/{environment_id}/test_deliveries/{delivery_id}',
    { environment_id: environmentId, delivery_id: deliveryId }
  );
  if (!res.ok) {
    const error = res.error ?? 'no answer';
    return { ok: false, notFound: /\b404\b/.test(error), error };
  }
  return {
    ok: true,
    record: parseDelivery(deliveryId, res.data?.test_delivery),
  };
}

export function parseDelivery(
  id: string,
  raw?: RawTestDelivery
): DeliveryRecord {
  return {
    id: raw?.id || id,
    sent: unixTime(raw?.sent),
    delivered: unixTime(raw?.delivered),
    opened: unixTime(raw?.opened),
    failed: unixTime(raw?.failed),
    providerStatus:
      typeof raw?.provider_status === 'number' && raw.provider_status > 0
        ? raw.provider_status
        : undefined,
    failureMessage: raw?.failure_message || undefined,
    failureDetail: raw?.failure_detail || undefined,
  };
}

function unixTime(value: Time): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const at = Number(value);
  return Number.isFinite(at) && at > 0 ? at : undefined;
}

/** Which of the device's reports to wait for. Neither means read once. */
export interface Wait {
  delivered: boolean;
  opened: boolean;
}

export interface RecordAnswer {
  /** The record that got furthest, of the ids read. */
  record?: DeliveryRecord;
  /** Set when none of the ids could be read. */
  error?: { notFound: boolean; message: string };
  waitedMs: number;
}

/**
 * How long a report may take to become readable. The device sends delivered within seconds;
 * the SDK batches opens for up to 30s; one failed upload adds another 16-74s before the
 * retry. A report still missing after these may yet arrive, so it is called late, not lost.
 */
export const LIMITS = {
  deliveredMs: 120_000,
  openedMs: 150_000,
  pollMs: 3_000,
};

/**
 * Read the record of one push until it holds what `wait` asks for, or the limit passes.
 * `ids` are every id this push's sends returned: a re-send has its own, and the device
 * reports whichever arrived.
 */
export async function awaitRecord(
  environmentId: string,
  ids: string[],
  wait: Wait,
  dependencies: { read?: ReadDelivery; limits?: Partial<typeof LIMITS> } = {}
): Promise<RecordAnswer> {
  const read = dependencies.read ?? readDelivery;
  const limits = { ...LIMITS, ...dependencies.limits };
  const budget = wait.opened
    ? limits.openedMs
    : wait.delivered
    ? limits.deliveredMs
    : 0;
  const startedAt = Date.now();
  let best: DeliveryRecord | undefined;
  for (;;) {
    const reads = await Promise.all(ids.map((id) => read(environmentId, id)));
    const records = reads.flatMap((answer) =>
      answer.ok ? [answer.record] : []
    );
    // A read that fails after one succeeded takes nothing away from what was learned.
    best = furthest(best ? [best, ...records] : records);
    const settled =
      best !== undefined &&
      (best.failed !== undefined ||
        ((!wait.delivered || best.delivered !== undefined) &&
          (!wait.opened || best.opened !== undefined)));
    const waitedMs = Date.now() - startedAt;
    // A 404 is read again like a missing report: a read straight after the send may beat it.
    if (settled || waitedMs + limits.pollMs >= budget) {
      const failed = reads.find(
        (answer): answer is Extract<DeliveryRead, { ok: false }> => !answer.ok
      );
      return {
        record: best,
        error:
          best || !failed
            ? undefined
            : { notFound: failed.notFound, message: failed.error },
        waitedMs,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, limits.pollMs));
  }
}

/** Opened beats delivered beats sent beats failed. */
function furthest(records: DeliveryRecord[]): DeliveryRecord | undefined {
  const rank = (record: DeliveryRecord) =>
    record.opened !== undefined
      ? 3
      : record.delivered !== undefined
      ? 2
      : record.failed !== undefined
      ? 0
      : 1;
  return records.reduce<DeliveryRecord | undefined>(
    (best, record) => (!best || rank(record) > rank(best) ? record : best),
    undefined
  );
}
