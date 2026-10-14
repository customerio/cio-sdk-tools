import { cioApi } from '../../../platform/cio/cli';

/**
 * Customer.io's own record of a test push.
 *
 * Once Customer.io keeps test pushes, the send returns a `delivery_id`, and
 * `GET /v1/environments/{id}/deliveries/{delivery_id}` reads that delivery back for 24 hours
 * in the shape of a campaign push's: `sent`, then `delivered` and `opened` as the device's SDK
 * reports them, or `failed` when the provider refused it. Until then the send returns no id
 * and there is nothing to read.
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
  failureMessage?: string;
  /** The provider's answer for each device the push went to, from `meta.reason`. */
  devices: DeviceOutcome[];
}

export interface DeviceOutcome {
  status?: number;
  /** The provider's error, empty when it took the push. */
  detail?: string;
  /** The device reported delivered. */
  delivered: boolean;
}

export type DeliveryRead =
  | { ok: true; record: DeliveryRecord }
  | { ok: false; notFound: boolean; error: string };

export type ReadDelivery = (
  environmentId: string,
  deliveryId: string
) => Promise<DeliveryRead>;

type Time = number | string | null | undefined;

interface RawDelivery {
  id?: string;
  sent?: Time;
  delivered?: Time;
  opened?: Time;
  failed?: Time;
  failure_message?: string | null;
  meta?: { reason?: string | null } | null;
  metrics?: { [metric: string]: Time } | null;
}

export async function readDelivery(
  environmentId: string,
  deliveryId: string,
  api: typeof cioApi = cioApi
): Promise<DeliveryRead> {
  const res = await api<{ delivery?: RawDelivery } & RawDelivery>(
    '/v1/environments/{environment_id}/deliveries/{delivery_id}',
    { environment_id: environmentId, delivery_id: deliveryId }
  );
  if (!res.ok) {
    const error = res.error ?? 'no answer';
    return { ok: false, notFound: /\b404\b/.test(error), error };
  }
  return {
    ok: true,
    record: parseDelivery(deliveryId, res.data?.delivery ?? res.data),
  };
}

/** A delivery's times, whichever of its two shapes carries each one. */
export function parseDelivery(id: string, raw?: RawDelivery): DeliveryRecord {
  const at = (metric: 'sent' | 'delivered' | 'opened' | 'failed') =>
    unixTime(raw?.[metric] ?? raw?.metrics?.[metric]);
  return {
    id: raw?.id || id,
    sent: at('sent'),
    delivered: at('delivered'),
    opened: at('opened'),
    failed: at('failed'),
    failureMessage: raw?.failure_message || undefined,
    devices: devicesIn(raw?.meta?.reason),
  };
}

function unixTime(value: Time): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const at = Number(value);
  return Number.isFinite(at) && at > 0 ? at : undefined;
}

/** `meta.reason` is a JSON string holding one entry per device. */
function devicesIn(reason?: string | null): DeviceOutcome[] {
  if (!reason) return [];
  try {
    const parsed = JSON.parse(reason);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((device) => ({
      status: typeof device?.status === 'number' ? device.status : undefined,
      detail:
        typeof device?.detail === 'string' && device.detail
          ? device.detail
          : undefined,
      delivered: device?.delivered === true,
    }));
  } catch {
    return [];
  }
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
