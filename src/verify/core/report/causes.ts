import { ReportedCause, Severity } from './types';

/**
 * The cause registry is the contract between this CLI and anything reading it — an LLM
 * plugin, a CI job, a human skimming a terminal. Codes are added, never repurposed: a
 * consumer that learned `wiring.nse_missing` must keep being right about it.
 *
 * Each entry answers the two questions a failure raises. What did the tool actually observe
 * (`summary`), and what does the developer do next (`remedy`).
 *
 * Every area brings its own catalog and registers it here, so a report can resolve any code
 * without the core knowing which area wrote it.
 */
export interface CauseDefinition {
  /** The step that finds it, named by the area. */
  stage: string;
  severity: Severity;
  summary: string;
  remedy: string;
  docs?: string;
}

export type CauseCatalog = Record<string, CauseDefinition>;

const registry = new Map<
  string,
  { area: string; definition: CauseDefinition }
>();

/**
 * Add an area's catalog. Registering the same catalog again is harmless; a code that
 * another area already owns is a defect, because two meanings for one code would make every
 * consumer of it wrong half the time.
 */
export function registerCauses(area: string, catalog: CauseCatalog): void {
  for (const [code, definition] of Object.entries(catalog)) {
    const owner = registry.get(code);
    if (owner && owner.area !== area) {
      throw new Error(
        `cause code ${code} is registered by both ${owner.area} and ${area}`
      );
    }
    registry.set(code, { area, definition });
  }
}

export function resolveCause(
  code: string,
  evidence: string[] = []
): ReportedCause {
  const definition = registry.get(code)?.definition;
  if (!definition) {
    // An unregistered code is a bug in this tool, and saying so beats reporting nothing.
    return {
      code,
      stage: 'unknown',
      severity: 'blocker',
      summary: `Unregistered cause code: ${code}`,
      remedy:
        'This is a defect in cio-sdk-tools. Please report it with the surrounding output.',
      evidence,
    };
  }
  return { code, evidence, ...definition };
}

export function severityOf(code: string): Severity {
  return registry.get(code)?.definition.severity ?? 'blocker';
}
