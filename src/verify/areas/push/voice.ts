import { Voice } from '../../core/report/render';
import { Cell, Report, Section } from '../../core/report/types';
import { MatrixCell, MatrixSection } from './types';

/** How push says what a run proved, and only that. */
export const PUSH_VOICE: Voice = {
  command: 'verify push',
  firstSection: 'delivered',
  sectionName: (section: Section) => (section as MatrixSection).metric,
  matrixTitle: () => 'Pushes',

  cellSummary(cell: Cell, section: string): string {
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
      section === 'opened' ? 'opened' : 'received'
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
    // when the tap test ran, the tap reached the SDK. Whether Customer.io recorded either
    // is not checked — a test send has no stored delivery to read back yet.
    const opened = ran.some((section) => section.metric === 'opened');
    return [
      opened
        ? 'push works on the device: each push arrived and each tap reached the SDK.'
        : 'push works on the device: each push arrived and the app handled it.',
      "Customer.io's record of them isn't checked yet.",
    ];
  },
};
