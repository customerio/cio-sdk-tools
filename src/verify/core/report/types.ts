/**
 * The report is the product.
 *
 * Whatever a rung learns has to land in here, because the LLM plugin reading `--json` can
 * only act on what is named: a stable cause code, the evidence behind it, and a remedy.
 * The terminal rendering is the secondary output.
 */

export type Verdict = 'pass' | 'fail' | 'warn' | 'skip';

export type Severity = 'blocker' | 'warning';

export interface Check {
  /** Stable within a rung; the plugin keys off `cause`, humans key off `label`. */
  id: string;
  verdict: Verdict;
  label: string;
  /** Observed facts: paths, identifiers, values read off disk or off the device. */
  evidence?: string[];
  /** Set on every non-passing check, so nothing fails anonymously. */
  cause?: string;
}

export interface Rung {
  /** Named by the area that ran it. */
  id: string;
  title: string;
  checks: Check[];
  /** Set when the rung did not run at all, which is not the same as passing. */
  skipped?: string;
  /**
   * One short phrase for the roll-up line — the single fact a reader wants when the rung
   * passed. Written by the rung that knows it; the renderer only counts checks.
   */
  summary?: string;
  /**
   * Wall time spent producing this rung's evidence, which is not the same as the time
   * between rungs: the device is read before the workspace rung is evaluated though it is
   * reported after it, so each duration is attributed to the rung whose facts it bought.
   */
  durationMs?: number;
}

/**
 * One result in a section that runs every cell: a section has the opposite rule to the
 * ladder, because a failure in one cell hiding a pass in another is exactly the bug worth
 * catching. An area extends this with what identifies its cells.
 */
export interface Cell {
  verdict: Verdict;
  cause?: string;
  evidence: string[];
  /**
   * Whether Customer.io recorded what this cell proved happened on the device, when its
   * record was read: `not_checked` otherwise. The device evidence never decides it.
   */
  recorded?: 'not_checked' | 'recorded' | 'not_recorded';
  /** Everything the cell did, from staging to judging. */
  durationMs?: number;
  /** One short phrase for the roll-up line. */
  summary?: string;
}

export interface Section {
  /** Named by the area, when it names its sections. */
  id?: string;
  cells: Cell[];
  /** Set when no cell ran at all. */
  skipped?: string;
  logs?: {
    how?: string;
    evidencePath?: string;
    unavailableReason?: string;
  };
  /** The whole section, including the pauses between cells. */
  durationMs?: number;
}

export interface ReportedCause {
  code: string;
  /** The step that found it, named by the area. */
  stage: string;
  severity: Severity;
  summary: string;
  remedy: string;
  docs?: string;
  evidence: string[];
}

/**
 * One entry in a report, in the order it ran: a rung of checks, where the first failure stops
 * the climb, or a section of cells, where every cell runs.
 */
export type ReportSection =
  | (Rung & { kind: 'checks' })
  | (Section & { kind: 'cells' });

export interface Report {
  schema: 1;
  tool: { name: string; version: string };
  command: string;
  /** What was verified: `push`, and later others. */
  area: string;
  /** How far the run went, in the area's own words; absent for an area without levels. */
  level?: string;
  startedAt: string;
  finishedAt: string;
  project: { path: string; framework: string; name?: string };
  /** Everything the run checked, in order. */
  sections: ReportSection[];
  /**
   * The command that repeats this run without asking anything: every answer, picked or
   * given, as a flag.
   */
  rerun?: string;
  /**
   * The command that runs again only what could not be proven, with everything else as it
   * was. Absent when everything asked for was proven or failed outright.
   */
  rerunUnproven?: string;
  /**
   * How the facts were obtained. `read` means they were recovered from storage and the
   * server after the fact, so the moment they were written is unknown; `observed` means
   * the run watched them happen. A green report of each kind is not the same claim, and
   * rendering both as a tick hid that.
   */
  provenance: 'read' | 'observed';
  /**
   * Things worth knowing that are not findings. Freshness lives here: a run against a
   * week-old build can be perfectly green, so its age is advice for whoever orchestrates
   * the install, never an assertion about the integration.
   */
  advice?: string[];
  /**
   * Who allowed what the run sent or wrote, and what that was. Absent when nothing real was
   * due to be sent: a level that sends nothing, a dry run, or a run that stopped before.
   */
  consent?: Consent;
  /** `warn` means every assertion passed but something is worth a developer's attention. */
  verdict: Verdict;
  /** The failing and warning checks, in ladder order, resolved against the registry. */
  causes: ReportedCause[];
  exitCode: number;
}

export interface Consent {
  granted: boolean;
  /**
   * `prompt` when a person answered the question; `named` when the command line named where
   * everything goes, which is the go-ahead.
   */
  by: 'prompt' | 'named';
  /** What it covered, one line each: "3 real pushes to … through …". */
  writes: string[];
}

/**
 * Exit codes separate three outcomes that a human conflates and an agent must not: the tool
 * broke, the integration is broken, and nothing could be proven either way.
 */
export const EXIT = {
  /** Everything asserted passed. */
  ok: 0,
  /** The tool itself failed — not a verdict about the integration. */
  toolError: 1,
  /** Bad arguments or an unusable project path. */
  badInput: 2,
  /** A rung failed: the integration is broken, and the report names where. */
  verificationFailed: 20,
  /** Rungs were skipped, so the absence of a failure proves nothing. */
  inconclusive: 21,
} as const;
