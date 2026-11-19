import { reservation, cargoStates } from './planning.js';
/** @param {string} first @param {string} second */
export function windowsOverlap(first, second) {
  const hours = { '09:00–12:00': [9, 12], '13:00–16:00': [13, 16] };
  const a = Object.hasOwn(hours, first) ? hours[first] : undefined,
    b = Object.hasOwn(hours, second) ? hours[second] : undefined;
  return !a || !b || (a[0] < b[1] && b[0] < a[1]);
}
/**
 * Offers reserve a pickup window until declined, cancelled or revised.
 * @param {{id: string, date: string, window: string}} candidate
 * @param {{id: string, date: string, window: string, status: string, driverId?: string | null, offeredTo?: string | null}[]} shipments
 * @param {string} driverId
 */
export function driverAvailable(candidate, shipments, driverId) {
  return !shipments.some(
    (other) =>
      other.id !== candidate.id &&
      ['Offered', 'Assigned', ...cargoStates].includes(other.status) &&
      (other.driverId === driverId || other.offeredTo === driverId) &&
      reservation(other)[0] < reservation(candidate)[1] &&
      reservation(candidate)[0] < reservation(other)[1],
  );
}

/**
 * A pickup window reserves future work; it does not make a live load disappear.
 * Pending in-transit handovers also reserve the replacement's cargo slot.
 * @param {string} shipmentId
 * @param {{id: string, status: string, driverId?: string | null, offeredTo?: string | null}[]} shipments
 * @param {string} driverId
 */
export function canTakeCargo(shipmentId, shipments, driverId) {
  return !shipments.some(
    (other) =>
      other.id !== shipmentId &&
      cargoStates.includes(other.status) &&
      (other.driverId === driverId || other.offeredTo === driverId),
  );
}

export function driverVehicleBlockers(shipment, driver) {
  if (driver?.role !== 'driver') return ['Driver account required'];
  const reasons = [];
  if (driver.disabled) reasons.push('Account disabled');
  if (!driver.approved || !driver.truck?.approved) reasons.push('Approval required');
  const truck = driver.truck;
  if (!truck) return [...reasons, 'No truck registered'];
  if (truck.type !== shipment.type) reasons.push(`Needs ${shipment.type}`);
  if (!(truck.kg >= shipment.kg)) reasons.push('Weight capacity too low');
  if (!(truck.pallets >= shipment.pallets)) reasons.push('Pallet capacity too low');
  if (shipment.unloading.includes('Liftgate') && !truck.liftgate)
    reasons.push('Liftgate required');
  if (shipment.date && (truck.unavailableDates || []).includes(shipment.date))
    reasons.push('Unavailable on pickup date');
  // A document that expires before the pickup date blocks the job. Missing dates
  // do not block (older registrations have none); the approval screen shows them.
  for (const [label, key] of [
    ['Licence', 'licenceExpires'],
    ['Insurance', 'insuranceExpires'],
    ['Inspection', 'inspectionExpires'],
  ]) {
    if (truck[key] && shipment.date && truck[key] < shipment.date)
      reasons.push(`${label} expired before pickup`);
  }
  return reasons;
}
