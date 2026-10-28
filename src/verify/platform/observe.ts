import { formatMs, stopwatch } from '../core/clock';
import { Asker } from '../core/prompt';
import { Reporter } from '../core/report/render';

/**
 * Watching an integration happen, instead of reading what it left behind.
 *
 * Preflight is archaeology: it recovers a token from a plist and an identity from another
 * one, with no idea when either was written. That is why a stale token read exactly like a
 * live one, and why the report has to say `read` rather than `observed`.
 *
 * This mode inverts it. A log capture opens first, then the run waits for the app to be
 * installed, for the SDK to register a token, and for a login to land — and each of those
 * becomes a timestamped observation rather than an inference. The verdicts do not change:
 * they still come from the local state plus the server's confirmation, because the SDK
 * deliberately handles a token that arrives before a login (the event bus caches and
 * replays `RegisterDeviceTokenEvent`), so asserting an order would convict integrations
 * that are working as designed. What changes is that a green result now means "this
 * happened while I watched" instead of "this was true at some unknown point".
 *
 * Who acts is the caller's business. A person reads the instruction and does it; an agent
 * that has just run an install has nothing to read and simply finds the state already
 * true. Both paths poll, so neither needs a keypress — but a keypress is accepted as a
 * nudge from anyone who would rather not wait for the next tick.
 */
export interface Step<T> {
  /** What the person (or agent) has to do before this can become true. */
  instruction: string;
  /** Short label for the progress line. */
  label: string;
  /** Returns the value once it is there, or undefined while it is not. */
  probe(): Promise<T | undefined>;
}

export interface Observed<T> {
  value?: T;
  /** When the probe first succeeded, which is the whole point of this mode. */
  at?: Date;
  waitedMs: number;
  timedOut: boolean;
}

export interface WatchOptions {
  asker: Asker;
  /** Progress line, so a two-minute wait is visibly alive. */
  onPhase?: (text: string) => void;
  /** Printed once per step, where a person can read it. */
  onInstruction?: (text: string) => void;
  timeoutMs?: number;
  intervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_INTERVAL_MS = 1_500;

/**
 * Poll until the thing is true, printing what needs doing and how long it has been.
 *
 * The timeout is generous — three minutes, not the sixty seconds a question gets, because
 * this one is waiting on a build and a human, not on a keystroke.
 */
export async function watchFor<T>(
  step: Step<T>,
  options: WatchOptions
): Promise<Observed<T>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const elapsed = stopwatch();

  // Already true: say nothing and get on with it. This is the agent's path, and the path
  // of anyone verifying an app that is already installed and running.
  const immediate = await step.probe();
  if (immediate !== undefined) {
    return { value: immediate, waitedMs: elapsed(), timedOut: false };
  }

  options.onInstruction?.(step.instruction);

  for (;;) {
    if (elapsed() >= timeoutMs) {
      return { waitedMs: elapsed(), timedOut: true };
    }
    options.onPhase?.(`${step.label} · waited ${formatMs(elapsed())}`);
    await sleep(intervalMs);
    const value = await step.probe();
    if (value !== undefined) {
      return { value, at: new Date(), waitedMs: elapsed(), timedOut: false };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How stale is this build?
 *
 * Advice, never an assertion. A run against a build installed last week can still be
 * perfectly green, and calling that a failure would be wrong; but a fresh install is the
 * stronger result, and the agent orchestrating the install is the one that can act on it.
 */
export function freshness(options: {
  installedAt?: Date;
  now?: Date;
  /** The run watched the install happen, so freshness is not in question. */
  observed?: boolean;
}): { verdict: 'observed' | 'fresh' | 'stale' | 'unknown'; note?: string } {
  if (options.observed) return { verdict: 'observed' };
  if (!options.installedAt) return { verdict: 'unknown' };
  const now = options.now ?? new Date();
  const ageMs = now.getTime() - options.installedAt.getTime();
  if (ageMs < 0) return { verdict: 'unknown' };
  if (ageMs <= ONE_HOUR_MS) return { verdict: 'fresh' };
  return {
    verdict: 'stale',
    note: `this build was installed ${formatAge(ageMs)} ago`,
  };
}

const ONE_HOUR_MS = 60 * 60 * 1_000;

function formatAge(ms: number): string {
  const hours = Math.round(ms / ONE_HOUR_MS);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
export function askerPhases(
  input: { reporter: Reporter; asker: Asker },
  handle: { phase(text: string): void }
): {
  asker: Asker;
  onPhase: (text: string) => void;
  onInstruction: (text: string) => void;
} {
  return {
    asker: input.asker,
    onPhase: (text) => handle.phase(text),
    // Instructions are for a person; an agent that has already installed the build never
    // sees them, because the probe is true on the first tick.
    onInstruction: (text) => input.reporter.note(text),
  };
}
