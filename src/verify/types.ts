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

/**
 * Titles are shared because they are read in two places that must agree: the roll-up
 * column and the report a plugin reads. They drifted once — the column said "Profile
 * linked" while the report said "Profile linked to this device".
 */
export const RUNG_TITLES: Record<RungId, string> = {
  project_wiring: 'Project wiring',
  workspace_ready: 'Workspace ready',
  device_ready: 'Device ready',
  profile_linked: 'Profile linked',
};

/** Where a finding came from: a preflight rung, or the runtime matrix. */
export type Stage = RungId | 'delivered_matrix';

export type AppStateName = 'killed' | 'background' | 'foreground';

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

export interface MatrixCell {
  state: AppStateName;
  verdict: Verdict;
  cause?: string;
  evidence: string[];
  /** As returned by the send, for correlating against the log. */
  deliveryId?: string;
  /** Staging the app state, sending, and following the push to the metric. */
  durationMs?: number;
  /** One short phrase for the roll-up line. */
  summary?: string;
}

/**
 * The matrix has the opposite rule to the ladder: every cell runs, because a failure in one
 * app state hiding a pass in another is exactly the bug worth catching.
 */
export interface MatrixSection {
  metric: 'delivered';
  cells: MatrixCell[];
  /** Set when no cell ran at all. */
  skipped?: string;
  logs?: {
    how?: string;
    evidencePath?: string;
    unavailableReason?: string;
  };
  /** The whole matrix, including the pauses between cells. */
  durationMs?: number;
}

export interface ReportedCause {
  code: string;
  stage: Stage;
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
  /** Absent unless a real push was sent. */
  matrix?: MatrixSection;
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
