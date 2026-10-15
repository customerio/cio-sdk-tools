import { ChildProcess } from 'child_process';
import { atExit } from '../core/cleanup';

/**
 * What every log capture hands back, whichever platform it reads: the lines so far, a way to
 * read only what came after a point, and the reason it cannot read anything when it cannot.
 */
export interface LogLine {
  /** Wall clock as the log reports it, trimmed to a readable time. */
  at: string;
  process: string;
  message: string;
  /**
   * The log type the line was written at, lowercased (`debug`, `info`, `notice`, `error`…),
   * when the reader says. A module can write at several types, so this, not its tag, says
   * which level a library was set to.
   */
  level?: string;
  /** The writer's subsystem, when the reader says (a simulator's does). */
  subsystem?: string;
}

export interface LogCapture {
  available: boolean;
  /** Why no log is being captured, ready to print as a skip reason. */
  unavailableReason?: string;
  /** How the lines are being read, for the report's evidence. */
  how?: string;
  lines: LogLine[];
  /**
   * A point in the stream, as an absolute count of lines ever seen.
   *
   * Never use `lines.length` for this. The retained window drops the oldest lines when it
   * overflows, which silently shifts every saved index — a cell on a physical Android
   * device read the wrong slice of its own capture and reported a tap it had recorded as
   * never seen. `mark()` and `since()` account for what was dropped.
   */
  mark(): number;
  since(mark: number): LogLine[];
  /** File the lines are appended to as they arrive. */
  evidencePath?: string;
  stop(): Promise<void>;
  /**
   * Why the capture stopped delivering partway through the run, if it did: its reader
   * exited after it had started. A cell judged after that has nothing to read, which is
   * not the same as the app having said nothing.
   */
  stoppedReason?(): string | undefined;
  /**
   * The stream can drop lines, so a line that is missing proves nothing. A phone's log
   * through `idevicesyslog` is: during a cold launch it lost the SDK's lines for seven taps
   * the app's own record shows were all handled. `simctl log stream` and `adb logcat` have
   * not been seen to drop anything.
   */
  lossy?: boolean;
  /**
   * Add a stream that the device itself filters to one pid, merged into this capture. A
   * phone drops lines from its whole log when it is busy, and not from a stream for one pid,
   * so a process followed from before its first line has every line in the capture. The pid
   * need not exist yet. With `only`, lines from other processes are dropped unread. Only a
   * phone's capture has it.
   */
  followProcess?(pid: number, only?: string[]): FollowedStream;
  /**
   * Which stream delivered one process's lines since the first `followProcess`. Lines only the
   * followed stream has are what the whole-log stream dropped, which is the hold doing its
   * job; a line only the whole-log stream has means the followed stream dropped one too.
   */
  compareStreams?(process: string): StreamAgreement;
}

/** One pid's stream, from `followProcess`. */
export interface FollowedStream {
  pid: number;
  how: string;
  /** Settles once the stream reaches the device, or fails to. */
  connected: Promise<FollowedProcess>;
  /** When it reached the device, in ms since the epoch. */
  connectedAt(): number | undefined;
  /** Lines from a process outside `only` arrived: someone else's process has this pid. */
  foreign(): boolean;
  /** Lines from a process in `only` arrived. */
  ours(): boolean;
  stop(): void;
}

export interface FollowedProcess {
  /** The stream reached the device, so the process's lines from now on are all in it. */
  connected: boolean;
  how: string;
  reason?: string;
}

export interface StreamAgreement {
  both: number;
  onlyFollowed: number;
  onlyMain: number;
}

/**
 * Every live capture, so an interrupt cannot leave one attached.
 *
 * `stop()` runs on the happy path only, and a run that is interrupted — or that throws
 * before its `finally` — used to orphan the stream. That is not merely untidy: a leftover
 * stream against the same target makes the *next* run's capture silently return nothing,
 * which is the exact condition this module works hardest to tell apart from an SDK that
 * did nothing. One was found alive 25 hours after the run that started it.
 */
const tracked = new WeakSet<ChildProcess>();

export function trackCapture(child: ChildProcess): void {
  if (tracked.has(child)) return;
  tracked.add(child);
  const forget = atExit(() => child.kill('SIGKILL'));
  child.once('exit', forget);
}
