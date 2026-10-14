import { cioApi } from '../../../platform/cio/cli';

/**
 * Customer.io's own record of a test push, for the opens the device's log cannot prove.
 *
 * It exists only once the backend keeps test pushes: the send then returns a `delivery_id`,
 * and `GET /v1/environments/{id}/deliveries/{delivery_id}` reads that delivery back with its
 * `opened` time, set by the same open metric the SDK reports for a campaign push. Until then
 * the send returns no id, and this says so without calling anything.
 *
 * It proves the SDK reported the open of this exact push. It cannot say where the tap went:
 * the deep link's outcome is only ever in the device's log.
 */
export type RecordedOpen =
  | { answer: 'opened'; deliveryId: string; at?: number }
  | { answer: 'not_opened'; deliveryIds: string[]; waitedMs: number }
  | { answer: 'unavailable'; reason: string };

/** Long enough for an open to travel through Data Pipelines; locally it took 1.3s. */
const WAIT_MS = 30_000;
const POLL_MS = 3_000;

interface DeliveryRecord {
  opened?: number | null;
  metrics?: { opened?: string | number | null };
}

export interface RecordedDependencies {
  api?: typeof cioApi;
  waitMs?: number;
  pollMs?: number;
}

/**
 * Whether Customer.io recorded an open for any of `deliveryIds`, the ids the sends returned
 * for this state's push (a re-send has its own, and the person taps whichever arrived).
 */
export async function readRecordedOpen(
  environmentId: string | undefined,
  deliveryIds: string[],
  dependencies: RecordedDependencies = {}
): Promise<RecordedOpen> {
  if (!environmentId || deliveryIds.length === 0) {
    return {
      answer: 'unavailable',
      reason:
        "the send returned no delivery id: Customer.io doesn't keep test pushes yet, so there is no record to read",
    };
  }
  const api = dependencies.api ?? cioApi;
  const waitMs = dependencies.waitMs ?? WAIT_MS;
  const pollMs = dependencies.pollMs ?? POLL_MS;
  const deadline = Date.now() + waitMs;
  for (;;) {
    for (const deliveryId of deliveryIds) {
      const res = await api<{ delivery?: DeliveryRecord } & DeliveryRecord>(
        '/v1/environments/{environment_id}/deliveries/{delivery_id}',
        { environment_id: environmentId, delivery_id: deliveryId }
      );
      if (!res.ok) {
        return {
          answer: 'unavailable',
          reason: `Customer.io's record of ${deliveryId} could not be read: ${
            res.error ?? 'no answer'
          }`,
        };
      }
      const at = openedAt(res.data?.delivery ?? res.data);
      if (at !== undefined) return { answer: 'opened', deliveryId, at };
    }
    if (Date.now() + pollMs > deadline) {
      return { answer: 'not_opened', deliveryIds, waitedMs: waitMs };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** A delivery's `opened`, as a Unix time, whichever of its two shapes carries it. */
export function openedAt(record?: DeliveryRecord): number | undefined {
  const value = record?.opened ?? record?.metrics?.opened;
  if (value === null || value === undefined || value === '') return undefined;
  const at = Number(value);
  return Number.isFinite(at) && at > 0 ? at : undefined;
}
