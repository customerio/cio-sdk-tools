import { Reporter } from '../../core/report/render';
import { Consent } from '../../core/report/types';
import { PushLadder, RUNG_TITLES, RungId } from './types';

export interface ClimbResult {
  projectName?: string;
  /** Set when a real send was due, whether or not it was allowed. */
  consent?: Consent;
  /** True when the run watched a fact appear rather than reading it afterwards. */
  observed?: boolean;
  /** Advice, never an assertion: how old the build under test is. */
  freshnessNote?: string;
}

export function skipRest(
  ladder: PushLadder,
  reporter: Reporter,
  ids: RungId[]
): void {
  for (const id of ids) {
    const rung = ladder.skip(id, RUNG_TITLES[id], 'an earlier rung failed');
    reporter.rung(RUNG_TITLES[id]).done(rung);
  }
  ladder.addMatrix({
    metric: 'delivered',
    cells: [],
    skipped: 'preflight did not pass, so no push was sent',
  });
}
