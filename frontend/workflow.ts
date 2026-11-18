import type { Shipment, User } from './types';
import {
  canTakeCargo,
  driverAvailable,
  driverVehicleBlockers,
} from '../shared/scheduling.js';
import {
  cargoStates,
  nextIntermediateStop,
  pickupDatePassed,
  prePickup,
  redeliveryBlocker,
} from '../shared/planning.js';
export interface NextStep {
  title: string;
  detail: string;
  actionable: boolean;
  priority: number;
  action?: 'invoice';
}
export function nextStep(s: Shipment, user: User, jobs: Shipment[] = []): NextStep {
  const step = (title: string, detail: string, actionable = false, priority = 90) => ({
    title,
    detail,
    actionable,
    priority,
  });
  if (
    user.role === 'admin' &&
    s.invoiceIssued === false &&
    ['Delivered', 'Returned'].includes(s.status)
  )
    return {
      ...step(
        'Issue invoice',
        'Review the completed job in Billing and issue the customer invoice.',
        true,
        40,
      ),
      action: 'invoice',
    };
  if (['Delivered', 'Returned', 'Cancelled'].includes(s.status))
    return step(
      s.status === 'Cancelled' ? 'Request closed' : 'Delivery closed',
      'Review the recorded evidence and activity history.',
    );
  if (user.role === 'admin' && s.customerRequests?.some((r) => r.status === 'pending'))
    return step(
      'Review the owner request',
      'Approve and apply the proposed change, or decline with clear instructions in Owner requests.',
      true,
      5,
    );
  if (prePickup.includes(s.status) && pickupDatePassed(s))
    return step(
      user.role === 'admin' ? 'Reschedule pickup' : 'Waiting for a new pickup date',
      user.role === 'admin'
        ? 'The pickup date has passed. Set a new date in Reschedule delivery.'
        : 'The pickup date has passed. The broker needs to reschedule the delivery.',
      user.role === 'admin',
      8,
    );
  if (user.role === 'driver' && s.rateChange?.driverId === user.id)
    return step(
      'Review the proposed driver rate',
      user.approved && user.truck?.approved && !user.disabled
        ? 'Accept the new rate or keep your existing agreed rate. Your assignment remains in place.'
        : 'Ask the broker to review your driver and truck approvals before accepting a new rate. You can still keep your existing agreed rate.',
      !!(user.approved && user.truck?.approved && !user.disabled),
      12,
    );
  if (user.role === 'driver' && s.offeredTo === user.id) {
    const blockers = driverBlockers(s, user, jobs);
    return step(
      s.handover ? 'Review driver handover' : 'Review job offer',
      blockers.length
        ? `Acceptance is blocked. ${blockers.join(' · ')}. You can still decline the offer.`
        : 'Review the route, cargo and driver rate, then accept or decline.',
      true,
      15,
    );
  }
  if (
    user.role === 'driver' &&
    s.status === 'Assigned' &&
    s.driverId === user.id &&
    (!user.approved || !user.truck?.approved || user.disabled)
  )
    return step(
      'Approval required before continuing',
      'Ask the broker to review your driver and truck approvals.',
    );
  const involved = user.role !== 'driver' || s.driverId === user.id;
  if (s.issue && !s.issue.resolved && involved)
    return step(
      user.role === 'admin'
        ? 'Resolve the open exception'
        : 'Waiting for exception resolution',
      user.role === 'admin'
        ? 'Record a resolution so the driver can continue the delivery.'
        : 'The broker must resolve the open issue before cargo progress can continue.',
      user.role === 'admin',
      0,
    );
  if (s.status === 'Delivery failed' && user.role === 'admin' && s.handover)
    return step('Review pending rescue handover', redeliveryBlocker(s)!, true, 5);
  if (s.status === 'Delivery failed' && involved)
    return step(
      user.role === 'admin'
        ? 'Choose redelivery or return'
        : 'Waiting for broker instructions',
      user.role === 'admin'
        ? 'Review the failed attempt and arrange the next delivery attempt or cargo return.'
        : 'Keep the cargo safe. The broker will arrange redelivery or return.',
      user.role === 'admin',
      5,
    );
  if (user.role === 'admin') {
    if (s.status === 'Awaiting quote')
      return step(
        'Prepare a quotation',
        'Review cargo, route and schedule, then enter the customer price and driver rate.',
        true,
        25,
      );
    if (s.status === 'Ready to assign')
      return step(
        'Select an available driver',
        'The customer accepted the quote. Offer the job to a suitable, available driver.',
        true,
        20,
      );
    if (s.status === 'Quote ready')
      return step(
        'Waiting for customer acceptance',
        'The store must accept this quote before a driver can be offered the job.',
      );
    if (s.offeredTo)
      return step(
        s.handover ? 'Waiting for handover acceptance' : 'Waiting for driver acceptance',
        'The proposed driver must explicitly accept responsibility.',
      );
    return step(
      'Monitor delivery progress',
      'Follow driver milestones, shared location and ETA. Arrange a handover if needed.',
    );
  }
  if (user.role === 'store') {
    if (s.status === 'Quote ready')
      return step(
        'Review and accept your quotation',
        'Check the price and shipment details, then accept to release the delivery for dispatch.',
        true,
        20,
      );
    if (s.status === 'Awaiting quote')
      return step(
        'Waiting for a quotation',
        'The broker is reviewing your request. You can review route details while waiting.',
      );
    if (['Ready to assign', 'Offered'].includes(s.status))
      return step(
        'Your delivery is being dispatched',
        'The broker is arranging an approved driver.',
      );
    return step(
      'Follow your delivery',
      'Check milestones and ETA, or create a private tracking link for your recipient.',
    );
  }
  if (s.driverId !== user.id)
    return step('No action required', 'This delivery is not currently assigned to you.');
  if (s.status === 'Assigned') {
    if (!canTakeCargo(s.id, jobs, user.id))
      return step(
        'Finish your current cargo first',
        'You can review this assignment now. Finish or hand over the live load before confirming another pickup.',
      );
    return step(
      'Collect the load',
      'Record arrival at pickup, then confirm that the cargo has been collected.',
      true,
      30,
    );
  }
  if (s.status === 'Returning')
    return step(
      'Return cargo to pickup',
      'Record arrival at the return location, then enter the return receipt reference and receiving contact.',
      true,
      10,
    );
  const stop = nextIntermediateStop(s);
  return step(
    stop ? 'Complete your next stop' : 'Complete final delivery',
    stop
      ? `${stop.kind === 'pickup' ? 'Collect' : 'Deliver'} at ${stop.address}. Record the receipt and contact in Route and stops.`
      : 'After recording final arrival, upload a delivery photo, signature image, or receipt document for this attempt in Evidence files, then enter the receipt reference and recipient’s name before confirming delivery.',
    true,
    10,
  );
}
export function driverBlockers(s: Shipment, driver: User, jobs: Shipment[]): string[] {
  const reasons: string[] = driverVehicleBlockers(s, driver);
  if (!driver.truck) return reasons;
  if (!driverAvailable(s, jobs, driver.id))
    reasons.push('Schedule overlaps another commitment');
  if (cargoStates.includes(s.status) && !canTakeCargo(s.id, jobs, driver.id))
    reasons.push('Finish the current live load or pending cargo handover first');
  return reasons;
}
export function attentionQueue(shipments: Shipment[], user: User) {
  return shipments
    .map((s) => ({ shipment: s, next: nextStep(s, user, shipments) }))
    .filter((item) => item.next.actionable)
    .sort(
      (a, b) =>
        a.next.priority - b.next.priority ||
        a.shipment.date.localeCompare(b.shipment.date) ||
        a.shipment.id.localeCompare(b.shipment.id),
    );
}
