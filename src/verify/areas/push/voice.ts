import { Voice } from '../../core/report/render';
import { Cell, Report, Section } from '../../core/report/types';
import { MatrixCell, MatrixSection } from './types';

/** How push says what a run proved, and only that. */
export const PUSH_VOICE: Voice = {
  command: 'verify push',
  firstSection: 'delivered',
  sectionName: (section: Section) => (section as MatrixSection).metric,
  matrixTitle: (section: string) =>
    section === 'recorded' ? "Customer.io's record" : 'Pushes',

  cellSummary(cell: Cell, section: string): string {
    if (section === 'recorded') {
      return cell.verdict === 'pass'
        ? 'recorded'
        : cell.cause ?? (cell.verdict === 'fail' ? 'not recorded' : 'not read');
    }
    // What a cell proves happened on the device: the push was received, or the tap opened
    // it. Never "counted" or "reported": what Customer.io recorded is not checked here.
    const done = section === 'opened' ? 'opened' : 'received';
    switch (cell.verdict) {
      case 'pass':
        // An opened cell's time includes the person finding and tapping the push.
        return section === 'opened' ? 'opened · tapped' : done;
      case 'fail':
        return cell.cause ?? `not ${done}`;
      case 'warn':
        return cell.cause ?? `${done}, with a caveat`;
      default:
        // A skip is a dry run only when nothing named it; the rest are inconclusive cells
        // that did send, and labelling those "not sent" was simply wrong.
        return cell.cause ?? 'not sent';
    }
  },

  cellLabel: (cell: Cell, section: string) =>
    `${(cell as MatrixCell).state} ${
      section === 'opened'
        ? 'opened'
        : section === 'recorded'
        ? 'recorded'
        : 'received'
    }`,

  failed: 'a real push was tried and did not pass.',

  conclusion(report: Report): string[] {
    const ran = report.sections.filter(
      (section) => section.kind === 'cells' && !section.skipped
    ) as unknown as MatrixSection[];
    if (ran.length === 0) {
      return [
        'the device is registered for push.',
        'nothing was sent, so delivery is not proven: --depth on-device sends real pushes.',
      ];
    }
    // Name what was actually proven, and only that. On the device: the push arrived and,
    // when the tap test ran, the tap reached the SDK. End to end: Customer.io recorded both.
    const opened = ran.some((section) => section.metric === 'opened');
    // iOS runs the extension, and the SDK reports delivered, for an app whose notifications
    // were never allowed: the pushes pass and nobody saw one. A tapped push was seen.
    const hidden =
      !opened &&
      report.causes.some(
        (cause) => cause.code === 'device.notifications_not_allowed'
      )
        ? [
            'iOS says notifications are not allowed for the app, so the pushes may have arrived without showing: allow them.',
          ]
        : [];
    if (ran.some((section) => section.metric === 'recorded')) {
      return [
        opened
          ? 'push works end to end: each push arrived, each tap reached the SDK, and Customer.io recorded both.'
          : 'push works end to end: each push arrived, and Customer.io recorded it as delivered.',
        ...hidden,
      ];
    }
    // Arrival is read from the OS either way. That the app handled a push is read from the
    // SDK's lines, so an SDK that wrote none proved arrival and nothing more.
    const quiet = ran.some((section) => section.sdkQuiet);
    return [
      opened
        ? 'push works on the device: each push arrived and each tap reached the SDK.'
        : quiet
        ? 'each push arrived on the device.'
        : 'push works on the device: each push arrived and the app handled it.',
      ...hidden,
      ...(quiet
        ? [
            "the SDK logged nothing, so only arrival was proven: set the SDK's log level to debug to see it handle them.",
          ]
        : []),
      "Customer.io's record of them wasn't checked: --depth end-to-end reads it.",
    ];
  },
};
