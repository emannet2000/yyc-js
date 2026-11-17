import { randomBytes, createHash } from 'node:crypto';
import { prePickup } from '../shared/planning.js';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const terminal = ['Delivered', 'Returned', 'Cancelled'];
export function itinerary(s) {
  return [
    { id: 'pickup', kind: 'pickup', address: s.pickup },
    ...(s.stops || []),
    { id: 'destination', kind: 'dropoff', address: s.destination },
  ];
}
export function createMobility({
  db,
  now,
  requireThat,
  text,
  transaction,
  shipments,
  audit,
  send,
  calculateRoute,
  publicOrigin,
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS recipient_links(token_hash TEXT PRIMARY KEY,shipment_id TEXT NOT NULL REFERENCES shipments(id),expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS action_requests(user_id TEXT NOT NULL REFERENCES users(id),request_key TEXT NOT NULL,shipment_id TEXT NOT NULL REFERENCES shipments(id),request_hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(user_id,request_key));`);
  const busyRoutes = new Set();
  function stopAction(s, user, data) {
    if (!['setStops', 'completeStop'].includes(data.action)) return false;
    if (data.action === 'setStops') {
      requireThat(
        (user.role === 'admin' ||
          (user.role === 'store' &&
            s.storeId === user.id &&
            s.status === 'Awaiting quote')) &&
          prePickup.includes(s.status),
        403,
        'Stops can only be revised before pickup by the broker, or before quotation by the store.',
      );
      requireThat(
        Array.isArray(data.stops) && data.stops.length <= 18,
        400,
        'Provide at most 18 intermediate stops.',
      );
      const stops = data.stops.map((stop, i) => {
        requireThat(
          stop && ['pickup', 'dropoff'].includes(stop.kind),
          400,
          'Each stop needs a pickup or dropoff kind.',
        );
        return {
          id: `stop-${i + 1}`,
          kind: stop.kind,
          address: text(stop, 'address'),
          contact: text(stop, 'contact', true),
        };
      });
      const reason = text(data, 'reason');
      if (s.price != null)
        s.quoteArchive = [
          ...(s.quoteArchive || []),
          {
            version: s.quoteVersion,
            price: s.price,
            rate: s.rate,
            destination: s.destination,
            kg: s.kg,
            pallets: s.pallets,
            reason,
          },
        ];
      Object.assign(s, {
        stops,
        quoteVersion: s.quoteVersion + 1,
        price: null,
        rate: null,
        driverId: null,
        offeredTo: null,
        status: 'Awaiting quote',
      });
      for (const key of [
        'arrivedAt',
        'pickupArrivedAt',
        'handover',
        'offerExpiresAt',
        'quoteExpiresAt',
      ])
        delete s[key];
      db.prepare('DELETE FROM tracking WHERE shipment_id=?').run(s.id);
      return `Stops revised; quotation and assignment reset: ${reason}`;
    }
    requireThat(
      user.role === 'driver' && s.driverId === user.id && s.status === 'In transit',
      403,
      'Only the assigned driver can complete stops in transit.',
    );
    requireThat(
      !s.issue || s.issue.resolved,
      409,
      'Resolve the open issue before completing a stop.',
    );
    const next = (s.stops || []).find((stop) => !stop.completedAt);
    requireThat(
      next && data.stopId === next.id,
      409,
      'Complete intermediate stops in route order.',
    );
    next.pod = text(data, 'pod');
    next.recipient = text(data, 'recipient');
    next.completedAt = new Date(now()).toISOString();
    delete s.arrivedAt;
    return `${next.kind === 'pickup' ? 'Pickup' : 'Dropoff'} stop completed: ${next.address}`;
  }
  function tracking(id) {
    const row = db.prepare('SELECT data FROM tracking WHERE shipment_id=?').get(id);
    return row ? JSON.parse(row.data) : {};
  }
  function recipientView(token, res) {
    requireThat(
      typeof token === 'string' && /^[a-f0-9]{64}$/.test(token),
      404,
      'Tracking link is unavailable.',
    );
    const link = db
      .prepare('SELECT * FROM recipient_links WHERE token_hash=?')
      .get(digest(token));
    requireThat(
      link && link.expires_at > now(),
      404,
      'Tracking link has expired or was revoked.',
    );
    const s = shipments({ role: 'admin' }, link.shipment_id, false)[0];
    const t = tracking(s.id);
    const staleAutomaticEta =
      t.etaSource === 'road-route' &&
      (!t.recordedAt ||
        !t.etaUpdatedAt ||
        now() - Date.parse(t.etaUpdatedAt) >= 5 * 60000 ||
        now() - Date.parse(t.recordedAt) >= 5 * 60000 ||
        t.driverId !== s.driverId);
    // Explicit allowlist: no accounts, rates, cargo, driver location or other recipients' addresses.
    send(res, 200, {
      id: s.id,
      status: s.status,
      date: s.date,
      window: s.window,
      eta: terminal.includes(s.status) || staleAutomaticEta ? null : t.eta || null,
      etaUpdatedAt: t.etaUpdatedAt || null,
      stopsCompleted: (s.stops || []).filter((stop) => stop.completedAt).length,
      stopsTotal: (s.stops || []).length,
      expiresAt: link.expires_at,
    });
  }
  async function route(path, req, res, user, data = {}) {
    const match = /^\/api\/shipments\/([^/]+)\/(route|recipient-link)$/.exec(path);
    if (!match) return false;
    const s = shipments(user, match[1], false)[0];
    requireThat(s, 404, 'Delivery not found.');
    if (match[2] === 'recipient-link') {
      requireThat(
        user.role === 'admin' || (user.role === 'store' && s.storeId === user.id),
        403,
        'Only the broker or booking store can manage recipient links.',
      );
      requireThat(['POST', 'DELETE'].includes(req.method), 405, 'Use POST or DELETE.');
      const result = transaction(db, () => {
        db.prepare('DELETE FROM recipient_links WHERE shipment_id=?').run(s.id);
        if (req.method === 'DELETE') {
          audit(s, user, 'Recipient tracking link revoked');
          return { ok: true };
        }
        const token = randomBytes(32).toString('hex'),
          expiresAt = now() + 7 * 86400000;
        db.prepare('INSERT INTO recipient_links VALUES (?,?,?)').run(
          digest(token),
          s.id,
          expiresAt,
        );
        audit(s, user, 'Recipient tracking link issued');
        return { url: `${publicOrigin}/react/#track=${token}`, expiresAt };
      });
      send(res, 200, result);
      return true;
    }
    if (req.method === 'GET') {
      send(res, 200, tracking(s.id).route || null);
      return true;
    }
    requireThat(req.method === 'POST', 405, 'Use GET or POST.');
    requireThat(
      user.role === 'admin' || (user.role === 'driver' && s.driverId === user.id),
      403,
      'Only broker or assigned driver can calculate routing.',
    );
    requireThat(!terminal.includes(s.status), 409, 'Delivery is already complete.');
    send(res, 200, await routeFor(s, user, data));
    return true;
  }
  async function routeFor(s, user, options = {}) {
    requireThat(
      calculateRoute,
      503,
      'Road routing is not configured. Ask the operator to set ORS_API_KEY, or ROUTING_URL and GEOCODING_URL.',
    );
    requireThat(!busyRoutes.has(s.id), 429, 'A route calculation is already running.');
    busyRoutes.add(s.id);
    let result;
    try {
      const previous = tracking(s.id);
      const timing = {
        stopServiceMinutes:
          options.stopServiceMinutes ?? previous.etaTiming?.stopServiceMinutes ?? 0,
        unloadingMinutes:
          options.unloadingMinutes ?? previous.etaTiming?.unloadingMinutes ?? 0,
      };
      requireThat(
        Object.values(timing).every(
          (value) => Number.isInteger(value) && value >= 0 && value <= 240,
        ),
        400,
        'Stop and unloading times must be whole minutes from 0 to 240.',
      );
      const recent =
        s.driverId &&
        ['Assigned', 'In transit', 'Delivery failed', 'Returning'].includes(s.status) &&
        previous.recordedAt &&
        now() - Date.parse(previous.recordedAt) < 5 * 60000 &&
        previous.driverId === s.driverId;
      const remaining = (
        s.status === 'Returning'
          ? [{ id: 'return', kind: 'dropoff', address: s.pickup }]
          : itinerary(s)
      )
        .filter(
          (point) =>
            point.id !== 'pickup' ||
            s.status === 'Assigned' ||
            prePickup.includes(s.status),
        )
        .filter((point) => !point.completedAt);
      const points = recent
        ? [{ latitude: previous.latitude, longitude: previous.longitude }, ...remaining]
        : s.status === 'Assigned' || prePickup.includes(s.status)
          ? remaining
          : [
              {
                address:
                  [...(s.stops || [])].reverse().find((p) => p.completedAt)?.address ||
                  s.pickup,
              },
              ...remaining,
            ];
      let calculated;
      try {
        calculated = await calculateRoute(points);
      } catch {
        requireThat(false, 502, 'Road routing failed. Check the addresses or try again.');
      }
      requireThat(
        calculated &&
          Number.isFinite(calculated.durationSeconds) &&
          calculated.durationSeconds >= 0 &&
          Number.isFinite(calculated.distanceMeters) &&
          calculated.distanceMeters >= 0 &&
          Array.isArray(calculated.legs) &&
          calculated.legs.length === points.length - 1 &&
          calculated.legs.every(
            (leg) =>
              Number.isFinite(leg.durationSeconds) &&
              leg.durationSeconds >= 0 &&
              Number.isFinite(leg.distanceMeters) &&
              leg.distanceMeters >= 0,
          ),
        502,
        'Routing provider returned an invalid route.',
      );
      transaction(db, () => {
        const current = shipments(user, s.id, false)[0];
        requireThat(
          current && current.version === s.version,
          409,
          'Delivery changed during routing. Calculate again.',
        );
        const t = tracking(s.id);
        const route = {
          ...calculated,
          calculatedAt: new Date(now()).toISOString(),
          shipmentVersion: s.version,
          stops: remaining.map((p) => ({ id: p.id, kind: p.kind, address: p.address })),
          source: recent ? 'driver-location' : 'planned-addresses',
        };
        // ETA describes the next stop, including the configured travel buffer.
        const seconds = calculated.legs[0]?.durationSeconds || 0;
        const bufferSeconds = (s.travelBufferMinutes || 0) * 60;
        const stopServiceSeconds =
          remaining.filter((point) => point.id !== 'destination' && point.id !== 'return')
            .length *
          timing.stopServiceMinutes *
          60;
        const unloadingSeconds = timing.unloadingMinutes * 60;
        const eta = recent
          ? new Date(
              now() + (seconds + (s.travelBufferMinutes || 0) * 60) * 1000,
            ).toISOString()
          : null;
        const destinationEta = recent
          ? new Date(
              now() +
                (calculated.durationSeconds + bufferSeconds + stopServiceSeconds) * 1000,
            ).toISOString()
          : null;
        const completionEta = destinationEta
          ? new Date(Date.parse(destinationEta) + unloadingSeconds * 1000).toISOString()
          : null;
        const etaBreakdown = {
          drivingSeconds: calculated.durationSeconds,
          bufferSeconds,
          stopServiceSeconds,
          unloadingSeconds,
        };
        db.prepare(
          'INSERT INTO tracking VALUES (?,?) ON CONFLICT(shipment_id) DO UPDATE SET data=excluded.data',
        ).run(
          s.id,
          JSON.stringify({
            ...t,
            route,
            eta,
            destinationEta,
            completionEta,
            etaTiming: timing,
            etaBreakdown,
            etaUpdatedAt: new Date(now()).toISOString(),
            etaSource: 'road-route',
          }),
        );
        result = {
          ...route,
          eta,
          destinationEta,
          completionEta,
          etaTiming: timing,
          etaBreakdown,
        };
      });
    } finally {
      busyRoutes.delete(s.id);
    }
    return result;
  }
  const attempts = new Map();
  async function autoRoute(id, user) {
    if (!calculateRoute) return;
    const previous = attempts.get(id);
    if (previous !== undefined && now() - previous < 60000) return;
    if (attempts.size >= 10000) attempts.delete(attempts.keys().next().value);
    attempts.set(id, now());
    const s = shipments(user, id, false)[0];
    if (
      !s ||
      !['Assigned', 'In transit', 'Delivery failed', 'Returning'].includes(s.status)
    )
      return;
    try {
      await routeFor(s, user);
    } catch {
      /* Provider failures never invalidate an accepted location sample. */
    }
  }
  return { route, recipientView, stopAction, autoRoute };
}
