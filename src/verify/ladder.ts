import chalk from 'chalk';
import { resolveCause } from './causes';
import { formatMs } from './clock';
import {
  Check,
  EXIT,
  MatrixCell,
  MatrixSection,
  Report,
  ReportedCause,
  Rung,
  RungId,
  Verdict,
} from './types';

/**
 * A ladder, not a checklist: rungs run in order and the first failure stops the climb,
 * because a later rung's answer is meaningless once an earlier one is broken. "The device
 * never registered a token" is not news when the extension isn't in the bundle.
 *
 * The matrix that follows preflight has the opposite rule and does not live here.
 */
export class Ladder {
  private readonly rungs: Rung[] = [];
  private matrix?: MatrixSection;
  private stopped = false;

  /** Start a rung. Returns it so checks can be pushed as they are learned. */
  open(id: RungId, title: string): Rung {
    const rung: Rung = { id, title, checks: [] };
    this.rungs.push(rung);
    return rung;
  }

  /**
   * Take a rung a checker assembled on its own, and halt if it failed. Rungs are built
   * outside the ladder so each one can be unit-tested without a climb around it.
   */
  adopt(rung: Rung, durationMs?: number): Rung {
    if (durationMs !== undefined) rung.durationMs = durationMs;
    this.rungs.push(rung);
    if (Ladder.verdictOf(rung) === 'fail') this.halt();
    return rung;
  }

  /** Record a rung that never ran. Skipped is a verdict of its own, never a pass. */
  skip(id: RungId, title: string, reason: string): Rung {
    const rung: Rung = { id, title, checks: [], skipped: reason };
    this.rungs.push(rung);
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

  /** The runtime matrix, which runs after the climb and never halts it. */
  setMatrix(section: MatrixSection): void {
    this.matrix = section;
  }

  static verdictOfMatrix(section: MatrixSection): Verdict {
    if (section.skipped) return 'skip';
    const verdicts = section.cells.map((cell: MatrixCell) => cell.verdict);
    if (verdicts.includes('fail')) return 'fail';
    if (verdicts.length === 0 || verdicts.every((v) => v === 'skip'))
      return 'skip';
    if (verdicts.includes('skip')) return 'skip';
    if (verdicts.includes('warn')) return 'warn';
    return 'pass';
  }

  get verdict(): Verdict {
    const verdicts = this.rungs.map((r) => Ladder.verdictOf(r));
    if (this.matrix) verdicts.push(Ladder.verdictOfMatrix(this.matrix));
    if (verdicts.includes('fail')) return 'fail';
    if (verdicts.includes('skip')) return 'skip';
    if (verdicts.includes('warn')) return 'warn';
    return 'pass';
  }

  get failingRung(): Rung | undefined {
    return this.rungs.find((r) => Ladder.verdictOf(r) === 'fail');
  }

  /** Every named cause, in ladder order, resolved against the registry. */
  causes(): ReportedCause[] {
    const out: ReportedCause[] = [];
    for (const rung of this.rungs) {
      for (const check of rung.checks) {
        if (!check.cause) continue;
        if (check.verdict !== 'fail' && check.verdict !== 'warn') continue;
        out.push(resolveCause(check.cause, check.evidence ?? []));
      }
    }
    for (const cell of this.matrix?.cells ?? []) {
      if (!cell.cause) continue;
      if (cell.verdict !== 'fail' && cell.verdict !== 'warn') continue;
      out.push(resolveCause(cell.cause, cell.evidence));
    }
    return out;
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
    meta: Omit<Report, 'rungs' | 'verdict' | 'causes' | 'exitCode'>
  ): Report {
    return {
      ...meta,
      rungs: this.rungs,
      matrix: this.matrix,
      verdict: this.verdict,
      causes: this.causes(),
      exitCode: this.exitCode,
    };
  }

  render(totalMs?: number): string {
    const out: string[] = [''];

    this.rungs.forEach((rung, index) => {
      const verdict = Ladder.verdictOf(rung);
      const suffix = rung.skipped
        ? chalk.dim('   (skipped)')
        : rung.durationMs !== undefined
        ? chalk.dim(`   ${formatMs(rung.durationMs)}`)
        : '';
      out.push(`  ${index + 1}  ${chalk.bold(rung.title)}${suffix}`);
      if (rung.skipped) out.push(`     ${chalk.dim(rung.skipped)}`);

      for (const check of rung.checks) {
        out.push(`     ${glyph(check.verdict)} ${check.label}`);
        for (const line of check.evidence ?? []) {
          out.push(`         ${chalk.dim(line)}`);
        }
        if (check.cause && check.verdict !== 'pass') {
          out.push(`         ${chalk.dim(check.cause)}`);
        }
      }
      if (verdict === 'pass' && rung.checks.length === 0) {
        out.push(`     ${chalk.dim('nothing to check')}`);
      }
      out.push('');
    });

    if (this.matrix) out.push(...this.renderMatrix(this.matrix));

    for (const cause of this.causes()) {
      const head =
        cause.severity === 'blocker' ? chalk.red('why') : chalk.yellow('note');
      out.push(`  ${head}  ${cause.summary}`);
      out.push(`       ${cause.remedy}`);
      if (cause.docs) out.push(`       ${chalk.dim(cause.docs)}`);
      out.push('');
    }

    const failing = this.failingRung;
    if (failing) {
      out.push(
        chalk.red(
          `  stopped at rung ${this.rungs.indexOf(failing) + 1} — ${
            failing.title
          }.`
        )
      );
    } else if (this.verdict === 'fail') {
      out.push(chalk.red('  a real push was sent and was not counted.'));
    } else if (this.verdict === 'skip') {
      out.push(chalk.yellow('  nothing was proven. skipped is not passed.'));
    } else if (this.matrix) {
      out.push(chalk.green('  push works, and the delivery was counted.'));
    } else {
      out.push(chalk.green('  preflight passed.'));
    }
    if (totalMs !== undefined) {
      out.push(chalk.dim(`  ${formatMs(totalMs)} total.`));
    }
    out.push('');
    return out.join('\n');
  }

  private renderMatrix(section: MatrixSection): string[] {
    const out: string[] = [
      `  ${chalk.bold(`${section.metric} matrix`)}${
        section.logs?.how ? chalk.dim(`   (${section.logs.how})`) : ''
      }${
        section.durationMs !== undefined
          ? chalk.dim(`   ${formatMs(section.durationMs)}`)
          : ''
      }`,
    ];

    if (section.skipped) {
      out.push(`     ${chalk.dim(section.skipped)}`, '');
      return out;
    }

    for (const cell of section.cells) {
      const took =
        cell.durationMs !== undefined
          ? chalk.dim(formatMs(cell.durationMs))
          : '';
      out.push(`     ${glyph(cell.verdict)} ${cell.state.padEnd(11)} ${took}`);
      for (const line of cell.evidence) out.push(`         ${chalk.dim(line)}`);
      if (cell.cause && cell.verdict !== 'pass') {
        out.push(`         ${chalk.dim(cell.cause)}`);
      }
    }
    if (section.logs?.evidencePath) {
      out.push(
        `     ${chalk.dim(`log written to ${section.logs.evidencePath}`)}`
      );
    }
    out.push('');
    return out;
  }
}

function glyph(verdict: Verdict): string {
  switch (verdict) {
    case 'pass':
      return chalk.green('✓');
    case 'fail':
      return chalk.red('✗');
    case 'warn':
      return chalk.yellow('!');
    default:
      return chalk.dim('-');
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
