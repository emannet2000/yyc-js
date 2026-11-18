const gpsFreshnessMs = 5 * 60000;
const inactive = ['Delivery failed', 'Delivered', 'Returned', 'Cancelled'];

export function recentDriverLocation(shipment, tracking, now) {
  return (
    !!shipment.driverId &&
    tracking.driverId === shipment.driverId &&
    Number.isFinite(Date.parse(tracking.recordedAt)) &&
    now - Date.parse(tracking.recordedAt) < gpsFreshnessMs
  );
}

export function publishedEta(shipment, tracking, now) {
  const unavailable = { eta: null, etaUpdatedAt: null, etaSource: null };
  if (inactive.includes(shipment.status) || shipment.arrivedAt) return unavailable;
  const legacy = { eta: tracking.eta, updatedAt: tracking.etaUpdatedAt };
  const manual = tracking.manualEta ?? (tracking.etaSource === 'manual' ? legacy : null);
  const calculated =
    tracking.calculatedEta ?? (tracking.etaSource === 'road-route' ? legacy : null);
  if (Date.parse(manual?.eta) > now)
    return { eta: manual.eta, etaUpdatedAt: manual.updatedAt, etaSource: 'manual' };
  if (
    Date.parse(calculated?.eta) > now &&
    now - Date.parse(calculated.updatedAt) < gpsFreshnessMs &&
    now - Date.parse(calculated.recordedAt ?? tracking.recordedAt) < gpsFreshnessMs &&
    recentDriverLocation(shipment, tracking, now)
  )
    return {
      eta: calculated.eta,
      etaUpdatedAt: calculated.updatedAt,
      etaSource: 'road-route',
    };
  return unavailable;
}

export function clearTrackingEstimates(tracking) {
  for (const key of [
    'route',
    'eta',
    'etaUpdatedAt',
    'etaSource',
    'manualEta',
    'calculatedEta',
  ])
    delete tracking[key];
}
