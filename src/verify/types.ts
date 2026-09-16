/**
 * The report is the product.
 *
 * Whatever a rung learns has to land in here, because the LLM plugin reading `--json` can
 * only act on what is named: a stable cause code, the evidence behind it, and a remedy.
 * The terminal rendering is the secondary output.
 */

export type Verdict = 'pass' | 'fail' | 'warn' | 'skip';

export type RungId =
  | 'project_wiring'
  | 'workspace_ready'
  | 'device_ready'
  | 'profile_linked';

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
  id: RungId;
  title: string;
  checks: Check[];
  /** Set when the rung did not run at all, which is not the same as passing. */
  skipped?: string;
}

export interface ReportedCause {
  code: string;
  rung: RungId;
  severity: Severity;
  summary: string;
  remedy: string;
  docs?: string;
  evidence: string[];
}

export interface Report {
  schema: 1;
  tool: { name: string; version: string };
  command: string;
  startedAt: string;
  finishedAt: string;
  project: { path: string; framework: string; name?: string };
  rungs: Rung[];
  /** `warn` means every assertion passed but something is worth a developer's attention. */
  verdict: Verdict;
  /** The failing and warning checks, in ladder order, resolved against the registry. */
  causes: ReportedCause[];
  exitCode: number;
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
