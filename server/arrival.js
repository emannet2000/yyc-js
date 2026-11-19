// Rules for suggesting arrival at the next pickup or destination from GPS.
// The suggestion is only a prompt for the driver; arrival is still recorded by
// the driver's own confirmation.
export const ARRIVAL_RADIUS_M = 150;
export const ARRIVAL_MAX_ACCURACY_M = 50;
export const ARRIVAL_MAX_AGE_MS = 2 * 60 * 1000;

const EARTH_RADIUS_M = 6371000;

export function distanceMetres(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Which place the driver is heading to next, or null when none applies.
// Targets are 'pickup', 'stop:<id>' for the next uncompleted intermediate stop,
// and 'destination' once every stop is complete.
export function arrivalTarget(s) {
  if (s.status === 'Assigned') return s.arrivedAt ? null : 'pickup';
  if (s.status !== 'In transit') return null;
  const next = (s.stops || []).find((stop) => !stop.completedAt);
  if (next) return `stop:${next.id}`;
  return s.arrivedAt ? null : 'destination';
}

// Every target that can need coordinates for this delivery.
export function arrivalTargetAddresses(s) {
  const list = [
    ['pickup', s.pickup],
    ['destination', s.destination],
  ];
  for (const stop of s.stops || [])
    if (!stop.completedAt) list.push([`stop:${stop.id}`, stop.address]);
  return list.filter(([, address]) => address);
}

export function targetAddress(s, target) {
  const entry = arrivalTargetAddresses(s).find(([key]) => key === target);
  return entry ? entry[1] : null;
}

export function targetLabel(s, target) {
  if (target === 'pickup') return 'pickup location';
  if (target === 'destination') return 'delivery address';
  const index = (s.stops || []).findIndex((stop) => `stop:${stop.id}` === target);
  return index >= 0 ? `stop ${index + 1}` : 'stop';
}

// Returns a prompt when the driver's latest sample is recent, accurate enough,
// and inside the radius of the target. Otherwise null.
export function arrivalSuggestion({ target, point, sample, driverId, now, label }) {
  if (!target || !point || !sample || sample.driverId !== driverId) return null;
  if (!Number.isFinite(sample.latitude) || !Number.isFinite(sample.longitude))
    return null;
  const recorded = Date.parse(sample.recordedAt);
  if (!Number.isFinite(recorded) || now - recorded > ARRIVAL_MAX_AGE_MS) return null;
  if (!(sample.accuracy <= ARRIVAL_MAX_ACCURACY_M)) return null;
  const distance = distanceMetres(sample, point);
  if (distance > ARRIVAL_RADIUS_M) return null;
  return {
    target,
    kind: target.startsWith('stop:') ? 'stop' : 'arrival',
    label: label ?? (target === 'pickup' ? 'pickup location' : 'delivery address'),
    distanceM: Math.round(distance),
  };
}
