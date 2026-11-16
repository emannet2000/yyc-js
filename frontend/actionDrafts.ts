import { prePickup, cargoStates } from '../shared/planning.js';
import type { Action, Workspace } from './types';
export function actionDraftKey(id: string, action: Action) {
  return JSON.stringify([id, action]);
}
export function eligibleActionDrafts(state: Workspace): string[] {
  const keys: string[] = [];
  for (const s of state.shipments) {
    const add = (action: Action) => keys.push(actionDraftKey(s.id, action));
    const active = ['Assigned', ...cargoStates].includes(s.status);
    if (state.user.role === 'admin') {
      if (s.status === 'Awaiting quote') add('quote');
      if (['Quote ready', 'Ready to assign', 'Offered', 'Assigned'].includes(s.status))
        add('requote');
      if (s.status === 'Ready to assign') add('offer');
      if (active && s.driverId)
        add(s.handover && s.offeredTo ? 'withdrawHandover' : 'handover');
      if (s.issue && !s.issue.resolved) add('resolve');
      if (prePickup.includes(s.status)) {
        add('change');
        add('reschedule');
      }
      if (s.status === 'Delivery failed') add('redeliver');
      if (['In transit', 'Delivery failed'].includes(s.status)) add('return');
    }
    if (state.user.role === 'driver' && s.driverId === state.user.id) {
      if (s.status === 'In transit') add('failDelivery');
      if (s.status === 'Returning' && (!s.issue || s.issue.resolved))
        add('confirmReturn');
    }
    if (
      state.user.role === 'driver' &&
      s.driverId === state.user.id &&
      active &&
      (!s.issue || s.issue.resolved)
    )
      add('issue');
  }
  return keys;
}
