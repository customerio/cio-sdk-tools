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
  // Rounded before it is split, so 59.95s reads 1m00s and 1m59.5s reads 2m00s, never 60s.
  if (Math.round(ms / 100) < 600) return `${(ms / 1_000).toFixed(1)}s`;
  const total = Math.round(ms / 1_000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}
