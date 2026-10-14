import { LogLine } from '../../../platform/logs';
import { MatrixCell } from '../types';

/**
 * What push reads in a log: the SDK's own sentences, the extension's process, and the
 * judgements that turn on whether those lines were there at all. The capture that collects
 * them knows nothing about push.
 */

/**
 * A cell that "saw nothing" after the capture stopped saw nothing because nothing was
 * being read. It is re-judged as the capture's problem, so the person is not blamed for a
 * tap they made or the app for a delivery it reported.
 */
export function blameStoppedCapture(
  cell: MatrixCell,
  stoppedReason: string | undefined,
  silentCauses: string[]
): MatrixCell {
  if (!stoppedReason || !cell.cause || !silentCauses.includes(cell.cause)) {
    return cell;
  }
  return {
    ...cell,
    verdict: 'skip',
    cause: 'runtime.capture_stopped',
    summary: undefined,
    evidence: [...cell.evidence, `${stoppedReason} (was: ${cell.cause})`],
  };
}

/**
 * The SDK's subsystem, plus the extension's process by name: a line from that process is the
 * OS's word that the extension ran, whether or not the SDK logs anything. Extensions are
 * usually called NotificationService-something, which the substring keeps covering when the
 * project does not say.
 */
export function simulatorPredicate(extensionName?: string): string {
  const named =
    extensionName && !extensionName.includes('NotificationService')
      ? ` OR process == "${extensionName.replace(/["\\]/g, '')}"`
      : '';
  return `subsystem == "io.customer.sdk" OR processImagePath CONTAINS "NotificationService"${named}`;
}

/** The SDK starts every line with its tag; `[Push]` is the module these checks read. */
export const SDK_PUSH_LINE = /^\[Push\] /;

/** Causes that mean something only if the SDK was writing its lines at all. */
const NEEDS_SDK_LINES = [
  'runtime.no_evidence',
  'runtime.push_not_handled',
  'runtime.tap_not_seen',
  'runtime.tap_lines_lost',
];

/**
 * A run where the app was plainly there and the SDK wrote not one line did not show an SDK
 * doing nothing. Its push lines are debug lines, and an app built with a quieter log level
 * prints none of them — which reads exactly like a push the SDK ignored. Cells that turned
 * on the SDK's silence are re-judged as that, and printed again.
 */
export function explainSdkSilence(
  cells: MatrixCell[],
  seen: {
    /** Something independent of the SDK showed the app at work. */
    appSpoke: boolean;
    sdkSpoke: boolean;
    /** What showed the app at work, for the evidence. */
    how: string;
  },
  reporter?: { cell(state: string): { done(cell: MatrixCell): void } }
): MatrixCell[] {
  if (!seen.appSpoke || seen.sdkSpoke) return cells;
  return cells.map((cell) => {
    if (!cell.cause || !NEEDS_SDK_LINES.includes(cell.cause)) return cell;
    const quiet: MatrixCell = {
      ...cell,
      verdict: 'skip',
      cause: 'runtime.sdk_logging_off',
      summary: undefined,
      evidence: [
        ...cell.evidence,
        `not one [Push] line from the SDK in this run, though ${seen.how} (was: ${cell.cause})`,
      ],
    };
    reporter?.cell(`${cell.state}, SDK quiet`).done(quiet);
    return quiet;
  });
}

/**
 * The SDK's own phrasings, anchored deliberately.
 *
 * A loose filter has twice produced a false result here: a bare /handled/ matched kernel
 * `unhandled kAMPDUStat_` spam, and a bare /Successfully/ reported three errored sends as
 * passing. Each pattern below is the SDK's exact sentence.
 */
export const NSE_MARKERS = {
  tracking: /Tracking push message delivered/,
  accepted: /Successfully tracked push metric 'delivered'/,
  /** Fires at the end of the sequence; `delivered` fires mid-way and truncates a capture. */
  completion: /invoking contentHandler|normal completion/,
  richFinished: /rich push step finished/,
} as const;

/**
 * Did the extension run? Read from which process wrote a line — the OS's attribution — never
 * from what the line says, so it holds whatever the SDK logs or fails to.
 */
export function ranInExtension(
  lines: LogLine[],
  extensionName?: string
): boolean {
  return lines.some((line) =>
    extensionName && line.process === extensionName
      ? true
      : /NotificationService/.test(line.process)
  );
}

/**
 * Did the extension run on a push? A line from its own process is the OS's word for it. The
 * SDK's "Tracking push message delivered" counts too, because only the extension writes it:
 * a parser that lost the process name once turned a working extension into an accusation.
 */
export function extensionRanIn(
  lines: LogLine[],
  extensionName?: string
): boolean {
  return (
    ranInExtension(lines, extensionName) ||
    lines.some((line) => NSE_MARKERS.tracking.test(line.message))
  );
}

/** Delivery ids are base64url with a `dgS_` prefix — a charset without `_` and `-` misses. */
export function deliveryIdsIn(lines: LogLine[]): string[] {
  const ids = new Set<string>();
  for (const line of lines) {
    for (const match of line.message.matchAll(
      /(dgS_[A-Za-z0-9_-]{8,}={0,2})/g
    )) {
      ids.add(match[1].replace(/[,)]+$/, ''));
    }
  }
  return [...ids];
}

/**
 * The SDK's own phrasings on Android.
 *
 * The delivered metric goes through a handoff queue backed by WorkManager, and the worker
 * says either `worker success, removed key=<id>` or `worker skipped, already delivered
 * key=<id>`. Both mean the SDK sent its report; the second means it had already gone out
 * directly. They are kept as evidence and never judged: what was recorded is Customer.io's
 * to say. The verdict rests on the push being on the device and the SDK receiving it.
 *
 * The timing matters as much as the wording. A full sequence observed on API 35:
 *
 *   00.000  Received new message with deliveryId
 *   00.030  Tracking push message delivered with deliveryId
 *   00.050  handoff: appended pending entry
 *   00.160  handoff: enqueued WM
 *   05.650  handleNotificationTrigger (FCM re-delivers the message)
 *   05.900  Received duplicate message with deliveryId  ← normal, the SDK dedupes
 *   06.010  Showing notification for message
 *   38.300  handoff: worker success / skipped
 *
 * Stopping at `tracked` therefore misses the notification and the acceptance entirely — the
 * same mistake as waiting for `delivered` instead of `normal completion` on iOS.
 */
export const ANDROID_MARKERS = {
  received: /Received new message with deliveryId: /,
  tracked: /Tracking push message delivered with deliveryId: /,
  shown: /Showing notification for message: /,
  /** FCM re-delivering the same message. Evidence, never a fault. */
  duplicate: /Received duplicate message with deliveryId: /,
  handoffQueued: /\[CIO-Push-Handoff\] enqueued WM key=/,
  handoffDelivered: /\[CIO-Push-Handoff\] worker success, removed key=/,
  handoffAlreadyDelivered:
    /\[CIO-Push-Handoff\] worker skipped, already delivered key=/,
} as const;

export function androidDeliveryIds(lines: LogLine[]): string[] {
  const ids = new Set<string>();
  for (const line of lines) {
    for (const match of line.message.matchAll(
      /deliveryId[:=]\s*([A-Za-z0-9_-]{8,}={0,2})/g
    )) {
      ids.add(match[1]);
    }
  }
  return [...ids];
}
