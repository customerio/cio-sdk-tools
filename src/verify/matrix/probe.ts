import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { run } from '../exec';
import { Target } from '../ios/device';

/**
 * Did the push fail to arrive, or does nothing arrive on this target at all?
 *
 * A matrix run once spent 8m37s concluding "a real push was sent and was not counted"
 * about a perfectly wired app: the simulator's notification delivery was stuck, and a
 * shutdown/boot fixed it. From inside the run the two look identical — a send that was
 * accepted, and silence.
 *
 * `simctl push` settles it, because it injects a notification locally and never touches
 * APNs. If that displays, the app and its extension are reachable and the fault is in the
 * delivery path; if even that does not land, the target itself is not delivering anything
 * and no verdict about the integration is available at all.
 *
 * Deliberately a fallback rather than a precondition: it costs nothing on a run where the
 * push arrives, and the only run that needs it is one already heading for a bad verdict.
 */
export type ProbeResult = 'landed' | 'absent' | 'unavailable';

export interface Probe {
  result: ProbeResult;
  /** Ready to push into a cell's evidence, in the tool's own voice. */
  evidence: string;
}

const LANDING_TIMEOUT_MS = 8_000;
const POLL_MS = 700;

export async function probeLocalDelivery(options: {
  target: Target;
  bundleId: string;
  /** Snapshot of the delivered-notification blobs taken before the probe. */
  blobsBefore?: Set<string>;
  readBlobs: (target: Target) => Promise<Set<string> | undefined>;
}): Promise<Probe> {
  // A physical device has no local-injection route, so the question cannot be asked there.
  if (options.target.kind !== 'simulator') {
    return {
      result: 'unavailable',
      evidence:
        'no local-injection check on a physical device, so arrival could not be told apart from a stuck target',
    };
  }

  const before = options.blobsBefore ?? new Set<string>();
  const payload = path.join(os.tmpdir(), `cio-verify-probe-${Date.now()}.apns`);
  // `mutable-content` so the extension is exercised too: a probe that both displays and
  // wakes the extension proves everything except the network.
  await fs.writeFile(
    payload,
    JSON.stringify({
      'Simulator Target Bundle': options.bundleId,
      'aps': {
        'alert': {
          title: 'cio verify · local probe',
          body: 'Injected locally to test this target, not sent over APNs.',
        },
        'mutable-content': 1,
      },
    }),
    'utf8'
  );

  try {
    const { code, stderr } = await run(
      'xcrun',
      ['simctl', 'push', options.target.udid, options.bundleId, payload],
      30_000
    );
    if (code !== 0) {
      return {
        result: 'unavailable',
        evidence: `local probe could not be injected: ${
          stderr.trim().split('\n')[0] || 'simctl push failed'
        }`,
      };
    }

    const deadline = Date.now() + LANDING_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const after = await options.readBlobs(options.target);
      const fresh = [...(after ?? [])].filter((blob) => !before.has(blob));
      if (fresh.length > 0) {
        return {
          result: 'landed',
          evidence:
            'a locally injected push did display, so the app and extension are reachable — the delivery path is the suspect, not the integration',
        };
      }
    }

    return {
      result: 'absent',
      evidence:
        'a locally injected push did not display either, so this target is not delivering notifications at all',
    };
  } finally {
    await fs.rm(payload, { force: true }).catch(() => undefined);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
