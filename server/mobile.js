import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRegistrationLimiter } from './registration-limiter.js';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const active = ['Assigned', 'In transit', 'Delivery failed', 'Returning'];
export function createMobile({
  db,
  now,
  requireThat,
  text,
  transaction,
  shipments,
  account,
  audit,
  send,
  operations,
  mobility,
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS mobile_pairings(code_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),shipment_id TEXT NOT NULL REFERENCES shipments(id),expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mobile_devices(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL REFERENCES users(id),shipment_id TEXT NOT NULL REFERENCES shipments(id),name TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,last_seen_at INTEGER,revoked_at INTEGER);`);
  const limiter = createRegistrationLimiter();
  function assigned(user, id) {
    const s = shipments(user, id, false)[0];
    requireThat(
      s &&
        user.role === 'driver' &&
        s.driverId === user.id &&
        active.includes(s.status) &&
        user.approved &&
        user.truck?.approved &&
        !user.disabled,
      403,
      'Tracking stopped: delivery is no longer assigned and active, or driver approval was removed.',
    );
    return s;
  }
  function authenticate(req) {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
    requireThat(token, 401, 'Pair this phone again.');
    const device = db
      .prepare(
        'SELECT d.* FROM mobile_devices d JOIN users u ON u.id=d.user_id WHERE d.token_hash=? AND d.revoked_at IS NULL AND d.expires_at>? AND u.disabled=0',
      )
      .get(hash(token), now());
    requireThat(device, 401, 'Phone authorization expired or was revoked. Pair again.');
    const row = db
      .prepare(
        'SELECT u.*,t.id AS truck_id,t.plate AS truck_plate,t.profile AS truck_profile,t.approved AS truck_approved FROM users u LEFT JOIN trucks t ON t.driver_id=u.id WHERE u.id=?',
      )
      .get(device.user_id);
    const user = account(row),
      s = assigned(user, device.shipment_id);
    return { device, user, s };
  }
  async function publicRoute(path, req, res, data) {
    if (path === '/api/mobile/pair' && req.method === 'POST') {
      const release = limiter.reserve(req.socket.remoteAddress || 'local');
      requireThat(release, 429, 'Too many phone pairing attempts. Try again later.');
      try {
        const code = text(data, 'code').replaceAll('-', '').toLowerCase();
        requireThat(
          /^[a-f0-9]{24}$/.test(code),
          400,
          'Enter the full phone pairing code.',
        );
        const name = text(data, 'name');
        requireThat(name.length <= 80, 400, 'Phone name must be at most 80 characters.');
        const result = transaction(db, () => {
          const pairing = db
            .prepare('SELECT * FROM mobile_pairings WHERE code_hash=? AND expires_at>?')
            .get(hash(code), now());
          requireThat(pairing, 401, 'Pairing code expired or was already used.');
          const row = db
            .prepare(
              'SELECT u.*,t.id AS truck_id,t.plate AS truck_plate,t.profile AS truck_profile,t.approved AS truck_approved FROM users u LEFT JOIN trucks t ON t.driver_id=u.id WHERE u.id=?',
            )
            .get(pairing.user_id);
          const user = account(row),
            s = assigned(user, pairing.shipment_id);
          const token = randomBytes(32).toString('hex'),
            id = randomUUID(),
            expiresAt = now() + 7 * 86400000;
          db.prepare('DELETE FROM mobile_pairings WHERE user_id=? AND shipment_id=?').run(
            user.id,
            s.id,
          );
          // One phone owns location reporting for this driver/delivery. Pairing a new phone revokes the old one.
          db.prepare(
            'UPDATE mobile_devices SET revoked_at=? WHERE user_id=? AND shipment_id=? AND revoked_at IS NULL',
          ).run(now(), user.id, s.id);
          db.prepare('INSERT INTO mobile_devices VALUES (?,?,?,?,?,?,?,NULL,NULL)').run(
            id,
            hash(token),
            user.id,
            s.id,
            name,
            now(),
            expiresAt,
          );
          audit(s, user, `Android phone paired: ${name}`);
          return { token, deviceId: id, shipmentId: s.id, expiresAt };
        });
        send(res, 201, result);
      } finally {
        release();
      }
      return true;
    }
    if (
      !['/api/mobile/status', '/api/mobile/location', '/api/mobile/disconnect'].includes(
        path,
      )
    )
      return false;
    requireThat(
      (path.endsWith('/status') && req.method === 'GET') ||
        (!path.endsWith('/status') && req.method === 'POST'),
      405,
      'Unsupported mobile request method.',
    );
    const { device, user, s } = authenticate(req);
    if (path.endsWith('/disconnect')) {
      db.prepare('UPDATE mobile_devices SET revoked_at=? WHERE id=?').run(
        now(),
        device.id,
      );
      audit(s, user, 'Android phone disconnected');
      send(res, 200, { ok: true });
    } else if (path.endsWith('/status')) {
      db.prepare('UPDATE mobile_devices SET last_seen_at=? WHERE id=?').run(
        now(),
        device.id,
      );
      send(res, 200, {
        shipmentId: s.id,
        status: s.status,
        expiresAt: device.expires_at,
      });
    } else {
      requireThat(req.method === 'POST', 405, 'Use POST.');
      // Reuse the same assignment, accuracy and sample-age validation as browser GPS.
      await operations.route(
        `/api/shipments/${s.id}/tracking`,
        req,
        res,
        user,
        data,
        new URL('http://localhost'),
      );
      db.prepare('UPDATE mobile_devices SET last_seen_at=? WHERE id=?').run(
        now(),
        device.id,
      );
      await mobility.autoRoute(s.id, user);
    }
    return true;
  }
  function route(path, req, res, user, _data) {
    const match = /^\/api\/shipments\/([^/]+)\/mobile-devices(?:\/([^/]+))?$/.exec(path);
    if (!match) return false;
    const s = shipments(user, match[1], false)[0];
    requireThat(s, 404, 'Delivery not found.');
    requireThat(
      user.role === 'admin' || (user.role === 'driver' && s.driverId === user.id),
      403,
      'Broker or assigned driver access required.',
    );
    if (req.method === 'GET' && !match[2]) {
      send(
        res,
        200,
        db
          .prepare(
            'SELECT id,name,created_at AS createdAt,expires_at AS expiresAt,last_seen_at AS lastSeenAt,revoked_at AS revokedAt FROM mobile_devices WHERE shipment_id=? ORDER BY created_at DESC LIMIT 20',
          )
          .all(s.id),
      );
    } else if (req.method === 'DELETE' && match[2]) {
      const changed = db
        .prepare('UPDATE mobile_devices SET revoked_at=? WHERE id=? AND shipment_id=?')
        .run(now(), match[2], s.id);
      requireThat(changed.changes, 404, 'Phone not found.');
      audit(s, user, 'Android phone authorization revoked');
      send(res, 200, { ok: true });
    } else if (req.method === 'POST' && !match[2]) {
      assigned(user, s.id);
      const result = transaction(db, () => {
        db.prepare(
          'DELETE FROM mobile_pairings WHERE expires_at<=? OR (user_id=? AND shipment_id=?)',
        ).run(now(), user.id, s.id);
        const code = randomBytes(12).toString('hex'),
          expiresAt = now() + 5 * 60000;
        db.prepare('INSERT INTO mobile_pairings VALUES (?,?,?,?)').run(
          hash(code),
          user.id,
          s.id,
          expiresAt,
        );
        audit(s, user, 'Android phone pairing code issued');
        return { code: code.match(/.{6}/g).join('-'), expiresAt };
      });
      send(res, 201, result);
    } else requireThat(false, 405, 'Unsupported phone-management method.');
    return true;
  }
  return { route, publicRoute };
}
