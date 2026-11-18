import { deliveryAttempt } from '../shared/planning.js';

// Keep the same proof scope for completion, reserved capacity and workspace counts.
function proofScope(pickupVersion, attempt, arrivalVersion) {
  return `e.pickup_version=${pickupVersion} AND e.delivery_attempt=${attempt}
    AND e.final_arrival_version=${arrivalVersion}`;
}

export function currentDeliveryProof(db, shipment) {
  return db
    .prepare(
      `SELECT e.id,e.sha256 FROM evidence e WHERE e.shipment_id=? AND ${proofScope('?', '?', '?')}
       ORDER BY e.created_at DESC,e.id DESC LIMIT 1`,
    )
    .get(
      shipment.id,
      shipment.pickupVersion || 0,
      deliveryAttempt(shipment),
      shipment.finalArrivalVersion ?? null,
    );
}

export function deliveryProofCounts(db, user) {
  const scope = proofScope(
    "COALESCE(json_extract(s.data,'$.pickupVersion'),0)",
    "COALESCE(json_extract(s.data,'$.deliveryAttempt'),json_array_length(COALESCE(json_extract(s.data,'$.failedAttempts'),'[]'))+1)",
    "json_extract(s.data,'$.finalArrivalVersion')",
  );
  return new Map(
    db
      .prepare(
        `SELECT e.shipment_id,COUNT(*) AS n FROM evidence e JOIN shipments s ON s.id=e.shipment_id
       WHERE (s.store_id=? OR s.driver_id=? OR s.offered_to=? OR ?='admin') AND ${scope}
       GROUP BY e.shipment_id`,
      )
      .all(user.id, user.id, user.id, user.role)
      .map((row) => [row.shipment_id, row.n]),
  );
}
