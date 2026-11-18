export const prePickup = [
  'Awaiting quote',
  'Quote ready',
  'Ready to assign',
  'Offered',
  'Assigned',
];
export const cargoStates = ['In transit', 'Delivery failed', 'Returning'];
const edmontonDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Edmonton',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
export function edmontonDate(time = Date.now()) {
  return edmontonDateFormat.format(time);
}
export function pickupDatePassed(job, time = Date.now()) {
  return job.date < edmontonDate(time);
}
export function nextIntermediateStop(job) {
  return job.stops?.find((stop) => !stop.completedAt);
}
export function redeliveryBlocker(shipment, driverCanAct = true) {
  if (shipment.issue && !shipment.issue.resolved)
    return 'Resolve the open issue before redelivery.';
  if (shipment.handover)
    return 'Complete or withdraw the pending handover before scheduling redelivery.';
  if (!driverCanAct) return 'Assign an active cargo driver before scheduling redelivery.';
  return null;
}
export function calendarMinutes(date, clock = '00:00') {
  return Date.parse(`${date}T${clock}:00Z`) / 60000;
}
export function reservation(job) {
  job = job.redeliveryPlan ?? job;
  const start =
    job.window === '13:00–16:00'
      ? '13:00'
      : job.window === '09:00–12:00'
        ? '09:00'
        : '00:00';
  const base = calendarMinutes(job.date, start);
  const end = base + (start === '00:00' ? 1440 : 180);
  return [
    base,
    Math.max(end, base + (job.estimatedMinutes || 0)) + (job.travelBufferMinutes || 0),
  ];
}
export function validDeadline(
  date,
  window,
  deadline,
  estimatedMinutes = 0,
  travelBufferMinutes = 0,
) {
  if (!deadline) return true;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(deadline)) return false;
  const parsed = new Date(`${deadline}:00Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 16) === deadline &&
    parsed.getTime() / 60000 >=
      reservation({ date, window, estimatedMinutes, travelBufferMinutes })[1]
  );
}

/** @param {{deliveryAttempt?: number,failedAttempts?: unknown[]}} shipment */
export function deliveryAttempt(shipment) {
  return shipment.deliveryAttempt || (shipment.failedAttempts?.length || 0) + 1;
}

export function canRecordArrival(shipment) {
  return (
    shipment.status === 'Assigned' ||
    shipment.status === 'Returning' ||
    (shipment.status === 'In transit' && !nextIntermediateStop(shipment))
  );
}

export function canAttachDeliveryProof(shipment) {
  return (
    shipment.status === 'In transit' &&
    !!shipment.arrivedAt &&
    !nextIntermediateStop(shipment)
  );
}

export function recordArrival(shipment, time, version) {
  shipment.arrivedAt = time;
  if (shipment.status === 'In transit') shipment.finalArrivalVersion = version;
}

export function recordPickup(shipment, time, version) {
  shipment.pickupArrivedAt = shipment.arrivedAt;
  delete shipment.arrivedAt;
  shipment.status = 'In transit';
  shipment.pickupAt = time;
  shipment.pickupVersion = version;
  shipment.deliveryAttempt = 1;
  shipment.pickupDriverId = shipment.driverId;
}
