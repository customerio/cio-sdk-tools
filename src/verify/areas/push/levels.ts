import { Level, Step } from '../../core/area';
import { RUNG_TITLES } from './types';

/** Everything push can check, in the order a run reports it. */
export const PUSH_STEPS: Step[] = [
  { id: 'project_wiring', title: RUNG_TITLES.project_wiring },
  { id: 'workspace_ready', title: RUNG_TITLES.workspace_ready },
  { id: 'device_ready', title: RUNG_TITLES.device_ready },
  { id: 'profile_linked', title: RUNG_TITLES.profile_linked },
  { id: 'received', title: 'A real push in each app state reached the app' },
  { id: 'opened', title: 'A tap on each push reached the SDK' },
  { id: 'recorded', title: 'Customer.io recorded each push' },
];

const registration = [
  'project_wiring',
  'workspace_ready',
  'device_ready',
  'profile_linked',
];
// `opened` needs a person to tap, so it runs only when one is asked to.
const onDevice = [...registration, 'received', 'opened'];

/** Push's levels build on each other: each one runs everything before it, then more. */
export const PUSH_LEVELS: Level[] = [
  {
    id: 'registration',
    title: 'the device is registered for push; nothing is sent',
    steps: registration,
  },
  {
    id: 'on-device',
    title: 'real pushes, checked on the device',
    steps: onDevice,
  },
  {
    id: 'end-to-end',
    title: 'Customer.io recorded each push',
    steps: [...onDevice, 'recorded'],
    unavailable:
      "Customer.io doesn't record test pushes yet, so there is nothing to read back",
  },
];
