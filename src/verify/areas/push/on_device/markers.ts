import { sdkEvent } from '../../../platform/sdk_events';
import {
  SdkPlatform,
  compareVersions,
  versionChecked,
} from '../../../platform/sdk_version';

/**
 * Every line this tool reads off a device, in one place.
 *
 * An SDK's line is read by its key tail when it carries one (` || ev=… key=value`, which the
 * SDK holds still in its contract tests) and by its sentence when it doesn't, which is every
 * SDK released before that contract. Sentences change wording; `literal` is the fixed part
 * of each as the SDK's source spells it, which the SDK canary looks for in every new release
 * (scripts/sdk-canary.js). The OS's lines are read by sentence only, and the canary has no
 * source to check them against.
 */
export interface Marker {
  owner: 'ios-sdk' | 'android-sdk' | 'os';
  /** The sentence; its named groups are the same fields the tail carries. */
  sentence: RegExp;
  /** The fixed part of the sentence in the SDK's source. */
  literal?: string;
  /** The tail's event, and the values its fields must have. */
  ev?: string;
  where?: Record<string, string[]>;
  /** The first SDK version that writes the sentence. */
  since?: string;
}

/** The fields a line gives for a marker, or nothing when it is not that marker's line. */
export function lineMatch(
  marker: Marker,
  message: string
): Record<string, string> | undefined {
  const event = marker.ev ? sdkEvent(message) : undefined;
  if (event) {
    if (event.ev !== marker.ev) return undefined;
    for (const [key, values] of Object.entries(marker.where ?? {})) {
      if (!values.includes(event.fields[key])) return undefined;
    }
    return event.fields;
  }
  const match = marker.sentence.exec(message);
  return match ? { ...(match.groups ?? {}) } : undefined;
}

export function matches(marker: Marker, message: string): boolean {
  return lineMatch(marker, message) !== undefined;
}

/**
 * The first SDK version whose sentences all the judged lines here are: iOS's tap lines date
 * from 3.10, Android's push lines from 4.6. Older SDKs say less, so what they leave out is no
 * fault of the app.
 */
export const SENTENCES_SINCE: Record<SdkPlatform, string> = {
  ios: '3.10.0',
  android: '4.6.0',
};

/**
 * Whether a missing SDK line means anything: the version is one whose sentences this tool
 * was checked against. An unknown version is not.
 */
export function linesChecked(
  platform: SdkPlatform,
  version: string | undefined
): boolean {
  return (
    versionChecked(platform, version) &&
    compareVersions(version as string, SENTENCES_SINCE[platform]) >= 0
  );
}

/**
 * The SDK's line with the OS's answer on notifications for the app, the same sentence on both
 * platforms: `[Push] Notification permission: <status>`, logged at debug when the SDK reads it
 * (its device update, the app coming to the front, a push shown in the foreground, the iOS
 * extension). Support asks customers for debug logs, so it is in theirs too.
 */
export const NOTIFICATION_PERMISSION: Marker = {
  owner: 'ios-sdk',
  sentence: /^\[Push\] Notification permission: (?<status>\S+)/,
  literal: 'Notification permission: ',
  ev: 'push.permission',
};

/**
 * The extension's phrasings, anchored deliberately.
 *
 * A loose filter has twice produced a false result here: a bare /handled/ matched kernel
 * `unhandled kAMPDUStat_` spam, and a bare /Successfully/ reported three errored sends as
 * passing. Each pattern below is the SDK's exact sentence.
 */
export const NSE_MARKERS = {
  tracking: {
    owner: 'ios-sdk',
    sentence:
      /Tracking push message delivered(?: with deliveryId: (?<id>\S+))?/,
    literal: 'Tracking push message delivered with deliveryId: ',
    ev: 'push.delivered',
    since: '3.10.0',
  },
  accepted: {
    owner: 'ios-sdk',
    sentence: /Successfully tracked push metric 'delivered'/,
    literal: "Successfully tracked push metric '",
  },
  /** Fires at the end of the sequence; `delivered` fires mid-way and truncates a capture. */
  completion: {
    owner: 'ios-sdk',
    sentence: /invoking contentHandler|normal completion/,
    literal: 'normal completion',
  },
  richFinished: {
    owner: 'ios-sdk',
    sentence: /rich push step finished/,
    literal: 'rich push step finished',
  },
} satisfies Record<string, Marker>;

/** The SDK's own phrasings on Android; see sdk_lines.ts for the sequence they come in. */
export const ANDROID_MARKERS = {
  received: {
    owner: 'android-sdk',
    sentence: /Received new message with deliveryId: (?<id>\S+)/,
    literal: 'Received new message with deliveryId: ',
    ev: 'push.received',
    since: '4.6.0',
  },
  tracked: {
    owner: 'android-sdk',
    sentence: /Tracking push message delivered with deliveryId: (?<id>\S+)/,
    literal: 'Tracking push message delivered with deliveryId: ',
    ev: 'push.delivered',
    since: '4.6.0',
  },
  shown: {
    owner: 'android-sdk',
    sentence: /Showing notification for message: /,
    literal: 'Showing notification for message: ',
    ev: 'push.shown',
    since: '4.6.0',
  },
  /** FCM re-delivering the same message. Evidence, never a fault. */
  duplicate: {
    owner: 'android-sdk',
    sentence: /Received duplicate message with deliveryId: (?<id>\S+)/,
    literal: 'Received duplicate message with deliveryId: ',
    ev: 'push.duplicate',
  },
  /** The data map line that names a push's title and id together (see identity.ts). */
  dataMap: {
    owner: 'android-sdk',
    sentence: /(?:Received|Showing) notification for message: \{/,
    literal: 'notification for message: ',
  },
  handoffQueued: {
    owner: 'android-sdk',
    sentence: /\[CIO-Push-Handoff\] enqueued WM key=/,
    literal: 'enqueued WM key=',
  },
  handoffDelivered: {
    owner: 'android-sdk',
    sentence: /\[CIO-Push-Handoff\] worker success, removed key=/,
    literal: 'worker success, removed key=',
  },
  handoffAlreadyDelivered: {
    owner: 'android-sdk',
    sentence: /\[CIO-Push-Handoff\] worker skipped, already delivered key=/,
    literal: 'worker skipped, already delivered key=',
  },
  /**
   * WorkManager's own line for the delivered-metric worker, which the SDK queues for each push
   * it processes. Written at WorkManager's level, so it speaks for an SDK that logs nothing: a
   * React Native app started for a push runs no JavaScript to set the SDK's level. Matched by
   * the tag the SDK gives its work (`cio-push-delivery`), not by the worker's class name.
   */
  metricsWorker: {
    owner: 'os',
    sentence: /Worker result SUCCESS for Work .*\bcio-push-delivery\b/,
    since: '4.11.0',
  },
} satisfies Record<string, Marker>;

/** The SDK's tag for its delivered-metric work, which WorkManager prints in its lines. */
export const PUSH_DELIVERY_WORK_TAG = 'cio-push-delivery';

/** What a tap leaves in an iOS log. */
export const OPENED_MARKERS = {
  /** The OS handed the click to the SDK at all. */
  clicked: {
    owner: 'ios-sdk',
    sentence: /Clicked (?:notification for message|CIO push message)/,
    literal: 'Clicked CIO push message',
    ev: 'push.clicked',
    where: { cio: ['true'] },
    since: '3.10.0',
  },
  /** The SDK handling the open, naming the delivery it belongs to. */
  tracked: {
    owner: 'ios-sdk',
    sentence: /Tracking push message opened with deliveryId: (?<id>\S+)/,
    literal: 'Tracking push message opened with deliveryId: ',
    ev: 'push.opened',
    since: '3.10.0',
  },
  /** The SDK saw a click it decided was not ours. */
  foreign: {
    owner: 'ios-sdk',
    sentence: /Clicked non CIO push message/,
    literal: 'Clicked non CIO push message',
    ev: 'push.clicked',
    where: { cio: ['false'] },
  },
  emptyId: {
    owner: 'ios-sdk',
    sentence: /Clicked message with empty deliveryId/,
    literal: 'Clicked message with empty deliveryId',
    ev: 'push.clicked',
    where: { id: ['none'] },
  },
  /** Deep link: attempted, then one of four outcomes, then the failure. */
  linkHandling: {
    owner: 'ios-sdk',
    sentence: /Handling push notification deep link with url: (?<url>\S+)/,
    literal: 'Handling push notification deep link with url: ',
    ev: 'push.deep_link',
  },
  linkHandled: {
    owner: 'ios-sdk',
    sentence:
      /Deep link handled by (?:host app callback implementation|internal host app navigation|system)/,
    literal: 'Deep link handled by ',
    ev: 'push.deep_link_outcome',
    where: { outcome: ['app_callback', 'app_navigation', 'system'] },
  },
  linkUnhandled: {
    owner: 'ios-sdk',
    sentence: /Deep link was not handled/,
    literal: 'Deep link was not handled',
    ev: 'push.deep_link_outcome',
    where: { outcome: ['not_handled'] },
  },
  /**
   * The SDK handed the link to iOS. Before the SDK logged iOS's answer, it said this whatever
   * iOS then did with it.
   */
  linkBySystem: {
    owner: 'ios-sdk',
    sentence: /Deep link handled by system/,
    literal: 'Deep link handled by system',
    ev: 'push.deep_link_outcome',
    where: { outcome: ['system'] },
  },
  /**
   * iOS could not open what it was handed, logged by LaunchServices in the app's own process
   * (`Code=-10814`: no app for the URL). The URL itself is redacted on a phone.
   */
  linkOpenFailed: { owner: 'os', sentence: /^Failed to open URL / },
  /**
   * iOS itself handing the tap to the app, logged by UIKit in the app's own process. It
   * proves the tap happened whatever the SDK does next — on a phone, a cold launch from a
   * tap logged these and the SDK logged nothing, which the cell used to call a tap that
   * never arrived. (A simulator's capture is filtered to the SDK, so it never sees them.)
   */
  osDelivered: {
    owner: 'os',
    sentence:
      /Decode <UINotificationResponseAction|Received action\(s\) in scene-(?:create|update): <UINotificationResponseAction/,
  },
} satisfies Record<string, Marker>;

/**
 * `opened` on Android: the same claim, a different set of sentences.
 *
 * The SDK's wording differs from iOS — the metric line carries the whole parsed payload
 * rather than a bare delivery id, and there are two extra deep-link outcomes because
 * Android can hand a URL to another app or fall back to the launcher.
 */
export const ANDROID_OPENED_MARKERS = {
  tracked: {
    owner: 'android-sdk',
    sentence: /Tracking push message opened with payload: (?<payload>.+)/,
    literal: 'Tracking push message opened with payload: ',
    ev: 'push.opened',
    since: '4.6.0',
  },
  skippedNoId: {
    owner: 'android-sdk',
    sentence:
      /Skipping opened metric for notification without a delivery id\/token/,
    literal:
      'Skipping opened metric for notification without a delivery id/token',
    ev: 'push.open_skipped',
    since: '4.20.0',
  },
  /** An error-level line, written whatever the SDK's level. */
  failedClick: {
    owner: 'android-sdk',
    sentence: /Failed to handle push click/,
    literal: 'Failed to handle push click',
  },
  linkHandling: {
    owner: 'android-sdk',
    sentence:
      /Handling push notification deep link with payload: .* - pushClickBehavior: (?<behavior>\S+)/,
    literal: 'Handling push notification deep link with payload: ',
    ev: 'push.deep_link',
  },
  linkHandled: {
    owner: 'android-sdk',
    sentence:
      /Deep link handled by (?:host app callback implementation|internal host app navigation|external app)/,
    literal: 'Deep link handled by ',
    ev: 'push.deep_link_outcome',
    where: { outcome: ['app_callback', 'app_navigation', 'external_app'] },
  },
  /**
   * Nothing on the device could open the link, so the SDK opened the app's main screen
   * (PushMessageProcessorImpl). The same line ends a tap that carried no link, where it is
   * the whole job; with a link, the link went nowhere. Counted as handled, a link no app
   * routes passed on the S24 (2026-10-16).
   */
  linkFellBack: {
    owner: 'android-sdk',
    sentence: /Deep link handled by opening default host app/,
    literal: 'Deep link handled by opening default host app',
    ev: 'push.deep_link_outcome',
    where: { outcome: ['default_app'] },
  },
  linkUnhandled: {
    owner: 'android-sdk',
    sentence: /Deep link was not handled/,
    literal: 'Deep link was not handled',
    ev: 'push.deep_link_outcome',
    where: { outcome: ['not_handled'] },
  },
} satisfies Record<string, Marker>;

/**
 * Everything the SDKs' sources must still say for this tool to read them, for the canary:
 * each SDK sentence's fixed part, the tail events, and the names of the stores read off a
 * device (docs/verify-contract.md).
 */
export function canaryLiterals(): Record<'ios' | 'android', string[]> {
  const groups: Record<string, Marker>[] = [
    NSE_MARKERS,
    ANDROID_MARKERS,
    OPENED_MARKERS,
    ANDROID_OPENED_MARKERS,
    { permission: NOTIFICATION_PERMISSION },
  ];
  const ios = new Set<string>();
  const android = new Set<string>();
  for (const marker of groups.flatMap((group) => Object.values(group))) {
    if (!marker.literal) continue;
    if (marker.owner === 'ios-sdk' || marker === NOTIFICATION_PERMISSION) {
      ios.add(marker.literal);
    }
    if (marker.owner === 'android-sdk' || marker === NOTIFICATION_PERMISSION) {
      android.add(marker.literal);
    }
  }
  return {
    ios: [
      ...ios,
      'pushDeviceToken',
      'io.customer.sdk.background',
      'delivery_context.json',
    ],
    android: [
      ...android,
      PUSH_DELIVERY_WORK_TAG,
      'device_token',
      'config_settings',
    ],
  };
}
