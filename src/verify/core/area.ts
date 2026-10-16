import { Command } from 'commander';
import { CauseCatalog } from './report/causes';

/**
 * What `verify` needs from an area, and nothing more.
 *
 * An area is one thing an integration can do — push, in-app, location — verified on its
 * own: it never checks what another area needs, because an app may not use that area at
 * all. Everything an area decides for itself lives behind this contract: its options, its
 * questions, its steps, its causes, and whether it has levels at all.
 */
export interface Area {
  /** The word after `verify`. */
  name: string;
  /** One line for `verify --help`. */
  summary: string;
  /** Every step the area can run, so the levels can be checked against them. */
  steps: Step[];
  /** How far a run can go, in the area's own words. Absent when the area has no levels. */
  levels?: Level[];
  /** The area's cause codes, registered so any report can resolve them. */
  causes: CauseCatalog;
  /** The `verify <name>` command: the area's own options, help and run. */
  command(): Command;
}

/** One unit of a run that reports its own result: a rung of checks or a section of cells. */
export interface Step {
  id: string;
  title: string;
}

/**
 * How far a run goes. The core assumes nothing about levels beyond this: not their names,
 * not how many there are, not even that each includes the one before. An area that wants
 * them to build on each other lists the earlier steps again.
 */
export interface Level {
  id: string;
  /** A short name for the question that asks for it: "On the device". */
  label: string;
  /** A few words beside the label in that question: "nothing is sent". */
  hint?: string;
  /** One line, for the help and the question that asks for it. */
  title: string;
  /** Every step this level runs, in order. */
  steps: string[];
  /** Set when the level cannot run yet, saying why. */
  unavailable?: string;
}
