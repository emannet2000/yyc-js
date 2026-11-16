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
