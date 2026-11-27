/**
 * The states an app can be put in before something is sent to it. Each platform has its own
 * way of getting there; what each state means is the same on both.
 */
export type AppState = 'foreground' | 'background' | 'killed';

export const ALL_STATES: AppState[] = ['killed', 'background', 'foreground'];

export interface StateResult {
  ok: boolean;
  /** How the state was reached, which matters for how much the cell proves. */
  how: string;
  error?: string;
}
