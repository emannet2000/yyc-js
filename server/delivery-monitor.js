import { createHash } from 'node:crypto';

export function createDeliveryMonitor({ db, now, notify, transaction }) {
  db.exec(`CREATE TABLE IF NOT EXISTS delivery_alert_ack (
    id TEXT PRIMARY KEY, shipment_id TEXT NOT NULL REFERENCES shipments(id),
    actor_id TEXT NOT NULL REFERENCES users(id), acknowledged_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS delivery_signal_receipts (
      id TEXT PRIMARY KEY,shipment_id TEXT NOT NULL REFERENCES shipments(id),created_at TEXT NOT NULL);`);
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  function evaluate() {
    const rows = db
      .prepare(
        `SELECT s.*,t.data AS tracking_data FROM shipments s
      LEFT JOIN tracking t ON t.shipment_id=s.id
      WHERE s.status IN ('Assigned','In transit','Delivery failed','Returning')`,
      )
      .all();
    const alerts = [],
      updates = [];
    for (const row of rows) {
      const s = JSON.parse(row.data),
        t = row.tracking_data ? JSON.parse(row.tracking_data) : {};
      const identity = `${row.id}:${row.driver_id}`;
      const gps =
        t.driverId === row.driver_id && Number.isFinite(Date.parse(t.recordedAt));
      const fresh = gps && now() - Date.parse(t.recordedAt) < 300000;
      const add = (kind, message, evidence) => {
        const id = digest(`${identity}:${kind}:${evidence}`);
        const ack = db
          .prepare(
            'SELECT acknowledged_at AS acknowledgedAt FROM delivery_alert_ack WHERE id=?',
          )
          .get(id);
        alerts.push({
          id,
          shipmentId: row.id,
          kind,
          message,
          acknowledgedAt: ack?.acknowledgedAt || null,
        });
      };
      if (!gps && now() - Date.parse(row.updated_at) >= 300000)
        add(
          'missing_gps',
          'Driver has not shared GPS for this assignment',
          row.driver_id,
        );
      if (gps && !fresh)
        add('stale_gps', 'Driver GPS is at least five minutes old', t.recordedAt);
      const deadlineValue = s.deliveryDeadline || t.destinationEta || t.eta;
      const deadline = Date.parse(deadlineValue);
      if (Number.isFinite(deadline) && now() > deadline) {
        add(
          'overdue_arrival',
          s.deliveryDeadline
            ? 'Delivery deadline has passed'
            : 'Last arrival estimate has passed; review the delivery',
          deadlineValue,
        );
        if (
          s.deliveryDeadline ||
          t.destinationEta ||
          (row.status === 'In transit' &&
            !(s.stops || []).some((stop) => !stop.completedAt))
        )
          updates.push({
            key: `${identity}:overdue`,
            row,
            message:
              'Delivery is delayed beyond its last planned arrival time. Please check the delivery for updates.',
          });
      }
      if (s.issue && !s.issue.resolved)
        add('open_issue', 'Delivery has an unresolved issue', JSON.stringify(s.issue));
      const eta = Date.parse(t.eta);
      const currentEta =
        Number.isFinite(Date.parse(t.etaUpdatedAt)) &&
        now() - Date.parse(t.etaUpdatedAt) < 300000 &&
        (t.etaSource !== 'road-route' || t.route?.shipmentVersion === row.version);
      if (
        row.status === 'In transit' &&
        fresh &&
        currentEta &&
        eta >= now() &&
        eta - now() <= 15 * 60000 &&
        !(s.stops || []).some((stop) => !stop.completedAt) &&
        !(s.issue && !s.issue.resolved)
      ) {
        updates.push({
          key: `${identity}:approaching`,
          row,
          message: `Driver is approaching. Estimated arrival: ${new Date(eta).toISOString()}. This is an estimate, not a guaranteed arrival time.`,
        });
      }
    }
    return { alerts, updates };
  }
  function notifyUpdates() {
    const { updates } = evaluate();
    transaction(db, () => {
      for (const update of updates) {
        const inserted = db
          .prepare(
            'INSERT OR IGNORE INTO delivery_signal_receipts(id,shipment_id,created_at) VALUES (?,?,?)',
          )
          .run(digest(update.key), update.row.id, new Date(now()).toISOString());
        if (inserted.changes)
          notify(
            update.row.store_id,
            update.row.id,
            `${update.row.id}: ${update.message}`,
          );
      }
    });
  }
  function acknowledge(id, actorId) {
    const alert = evaluate().alerts.find((item) => item.id === id);
    if (!alert) return null;
    db.prepare(
      'INSERT OR IGNORE INTO delivery_alert_ack(id,shipment_id,actor_id,acknowledged_at) VALUES (?,?,?,?)',
    ).run(id, alert.shipmentId, actorId, new Date(now()).toISOString());
    return evaluate().alerts.find((item) => item.id === id);
  }
  return { alerts: () => evaluate().alerts, notifyUpdates, acknowledge };
}
