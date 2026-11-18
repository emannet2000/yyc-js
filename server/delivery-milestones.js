import {
  cargoStates,
  canRecordArrival,
  deliveryAttempt,
  nextIntermediateStop,
  recordArrival,
  recordPickup,
} from '../shared/planning.js';
import { canTakeCargo, driverVehicleBlockers } from '../shared/scheduling.js';
import { releaseDriverOffer } from './dispatch.js';

export function applyDeliveryMilestone(
  s,
  user,
  data,
  {
    allowed,
    requireThat,
    text,
    now,
    requireCurrentPickupDate,
    cargoCommitments,
    findProof,
  },
) {
  const assigned = user.role === 'driver' && s.driverId === user.id;
  const active = s.status === 'Assigned' || cargoStates.includes(s.status);
  function driverMilestoneTime() {
    const receivedAt = now();
    if (data.queuedAt === undefined) return receivedAt;
    const timestamp = typeof data.queuedAt === 'string' ? Date.parse(data.queuedAt) : NaN;
    requireThat(
      data.requestKey &&
        Number.isFinite(timestamp) &&
        new Date(timestamp).toISOString() === data.queuedAt &&
        timestamp <= receivedAt + 60000 &&
        (!s.driverAcceptedAt || timestamp + 60000 >= Date.parse(s.driverAcceptedAt)),
      400,
      'The saved action time is invalid for this driver assignment.',
    );
    return timestamp;
  }
  switch (data.action) {
    case 'arrival': {
      allowed(assigned && active);
      const arrivedAt = driverMilestoneTime();
      if (s.status === 'Assigned') requireCurrentPickupDate(arrivedAt);
      requireThat(
        canRecordArrival(s),
        409,
        'Complete the remaining stops or wait for the broker’s next instructions before recording arrival.',
      );
      requireThat(!s.arrivedAt, 409, 'Arrival is already recorded for this leg.');
      recordArrival(s, new Date(arrivedAt).toISOString(), s.version + 1);
      return `Arrival recorded at ${
        s.status === 'Assigned'
          ? 'pickup'
          : s.status === 'Returning'
            ? 'return pickup'
            : 'delivery'
      }`;
    }
    case 'pickup': {
      allowed(
        assigned && s.status === 'Assigned' && !driverVehicleBlockers(s, user).length,
      );
      const pickedUpAt = driverMilestoneTime();
      requireCurrentPickupDate(pickedUpAt);
      requireThat(
        !s.issue || s.issue.resolved,
        409,
        'Resolve the open issue before collecting the load.',
      );
      requireThat(
        canTakeCargo(s.id, cargoCommitments(user.id), user.id),
        409,
        'Finish the current live load or pending cargo handover before collecting another load.',
      );
      requireThat(
        s.arrivedAt,
        409,
        'Record arrival at pickup before confirming collection.',
      );
      requireThat(
        pickedUpAt >= Date.parse(s.arrivedAt),
        409,
        'Pickup cannot precede the recorded arrival.',
      );
      recordPickup(s, new Date(pickedUpAt).toISOString(), s.version + 1);
      return 'Pickup confirmed';
    }
    case 'deliver': {
      allowed(assigned && s.status === 'In transit');
      requireThat(
        !nextIntermediateStop(s),
        409,
        'Complete every intermediate stop before final delivery.',
      );
      requireThat(
        !s.issue || s.issue.resolved,
        409,
        'Resolve the open issue before completing delivery.',
      );
      requireThat(
        s.arrivedAt,
        409,
        'Record arrival at the final destination before confirming delivery.',
      );
      const evidence = findProof(s);
      requireThat(
        evidence,
        409,
        'Attach a delivery photo, signature image, or receipt document for this delivery attempt before confirming delivery.',
      );
      s.deliveryEvidence = {
        fileId: evidence.id,
        sha256: evidence.sha256,
        arrivedAt: s.arrivedAt,
        confirmedAt: new Date(now()).toISOString(),
        driverId: user.id,
        policy: 'arrival-and-file',
        attempt: deliveryAttempt(s),
      };
      s.pod = text(data, 'pod');
      s.recipient = text(data, 'recipient');
      s.status = 'Delivered';
      releaseDriverOffer(s);
      return 'Delivery confirmed';
    }
    default:
      return false;
  }
}
