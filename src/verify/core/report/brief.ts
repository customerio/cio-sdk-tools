import { Ladder } from './ladder';
import {
  Cell,
  Consent,
  Framework,
  Report,
  ReportedCause,
  Verdict,
} from './types';

/**
 * The report a customer gets unless they ask for more.
 *
 * Whoever reads it is building an app, not this tool: what passed, what did not, why, and
 * what to change. The evidence behind each finding — log lines, paths, delivery ids, timings
 * — is for debugging the tool or an unusual setup, and `--verbose` keeps it.
 */
export interface BriefReport {
  schema: 1;
  tool: { name: string; version: string };
  area: string;
  level?: string;
  project: { platform: 'ios' | 'android'; framework: Framework; name?: string };
  verdict: Verdict;
  exitCode: number;
  sections: BriefSection[];
  causes: BriefCause[];
  advice?: string[];
  consent?: Consent;
  rerunUnproven?: string;
}

export interface BriefCheck {
  id: string;
  verdict: Verdict;
  label: string;
  cause?: string;
  detail?: string;
}

export type BriefSection =
  | {
      kind: 'checks';
      id: string;
      title: string;
      verdict: Verdict;
      summary?: string;
      skipped?: string;
      /** Only the checks that did not pass: the step's verdict already says the rest did. */
      checks?: BriefCheck[];
    }
  | ({
      kind: 'cells';
      id?: string;
      verdict: Verdict;
      skipped?: string;
      cells: BriefCell[];
    } & Record<string, unknown>);

export type BriefCell = Pick<
  Cell,
  'verdict' | 'cause' | 'detail' | 'summary' | 'recorded'
> &
  Record<string, unknown>;

export type BriefCause = Omit<ReportedCause, 'evidence'>;

/** What names a section and a cell in an area's report, kept when the report is cut down. */
export interface BriefKeys {
  section?: string[];
  cell?: string[];
}

export function briefReport(report: Report, keys: BriefKeys = {}): BriefReport {
  return dropUndefined({
    schema: report.schema,
    tool: report.tool,
    area: report.area,
    level: report.level,
    project: {
      platform: report.project.platform,
      framework: report.project.framework,
      name: report.project.name,
    },
    verdict: report.verdict,
    exitCode: report.exitCode,
    sections: report.sections.map((section): BriefSection => {
      if (section.kind === 'checks') {
        return dropUndefined({
          kind: 'checks' as const,
          id: section.id,
          title: section.title,
          verdict: Ladder.verdictOf(section),
          summary: section.summary,
          skipped: section.skipped,
          checks: emptyAsUndefined(
            section.checks
              .filter((check) => check.verdict !== 'pass')
              .map((check) =>
                dropUndefined({
                  id: check.id,
                  verdict: check.verdict,
                  label: check.label,
                  cause: check.cause,
                  detail: check.detail,
                })
              )
          ),
        });
      }
      return dropUndefined({
        kind: 'cells' as const,
        id: section.id,
        ...pick(section, keys.section),
        verdict: Ladder.verdictOfMatrix(section),
        skipped: section.skipped,
        cells: section.cells.map((cell) =>
          dropUndefined({
            ...pick(cell, keys.cell),
            verdict: cell.verdict,
            cause: cell.cause,
            detail: cell.detail,
            summary: cell.summary,
            recorded:
              cell.recorded === 'not_checked' ? undefined : cell.recorded,
          })
        ),
      });
    }),
    causes: report.causes.map((cause) =>
      dropUndefined({
        code: cause.code,
        stage: cause.stage,
        severity: cause.severity,
        summary: cause.summary,
        remedy: cause.remedy,
        docs: cause.docs,
      })
    ),
    advice: report.advice,
    consent: report.consent,
    rerunUnproven: report.rerunUnproven,
  });
}

function emptyAsUndefined<T>(items: T[]): T[] | undefined {
  return items.length > 0 ? items : undefined;
}

function pick(from: object, keys: string[] = []): Record<string, unknown> {
  const source = from as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/** JSON drops undefined anyway; dropping it here keeps the objects equal in tests too. */
function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as T;
}
