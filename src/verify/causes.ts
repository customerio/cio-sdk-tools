import { ReportedCause, RungId, Severity } from './types';

/**
 * The cause registry is the contract between this CLI and anything reading it — an LLM
 * plugin, a CI job, a human skimming a terminal. Codes are added, never repurposed: a
 * consumer that learned `wiring.nse_missing` must keep being right about it.
 *
 * Each entry answers the two questions a failure raises. What did the tool actually observe
 * (`summary`), and what does the developer do next (`remedy`).
 */
export interface CauseDefinition {
  rung: RungId;
  severity: Severity;
  summary: string;
  remedy: string;
  docs?: string;
}

const IOS_PUSH_DOCS = 'https://www.customer.io/docs/sdk/ios/push/';
const IOS_RICH_PUSH_DOCS =
  'https://www.customer.io/docs/sdk/ios/push/#rich-push';
const IOS_GETTING_STARTED_DOCS =
  'https://www.customer.io/docs/sdk/ios/getting-started/';

export const CAUSES: Record<string, CauseDefinition> = {
  'wiring.sdk_absent': {
    rung: 'project_wiring',
    severity: 'blocker',
    summary: 'The Customer.io SDK is not a dependency of this project.',
    remedy:
      'Add the SDK before anything else. Every later finding would be a consequence of its absence rather than a cause.',
    docs: IOS_GETTING_STARTED_DOCS,
  },
  'wiring.init_absent': {
    rung: 'project_wiring',
    severity: 'blocker',
    summary: 'No call to CustomerIO.initialize was found in the app sources.',
    remedy:
      'Initialize the SDK from the app delegate launch method. Without it the SDK never registers for push and never reports a metric.',
    docs: IOS_GETTING_STARTED_DOCS,
  },
  'wiring.init_not_at_launch': {
    rung: 'project_wiring',
    severity: 'blocker',
    summary:
      'CustomerIO.initialize runs from a SwiftUI view body, which is re-evaluated on every redraw and carries no guarantee of running before the system delivers a launch push.',
    remedy:
      'Move initialization into the app delegate launch method, or into the App type initializer.',
    docs: IOS_GETTING_STARTED_DOCS,
  },
  'wiring.init_launch_unproven': {
    rung: 'project_wiring',
    severity: 'warning',
    summary:
      'CustomerIO.initialize was found, but no path from a launch method to it could be resolved.',
    remedy:
      'Nothing to fix if initialization runs at launch through a helper the tool could not follow. Worth a glance: initialization that runs later than launch loses pushes that arrive before it.',
  },
  'wiring.nse_missing': {
    rung: 'project_wiring',
    severity: 'blocker',
    summary: 'The project has no Notification Service Extension target.',
    remedy:
      'Add a Notification Service Extension and forward its requests to the SDK. Without it iOS shows the push, but nothing attaches rich content and nothing counts a delivery.',
    docs: IOS_RICH_PUSH_DOCS,
  },
  'wiring.nse_multiple': {
    rung: 'project_wiring',
    severity: 'blocker',
    summary:
      'More than one Notification Service Extension is embedded in the app.',
    remedy:
      'iOS runs exactly one service extension per notification, and which one is not something you control. Keep one and forward to the SDK from it.',
    docs: IOS_RICH_PUSH_DOCS,
  },
  'wiring.nse_not_embedded': {
    rung: 'project_wiring',
    severity: 'blocker',
    summary:
      'A Notification Service Extension target exists but the app does not embed it.',
    remedy:
      'Add the extension to the app target as a dependency and to its Embed Foundation Extensions phase. An extension that ships outside the app bundle is never launched.',
    docs: IOS_RICH_PUSH_DOCS,
  },
  'wiring.nse_does_not_forward': {
    rung: 'project_wiring',
    severity: 'warning',
    summary:
      'The Notification Service Extension never hands the request to the SDK.',
    remedy:
      'Call MessagingPush.shared.didReceive(request, withContentHandler:) from didReceive. This is the invisible failure: the push still arrives and still displays, and no delivery is ever counted.',
    docs: IOS_RICH_PUSH_DOCS,
  },
  'wiring.app_group_mismatch': {
    rung: 'project_wiring',
    severity: 'blocker',
    summary:
      'The App Group in the extension code is not granted by the extension entitlements.',
    remedy:
      'The same App Group has to appear in three places: the app entitlements, the extension entitlements, and appGroupId() in code. Two out of three is the shape that survives code review and fails at runtime.',
    docs: IOS_RICH_PUSH_DOCS,
  },
  'wiring.app_group_absent': {
    rung: 'project_wiring',
    severity: 'warning',
    summary: 'No App Group is configured for the extension.',
    remedy:
      'Configure an App Group so the extension can hand metrics back to the app when it cannot report them itself. Delivery tracking works without it in the common case and loses events in the slow-network one.',
    docs: IOS_RICH_PUSH_DOCS,
  },
  'wiring.push_capability_missing': {
    rung: 'project_wiring',
    severity: 'blocker',
    summary: 'The app entitlements do not declare aps-environment.',
    remedy:
      'Add the Push Notifications capability to the app target. Without it APNs never issues a token, so there is nothing to send to.',
    docs: IOS_PUSH_DOCS,
  },
  'wiring.entitlements_missing': {
    rung: 'project_wiring',
    severity: 'blocker',
    summary: 'The app target has no entitlements file.',
    remedy:
      'Add the Push Notifications capability to the app target; Xcode creates the entitlements file with it.',
    docs: IOS_PUSH_DOCS,
  },
};

export function resolveCause(
  code: string,
  evidence: string[] = []
): ReportedCause {
  const definition = CAUSES[code];
  if (!definition) {
    // An unregistered code is a bug in this tool, and saying so beats reporting nothing.
    return {
      code,
      rung: 'project_wiring',
      severity: 'blocker',
      summary: `Unregistered cause code: ${code}`,
      remedy:
        'This is a defect in cio-sdk-tools. Please report it with the surrounding output.',
      evidence,
    };
  }
  return { code, evidence, ...definition };
}

export function severityOf(code: string): Severity {
  return CAUSES[code]?.severity ?? 'blocker';
}
