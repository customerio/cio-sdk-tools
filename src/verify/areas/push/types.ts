import { Ladder } from '../../core/report/ladder';
import { Cell, Section } from '../../core/report/types';

/** Push's registration steps, in the order they are reported. */
export type RungId =
  | 'project_wiring'
  | 'workspace_ready'
  | 'device_ready'
  | 'profile_linked';

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

/** Where a finding came from: a registration step, or the pushes sent to the device. */
export type Stage = RungId | 'delivered_matrix';

export type AppStateName = 'killed' | 'background' | 'foreground';

export interface MatrixCell extends Cell {
  state: AppStateName;
  /**
   * The delivery this push is: from the send when it says, otherwise from the OS's stored
   * copy of the notification or the SDK line that names the push.
   */
  deliveryId?: string;
  /** The pushed title, unique per send: how a push that turns up late is recognised. */
  title?: string;
}

/**
 * One cell per app state, and every cell runs: a push that works in one state and not in
 * another is exactly the bug worth catching.
 */
export interface MatrixSection extends Section {
  /**
   * `delivered` runs unattended; `opened` cannot, because only a real tap produces it —
   * there is no supported way to synthesise one, and `simctl openurl` invokes the URL
   * directly without ever entering the SDK's click path.
   */
  metric: 'delivered' | 'opened';
  cells: MatrixCell[];
}

/** A ladder whose sections are push's: one per metric. */
export type PushLadder = Ladder<MatrixSection>;
