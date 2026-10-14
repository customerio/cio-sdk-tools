/**
 * Wall-clock timing for the phases that cost real time.
 *
 * Deliberately independent of the narrator: the numbers matter most under `--json`, where
 * narration is silent, so a timer that only ticks when someone is watching would report
 * zeros in exactly the run a CI job reads.
 */
export function stopwatch(): () => number {
  const started = Date.now();
  return () => Date.now() - started;
}

/** Human-facing formatting. Sub-second work is noise at 3 decimal places. */
export function formatMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}
