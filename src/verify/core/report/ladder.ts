import { resolveCause } from './causes';
import {
  Cell,
  Check,
  EXIT,
  Report,
  ReportSection,
  ReportedCause,
  Rung,
  Section,
  Verdict,
} from './types';

type Entry<S> = { kind: 'checks'; rung: Rung } | { kind: 'cells'; section: S };

/**
 * A ladder, not a checklist: rungs run in order and the first failure stops the climb,
 * because a later rung's answer is meaningless once an earlier one is broken. "The device
 * never registered a token" is not news when the extension isn't in the bundle.
 *
 * Sections of cells are recorded here too, with the opposite rule: every cell runs, and
 * nothing in a section halts the climb.
 */
export class Ladder<S extends Section = Section> {
  /** Rungs and sections, in the order they ran: the report keeps that order. */
  private readonly entries: Entry<S>[] = [];
  private stopped = false;

  get rungs(): Rung[] {
    return this.entries.flatMap((entry) =>
      entry.kind === 'checks' ? [entry.rung] : []
    );
  }

  get matrices(): S[] {
    return this.entries.flatMap((entry) =>
      entry.kind === 'cells' ? [entry.section] : []
    );
  }

  /** Start a rung. Returns it so checks can be pushed as they are learned. */
  open(id: string, title: string): Rung {
    const rung: Rung = { id, title, checks: [] };
    this.entries.push({ kind: 'checks', rung });
    return rung;
  }

  /**
   * Take a rung a checker assembled on its own, and halt if it failed. Rungs are built
   * outside the ladder so each one can be unit-tested without a climb around it.
   */
  adopt(rung: Rung, durationMs?: number): Rung {
    if (durationMs !== undefined) rung.durationMs = durationMs;
    this.entries.push({ kind: 'checks', rung });
    if (Ladder.verdictOf(rung) === 'fail') this.halt();
    return rung;
  }

  /** Record a rung that never ran. Skipped is a verdict of its own, never a pass. */
  skip(id: string, title: string, reason: string): Rung {
    const rung: Rung = { id, title, checks: [], skipped: reason };
    this.entries.push({ kind: 'checks', rung });
    return rung;
  }

  get halted(): boolean {
    return this.stopped;
  }

  /** Called by a rung that found a blocker, so the caller stops opening later rungs. */
  halt(): void {
    this.stopped = true;
  }

  static verdictOf(rung: Rung): Verdict {
    if (rung.skipped) return 'skip';
    if (rung.checks.some((c) => c.verdict === 'fail')) return 'fail';
    if (rung.checks.length === 0) return 'skip';
    if (rung.checks.every((c) => c.verdict === 'skip')) return 'skip';
    if (rung.checks.some((c) => c.verdict === 'warn')) return 'warn';
    return 'pass';
  }

  /**
   * A section of cells, which runs after the climb and never halts it. Sections accumulate
   * in the order they ran.
   */
  addMatrix(section: S): void {
    // A cell says whether Customer.io's record was read, rather than leaving a reader to
    // assume it was.
    for (const cell of section.cells) cell.recorded ??= 'not_checked';
    this.entries.push({ kind: 'cells', section });
  }

  static verdictOfMatrix(section: Section): Verdict {
    if (section.skipped) return 'skip';
    const verdicts = section.cells.map((cell: Cell) => cell.verdict);
    if (verdicts.includes('fail')) return 'fail';
    if (verdicts.length === 0 || verdicts.every((v) => v === 'skip'))
      return 'skip';
    if (verdicts.includes('skip')) return 'skip';
    if (verdicts.includes('warn')) return 'warn';
    return 'pass';
  }

  get verdict(): Verdict {
    const verdicts = this.rungs.map((r) => Ladder.verdictOf(r));
    for (const section of this.matrices) {
      verdicts.push(Ladder.verdictOfMatrix(section));
    }
    if (verdicts.includes('fail')) return 'fail';
    if (verdicts.includes('skip')) return 'skip';
    if (verdicts.includes('warn')) return 'warn';
    return 'pass';
  }

  get failingRung(): Rung | undefined {
    return this.rungs.find((r) => Ladder.verdictOf(r) === 'fail');
  }

  /**
   * Every named cause, in ladder order, resolved against the registry — once each. Two
   * cells with the same cause are one finding with more evidence, and printing its summary
   * and remedy twice only made the reader look for a difference that was not there.
   */
  causes(): ReportedCause[] {
    const out: ReportedCause[] = [];
    const add = (code: string, evidence: string[]) => {
      const earlier = out.find((cause) => cause.code === code);
      if (!earlier) {
        // A copy: merging later evidence must not rewrite the first cell's own.
        out.push(resolveCause(code, [...evidence]));
        return;
      }
      for (const line of evidence) {
        if (!earlier.evidence.includes(line)) earlier.evidence.push(line);
      }
    };
    for (const entry of this.entries) {
      if (entry.kind === 'checks') {
        for (const check of entry.rung.checks) {
          if (!check.cause) continue;
          if (check.verdict !== 'fail' && check.verdict !== 'warn') continue;
          add(check.cause, check.evidence ?? []);
        }
        continue;
      }
      // A skipped cell that names a cause is inconclusive for a known reason — a rate
      // limit, a wedged simulator — and that cause's remedy is the one thing the reader
      // can act on.
      for (const cell of entry.section.cells) {
        if (!cell.cause) continue;
        if (cell.verdict === 'pass') continue;
        add(cell.cause, cell.evidence);
      }
    }
    return out;
  }

  /** Whether any matrix cell so far carries this cause. */
  matrixHasCause(code: string): boolean {
    return this.matrices.some((section) =>
      section.cells.some((cell) => cell.cause === code)
    );
  }

  get exitCode(): number {
    switch (this.verdict) {
      case 'fail':
        return EXIT.verificationFailed;
      case 'skip':
        return EXIT.inconclusive;
      default:
        return EXIT.ok;
    }
  }

  toReport(
    meta: Omit<Report, 'sections' | 'verdict' | 'causes' | 'exitCode'>
  ): Report {
    const sections: ReportSection[] = this.entries.map((entry) =>
      entry.kind === 'checks'
        ? { kind: 'checks', ...entry.rung }
        : { kind: 'cells', ...entry.section }
    );
    return {
      ...meta,
      sections,
      verdict: this.verdict,
      causes: this.causes(),
      exitCode: this.exitCode,
    };
  }
}

/** Small helpers so a rung reads as a list of findings rather than object literals. */
export function pass(
  id: string,
  label: string,
  evidence: string[] = []
): Check {
  return { id, verdict: 'pass', label, evidence };
}

export function fail(
  id: string,
  label: string,
  cause: string,
  evidence: string[] = []
): Check {
  return { id, verdict: 'fail', label, cause, evidence };
}

export function warn(
  id: string,
  label: string,
  cause: string,
  evidence: string[] = []
): Check {
  return { id, verdict: 'warn', label, cause, evidence };
}

export function skipped(id: string, label: string, reason: string): Check {
  return { id, verdict: 'skip', label, evidence: [reason] };
}
