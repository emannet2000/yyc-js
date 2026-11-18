import { driverAvailable } from '../shared/scheduling.js';
import { redeliveryBlocker } from '../shared/planning.js';

export function startCargoReturn(s, reason) {
  Object.assign(s, {
    status: 'Returning',
    returnDestination: s.pickup,
    returnReason: reason,
  });
  delete s.arrivedAt;
}

export function applyCargoAction(
  s,
  user,
  data,
  { allowed, requireThat, text, now, scheduleInput, commitments, driverCanAct },
) {
  const admin = user.role === 'admin';
  const assigned = user.role === 'driver' && s.driverId === user.id;
  switch (data.action) {
    case 'failDelivery':
      allowed(assigned && s.status === 'In transit');
      s.failedAttempts = [
        ...(s.failedAttempts || []),
        {
          reason: text(data, 'reason'),
          note: text(data, 'note'),
          time: new Date(now()).toISOString(),
          driverId: user.id,
          arrivedAt: s.arrivedAt || null,
          redeliveryPlan: s.redeliveryPlan,
        },
      ];
      s.status = 'Delivery failed';
      delete s.arrivedAt;
      return `Delivery attempt failed: ${s.failedAttempts.at(-1).reason}`;
    case 'redeliver': {
      allowed(admin && s.status === 'Delivery failed');
      const blocker = redeliveryBlocker(s, driverCanAct(s.driverId));
      requireThat(!blocker, 409, blocker);
      const plan = scheduleInput(data);
      const reason = text(data, 'reason');
      requireThat(
        driverAvailable(
          { ...s, redeliveryPlan: plan },
          commitments(s.driverId),
          s.driverId,
        ),
        409,
        'The driver has another reservation during redelivery.',
      );
      s.deliveryAttempt = (s.deliveryAttempt || s.failedAttempts?.length || 1) + 1;
      Object.assign(s, { redeliveryPlan: plan, status: 'In transit' });
      delete s.arrivedAt;
      return `Redelivery arranged: ${reason}`;
    }
    case 'return':
      allowed(admin && ['In transit', 'Delivery failed'].includes(s.status));
      startCargoReturn(s, text(data, 'reason'));
      return `Return to pickup arranged: ${s.returnReason}`;
    case 'confirmReturn':
      allowed(assigned && s.status === 'Returning');
      requireThat(
        !s.issue || s.issue.resolved,
        409,
        'Resolve the open issue before completing the return.',
      );
      requireThat(
        s.arrivedAt,
        409,
        'Record arrival at the return location before confirming the return.',
      );
      s.returnPod = text(data, 'pod');
      s.returnRecipient = text(data, 'recipient');
      s.status = 'Returned';
      s.offeredTo = null;
      delete s.handover;
      delete s.offerExpiresAt;
      return 'Cargo return confirmed';
    default:
      return false;
  }
}
