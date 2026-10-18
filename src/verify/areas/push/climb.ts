import { Reporter } from '../../core/report/render';
import { Consent } from '../../core/report/types';
import { VerifyPushOptions } from './options';
import { PushLadder, RUNG_TITLES, RungId } from './types';

export interface ClimbResult {
  projectName?: string;
  /** Set when a real send was due, whether or not it was allowed. */
  consent?: Consent;
  /** True when the run watched a fact appear rather than reading it afterwards. */
  observed?: boolean;
  /** Advice, never an assertion: how old the build under test is. */
  freshnessNote?: string;
  /** Other advice for the end of the report. */
  notes?: string[];
}

/**
 * Record the rungs a failure made meaningless, and — when the level was going to send — the
 * pushes that were never sent because of it.
 */
export function skipRest(
  ladder: PushLadder,
  reporter: Reporter,
  ids: RungId[],
  options: Sections & Pick<VerifyPushOptions, 'send'>
): void {
  for (const id of ids) {
    const rung = ladder.skip(id, RUNG_TITLES[id], 'an earlier rung failed');
    reporter.rung(RUNG_TITLES[id]).done(rung);
  }
  if (!options.send) return;
  skipSending(
    ladder,
    options,
    'registration did not pass, so no push was sent'
  );
}

/** Which sections a sending level asked for, beyond the pushes themselves. */
export type Sections = Pick<VerifyPushOptions, 'opened' | 'recorded'>;

/**
 * Every section a sending level asked for, recorded as not run for one reason: the pushes,
 * the taps when they were asked for, and Customer.io's record when the level reads it.
 */
export function skipSending(
  ladder: PushLadder,
  sections: Sections,
  skipped: string
): void {
  ladder.addMatrix({ metric: 'delivered', cells: [], skipped });
  if (sections.opened) {
    ladder.addMatrix({ metric: 'opened', cells: [], skipped });
  }
  if (sections.recorded) {
    ladder.addMatrix({ metric: 'recorded', cells: [], skipped });
  }
}
