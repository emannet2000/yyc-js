import { prePickup, cargoStates } from '../shared/planning.js';
import type { Action, Workspace } from './types';
export function actionDraftKey(id: string, action: Action, scope?: string) {
  return JSON.stringify(scope ? [id, action, scope] : [id, action]);
}
export function eligibleActionDrafts(state: Workspace): string[] {
  const keys: string[] = [];
  for (const s of state.shipments) {
    const add = (action: Action, scope?: string) =>
      keys.push(actionDraftKey(s.id, action, scope));
    const active = ['Assigned', ...cargoStates].includes(s.status);
    if (state.user.role === 'admin') {
      for (const request of s.customerRequests || [])
        if (request.status === 'pending') add('respondRequest', request.id);
      if (prePickup.includes(s.status) && s.price != null && !s.rateChange)
        add('changeRate');
      if (prePickup.includes(s.status) && s.rateChange) add('withdrawRateChange');
      if (s.status === 'Awaiting quote') add('quote');
      if (['Quote ready', 'Ready to assign', 'Offered', 'Assigned'].includes(s.status))
        add('requote');
      if (s.status === 'Ready to assign') add('offer');
      if (s.status === 'Offered' && s.offeredTo)
        add('withdrawOffer', `${s.offeredTo}:${s.offerExpiresAt}`);
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
    if (
      state.user.role === 'store' &&
      !['Delivered', 'Returned', 'Cancelled'].includes(s.status)
    ) {
      add('requestChange');
      for (const request of s.customerRequests || [])
        if (request.status === 'pending') add('withdrawRequest', request.id);
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
