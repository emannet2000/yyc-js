import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import {
  randomBytes,
  randomUUID,
  createHash,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { driverAvailable, canTakeCargo } from '../shared/scheduling.js';
import { createLoginLimiter } from './login-limiter.js';
import { createRegistrationLimiter } from './registration-limiter.js';
import { isPositiveMoney } from '../shared/money.js';
import { prePickup, cargoStates, validDeadline } from '../shared/planning.js';
import { createOperations } from './operations.js';
import { createMobility } from './mobility.js';
import { createMobile } from './mobile.js';

const deriveKey = promisify(scrypt);
const project = fileURLToPath(new URL('../', import.meta.url));
const roles = ['store', 'driver'];
const windows = ['09:00–12:00', '13:00–16:00', 'Flexible'];
const truckTypes = ['Box truck', 'Dry van'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function requireThat(condition, status, message) {
  if (!condition) throw new HttpError(status, message);
}
function text(data, key, optional = false) {
  const value = data[key];
  requireThat(
    typeof value === 'string' || (optional && value == null),
    400,
    `${key} must be text.`,
  );
  const result = (value || '').trim();
  requireThat(
    (optional || result.length > 0) && result.length <= 2000,
    400,
    `${key} is required and must be at most 2000 characters.`,
  );
  return result;
}
function positive(data, key, integer = false) {
  const value = data[key];
  requireThat(
    typeof value === 'number' &&
      Number.isFinite(value) &&
      value > 0 &&
      (!integer || Number.isSafeInteger(value)),
    400,
    `${key} must be a positive ${integer ? 'integer' : 'number'}.`,
  );
  return value;
}
function money(data, key) {
  requireThat(
    isPositiveMoney(data[key]),
    400,
    `${key} must be a positive amount in whole cents.`,
  );
  return data[key];
}
function choice(data, key, choices) {
  const value = text(data, key);
  requireThat(choices.includes(value), 400, `${key} is invalid.`);
  return value;
}
function password(data) {
  requireThat(
    typeof data.password === 'string' &&
      data.password.length >= 12 &&
      data.password.length <= 128,
    400,
    'Password must have 12–128 characters.',
  );
  return data.password;
}
async function passwordHash(value) {
  const salt = randomBytes(16).toString('hex');
  const key = await deriveKey(value, salt, 64);
  return `scrypt:${salt}:${key.toString('hex')}`;
}
async function passwordMatches(value, hash) {
  const [kind, salt, encoded] = hash.split(':');
  if (kind !== 'scrypt' || !salt || !encoded) return false;
  const key = await deriveKey(value, salt, 64);
  const expected = Buffer.from(encoded, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}
function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export function createApplication({
  databasePath = resolve(project, 'data/yyc.sqlite'),
  secureCookies = false,
  publicPath = resolve(project, 'public'),
  publicOrigin = 'http://127.0.0.1:3000',
  sendResetLink = null,
  sendNotification = null,
  calculateRoute = null,
  now = Date.now,
} = {}) {
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
  const origin = new URL(publicOrigin);
  requireThat(
    ['http:', 'https:'].includes(origin.protocol),
    400,
    'PUBLIC_ORIGIN must be an HTTP(S) origin.',
  );
  publicOrigin = origin.origin;
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('store','driver','admin')),name TEXT NOT NULL,profile TEXT NOT NULL,approved INTEGER NOT NULL DEFAULT 0,disabled INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS trucks(id TEXT PRIMARY KEY,driver_id TEXT NOT NULL UNIQUE REFERENCES users(id),plate TEXT NOT NULL UNIQUE,profile TEXT NOT NULL,approved INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS shipments(id TEXT PRIMARY KEY,store_id TEXT NOT NULL REFERENCES users(id),driver_id TEXT REFERENCES users(id),offered_to TEXT REFERENCES users(id),status TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,data TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,shipment_id TEXT REFERENCES shipments(id),actor_id TEXT NOT NULL REFERENCES users(id),event TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY,value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS password_resets(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS account_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT REFERENCES users(id),user_id TEXT NOT NULL REFERENCES users(id),event TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS booking_requests(user_id TEXT NOT NULL REFERENCES users(id),request_key TEXT NOT NULL,request_hash TEXT NOT NULL,shipment_id TEXT NOT NULL REFERENCES shipments(id),PRIMARY KEY(user_id,request_key));
    CREATE INDEX IF NOT EXISTS shipments_driver ON shipments(driver_id);
    CREATE INDEX IF NOT EXISTS shipments_store ON shipments(store_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS shipments_offer ON shipments(offered_to);
    CREATE INDEX IF NOT EXISTS audit_shipment ON audit(shipment_id,id);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);`);
  const loginLimiter = createLoginLimiter();
  const registrationLimiter = createRegistrationLimiter();
  const resetLimiter = createRegistrationLimiter();
  function accountEvent(actorId, userId, event) {
    db.prepare(
      'INSERT INTO account_audit(actor_id,user_id,event,created_at) VALUES (?,?,?,?)',
    ).run(actorId, userId, event, new Date(now()).toISOString());
  }
  function issueReset(userId, actorId, reason) {
    return transaction(db, () => {
      const target = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
      requireThat(
        target && !target.disabled,
        409,
        'Account must be active before password recovery.',
      );
      const token = randomBytes(32).toString('hex'),
        tokenHash = sha256(token),
        expiresAt = now() + 30 * 60000;
      db.prepare('DELETE FROM password_resets WHERE user_id=?').run(userId);
      db.prepare('INSERT INTO password_resets VALUES (?,?,?,?)').run(
        tokenHash,
        userId,
        expiresAt,
        new Date(now()).toISOString(),
      );
      accountEvent(actorId, userId, `Password recovery link issued: ${reason}`);
      return {
        tokenHash,
        email: target.email,
        resetUrl: `${publicOrigin}/react/?reset=1#token=${token}`,
        expiresAt,
      };
    });
  }
  function resetTarget(token) {
    requireThat(
      typeof token === 'string' && /^[a-f0-9]{64}$/.test(token),
      400,
      'Reset link is invalid or expired.',
    );
    const target = db
      .prepare(
        'SELECT r.*,u.disabled FROM password_resets r JOIN users u ON u.id=r.user_id WHERE token_hash=?',
      )
      .get(sha256(token));
    requireThat(
      target && !target.disabled && target.expires_at > now(),
      400,
      'Reset link is invalid or expired.',
    );
    return target;
  }
  function account(row) {
    if (!row) return null;
    const truck =
      'truck_id' in row
        ? row.truck_id && {
            id: row.truck_id,
            plate: row.truck_plate,
            profile: row.truck_profile,
            approved: row.truck_approved,
          }
        : db.prepare('SELECT * FROM trucks WHERE driver_id=?').get(row.id);
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      name: row.name,
      version: JSON.parse(row.profile).version || 1,
      approved: !!row.approved,
      disabled: !!row.disabled,
      profile: JSON.parse(row.profile),
      truck: truck
        ? {
            ...JSON.parse(truck.profile),
            id: truck.id,
            plate: truck.plate,
            approved: !!truck.approved,
          }
        : null,
    };
  }
  function shipments(user, id, includeHistory = true) {
    const conditions = [],
      params = [];
    if (user.role === 'store') {
      conditions.push('s.store_id=?');
      params.push(user.id);
    }
    if (user.role === 'driver') {
      conditions.push('(s.driver_id=? OR s.offered_to=?)');
      params.push(user.id, user.id);
    }
    if (id) {
      conditions.push('s.id=?');
      params.push(id);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const rows = db
      .prepare(
        `SELECT s.*,c.name AS customer,d.name AS driver_name
      FROM shipments s JOIN users c ON c.id=s.store_id LEFT JOIN users d ON d.id=s.driver_id
      ${where} ORDER BY s.created_at DESC,s.id DESC`,
      )
      .all(...params);
    const histories = new Map();
    if (includeHistory && rows.length) {
      const events = db
        .prepare(
          `SELECT a.shipment_id,a.event AS text,u.name AS actor,a.created_at AS time
        FROM audit a JOIN users u ON u.id=a.actor_id JOIN shipments s ON s.id=a.shipment_id
        ${where} ORDER BY a.id`,
        )
        .all(...params);
      for (const { shipment_id, ...event } of events) {
        if (!histories.has(shipment_id)) histories.set(shipment_id, []);
        histories.get(shipment_id).push(event);
      }
    }
    return rows.map((row) => ({
      ...JSON.parse(row.data),
      id: row.id,
      storeId: row.store_id,
      driverId: row.driver_id,
      offeredTo: row.offered_to,
      status: row.status,
      version: row.version,
      customer: row.customer,
      driverName: row.driver_name || null,
      history: histories.get(row.id) || [],
    }));
  }
  function commitments(driverId, _date) {
    return db
      .prepare(
        `SELECT id,status,driver_id AS driverId,offered_to AS offeredTo,
      json_extract(data,'$.date') AS date,json_extract(data,'$.window') AS window,
      json_extract(data,'$.estimatedMinutes') AS estimatedMinutes,json_extract(data,'$.travelBufferMinutes') AS travelBufferMinutes FROM shipments
      WHERE (driver_id=? OR offered_to=?) AND status IN ('Offered','Assigned','In transit','Delivery failed','Returning')`,
      )
      .all(driverId, driverId);
  }
  function cargoCommitments(driverId) {
    return db
      .prepare(
        `SELECT id,status,driver_id AS driverId,offered_to AS offeredTo FROM shipments
      WHERE status IN ('In transit','Delivery failed','Returning') AND (driver_id=? OR offered_to=?)`,
      )
      .all(driverId, driverId);
  }
  function audit(s, user, event) {
    db.prepare(
      'INSERT INTO audit(shipment_id,actor_id,event,created_at) VALUES (?,?,?,?)',
    ).run(s.id, user.id, event, new Date(now()).toISOString());
    operations.notifyShipment(s, event);
  }
  function persist(s) {
    const {
      storeId,
      driverId,
      offeredTo,
      status,
      version,
      id,
      customer: _customer,
      driverName: _driverName,
      history: _history,
      ...data
    } = s;
    db.prepare(
      'UPDATE shipments SET driver_id=?,offered_to=?,status=?,version=?,data=?,updated_at=? WHERE id=? AND store_id=?',
    ).run(
      driverId,
      offeredTo,
      status,
      version,
      JSON.stringify(data),
      new Date().toISOString(),
      id,
      storeId,
    );
  }
  function suitable(s, driver) {
    const t = driver?.truck;
    return (
      driver?.role === 'driver' &&
      driver.approved &&
      !driver.disabled &&
      t?.approved &&
      t.type === s.type &&
      t.kg >= s.kg &&
      t.pallets >= s.pallets &&
      (!s.unloading.includes('Liftgate') || t.liftgate)
    );
  }
  function scheduleInput(data) {
    const date = text(data, 'date'),
      window = choice(data, 'window', windows),
      deliveryDeadline = text(data, 'deliveryDeadline', true);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Edmonton',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(now()));
    requireThat(
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        Number.isFinite(Date.parse(date)) &&
        new Date(date).toISOString().slice(0, 10) === date &&
        date >= today,
      400,
      'Choose today or a valid future pickup date.',
    );
    const estimatedMinutes = data.estimatedMinutes ?? 0,
      travelBufferMinutes = data.travelBufferMinutes ?? 0;
    requireThat(
      [estimatedMinutes, travelBufferMinutes].every(
        (value) => Number.isSafeInteger(value) && value >= 0 && value <= 10080,
      ),
      400,
      'Planning minutes must be whole numbers from 0 to 10080.',
    );
    requireThat(
      validDeadline(
        date,
        window,
        deliveryDeadline,
        estimatedMinutes,
        travelBufferMinutes,
      ),
      400,
      'Delivery deadline must follow the planned pickup and travel interval.',
    );
    return { date, window, deliveryDeadline, estimatedMinutes, travelBufferMinutes };
  }
  function shipmentInput(data) {
    const result = {};
    for (const key of [
      'pickup',
      'destination',
      'date',
      'goods',
      'pickupContact',
      'receivingContact',
      'hours',
    ])
      result[key] = text(data, key);
    for (const key of ['notes', 'cargoNotes', 'appointment'])
      result[key] = text(data, key, true);
    requireThat(
      /^\d{4}-\d{2}-\d{2}$/.test(result.date) &&
        !Number.isNaN(Date.parse(result.date)) &&
        new Date(result.date).toISOString().slice(0, 10) === result.date,
      400,
      'Pickup date is invalid.',
    );
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Edmonton',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    requireThat(result.date >= today, 400, 'Choose today or a future pickup date.');
    requireThat(
      result.pickup.toLowerCase() !== result.destination.toLowerCase(),
      400,
      'Pickup and destination must differ.',
    );
    return {
      ...result,
      deliveryDeadline: scheduleInput({
        ...data,
        estimatedMinutes: 0,
        travelBufferMinutes: 0,
      }).deliveryDeadline,
      kg: positive(data, 'kg'),
      pallets: positive(data, 'pallets', true),
      type: choice(data, 'type', truckTypes),
      window: choice(data, 'window', windows),
      unloading: choice(data, 'unloading', [
        'Store has a loading dock',
        'Liftgate required',
      ]),
    };
  }
  function checkRegistrationAvailable(email, truck) {
    requireThat(
      !db.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(email),
      409,
      'Email is already registered.',
    );
    requireThat(
      !truck ||
        !db
          .prepare('SELECT id FROM trucks WHERE plate=? COLLATE NOCASE')
          .get(truck.plate),
      409,
      'Truck plate is already registered.',
    );
  }
  async function register(data, admin = false) {
    const role = admin ? 'admin' : choice(data, 'role', roles);
    const name = text(data, 'name'),
      email = text(data, 'email').toLowerCase();
    requireThat(
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254,
      400,
      'Email address is invalid.',
    );
    const profile = {
      phone: text(data, 'phone'),
      address: role === 'store' ? text(data, 'address') : '',
      contact: role === 'store' ? text(data, 'contact') : '',
    };
    const truck =
      role === 'driver'
        ? {
            truck: text(data, 'truck'),
            plate: text(data, 'plate').toUpperCase(),
            type: choice(data, 'type', truckTypes),
            kg: positive(data, 'kg'),
            pallets: positive(data, 'pallets', true),
            area: text(data, 'area'),
            liftgate: data.liftgate === true,
          }
        : null;
    const value = password(data);
    checkRegistrationAvailable(email, truck);
    const hash = await passwordHash(value),
      id = randomUUID();
    return transaction(db, () => {
      // Another request may have registered while password hashing was pending.
      checkRegistrationAvailable(email, truck);
      db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?)').run(
        id,
        email,
        hash,
        role,
        name,
        JSON.stringify(profile),
        role === 'driver' ? 0 : 1,
        0,
        new Date().toISOString(),
      );
      if (truck)
        db.prepare('INSERT INTO trucks VALUES (?,?,?,?,0)').run(
          randomUUID(),
          id,
          truck.plate,
          JSON.stringify(truck),
        );
      return { id };
    });
  }
  function session(req) {
    const token = /(?:^|;\s*)yyc_session=([a-f0-9]{64})(?:;|$)/.exec(
      req.headers.cookie || '',
    )?.[1];
    if (!token) return null;
    const row = db
      .prepare(
        'SELECT s.*,u.disabled FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=?',
      )
      .get(sha256(token));
    if (!row || row.expires_at <= Date.now() || row.disabled) return null;
    return {
      ...row,
      user: account(db.prepare('SELECT * FROM users WHERE id=?').get(row.user_id)),
    };
  }
  async function readBody(req) {
    requireThat(
      (req.headers['content-type'] || '').split(';')[0] === 'application/json',
      415,
      'Use application/json.',
    );
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      requireThat(
        size <=
          (/^\/api\/shipments\/[^/]+\/evidence$/.test(req.url) ? 3 * 1024 * 1024 : 65536),
        413,
        'Request is too large.',
      );
      chunks.push(chunk);
    }
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw new HttpError(400, 'Invalid JSON body.');
    }
    requireThat(
      data && typeof data === 'object' && !Array.isArray(data),
      400,
      'Body must be an object.',
    );
    return data;
  }
  function send(res, status, value) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(value));
  }
  function cookie(value, maxAge) {
    return `yyc_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
  }
  function applyAction(id, user, data) {
    return transaction(db, () => {
      const s = shipments(user, id, false)[0];
      requireThat(s, 404, 'Delivery not found.');
      let requestHash;
      if (data.requestKey !== undefined) {
        requireThat(
          typeof data.requestKey === 'string' &&
            /^[A-Za-z0-9_-]{16,128}$/.test(data.requestKey),
          400,
          'Invalid action request key.',
        );
        requestHash = sha256(JSON.stringify(data));
        const previous = db
          .prepare('SELECT * FROM action_requests WHERE user_id=? AND request_key=?')
          .get(user.id, data.requestKey);
        if (previous) {
          requireThat(
            previous.shipment_id === id && previous.request_hash === requestHash,
            409,
            'Action request key was used with different details.',
          );
          return JSON.parse(previous.result);
        }
      }
      requireThat(
        data.version === s.version,
        409,
        'Delivery changed. Refresh and review before trying again.',
      );
      const admin = user.role === 'admin',
        owner = user.role === 'store' && s.storeId === user.id;
      const assigned = user.role === 'driver' && s.driverId === user.id;
      const offered = user.role === 'driver' && s.offeredTo === user.id;
      const active = ['Assigned', ...cargoStates].includes(s.status);
      const allowed = (condition) =>
        requireThat(
          condition,
          403,
          'This action is not available for this account and delivery state.',
        );
      let message;
      const stopMessage = mobility.stopAction(s, user, data);
      if (stopMessage) message = stopMessage;
      else
        switch (data.action) {
          case 'reschedule': {
            allowed(admin && prePickup.includes(s.status));
            const plan = scheduleInput(data),
              reason = text(data, 'reason');
            requireThat(
              plan.date !== s.date ||
                plan.window !== s.window ||
                plan.deliveryDeadline !== (s.deliveryDeadline || '') ||
                plan.estimatedMinutes !== (s.estimatedMinutes || 0) ||
                plan.travelBufferMinutes !== (s.travelBufferMinutes || 0),
              400,
              'Change a schedule value first.',
            );
            s.quoteArchive = [
              ...(s.quoteArchive || []),
              {
                version: s.quoteVersion,
                price: s.price,
                rate: s.rate,
                destination: s.destination,
                kg: s.kg,
                pallets: s.pallets,
                date: s.date,
                window: s.window,
                reason,
              },
            ];
            Object.assign(s, plan, {
              quoteVersion: s.quoteVersion + 1,
              driverId: null,
              offeredTo: null,
              status: s.price == null ? 'Awaiting quote' : 'Quote ready',
            });
            delete s.arrivedAt;
            delete s.pickupArrivedAt;
            delete s.handover;
            delete s.offerExpiresAt;
            if (s.price != null) s.quoteExpiresAt = now() + 48 * 3600000;
            message = `Schedule revised; acceptance and assignment reset: ${reason}`;
            break;
          }
          case 'failDelivery':
            allowed(assigned && s.status === 'In transit');
            s.failedAttempts = [
              ...(s.failedAttempts || []),
              {
                reason: text(data, 'reason'),
                note: text(data, 'note'),
                time: new Date(now()).toISOString(),
                driverId: user.id,
                arrivedAt: s.arrivedAt || null,
              },
            ];
            s.status = 'Delivery failed';
            s.offeredTo = null;
            delete s.handover;
            delete s.offerExpiresAt;
            delete s.arrivedAt;
            message = `Delivery attempt failed: ${s.failedAttempts.at(-1).reason}`;
            break;
          case 'redeliver': {
            allowed(admin && s.status === 'Delivery failed');
            requireThat(
              !s.issue || s.issue.resolved,
              409,
              'Resolve the open issue before redelivery.',
            );
            const plan = scheduleInput(data);
            const reason = text(data, 'reason');
            requireThat(
              driverAvailable({ ...s, ...plan }, commitments(s.driverId), s.driverId),
              409,
              'The driver has another reservation during redelivery.',
            );
            Object.assign(s, plan, { status: 'In transit', offeredTo: null });
            delete s.handover;
            delete s.offerExpiresAt;
            delete s.arrivedAt;
            message = `Redelivery arranged: ${reason}`;
            break;
          }
          case 'return':
            allowed(admin && ['In transit', 'Delivery failed'].includes(s.status));
            s.returnReason = text(data, 'reason');
            s.returnDestination = s.pickup;
            s.status = 'Returning';
            s.offeredTo = null;
            delete s.handover;
            delete s.offerExpiresAt;
            delete s.arrivedAt;
            message = `Return to pickup arranged: ${s.returnReason}`;
            break;
          case 'confirmReturn':
            allowed(assigned && s.status === 'Returning');
            requireThat(
              !s.issue || s.issue.resolved,
              409,
              'Resolve the open issue before completing the return.',
            );
            s.returnPod = text(data, 'pod');
            s.returnRecipient = text(data, 'recipient');
            s.status = 'Returned';
            s.offeredTo = null;
            delete s.handover;
            delete s.offerExpiresAt;
            message = 'Cargo return confirmed';
            break;
          case 'quote':
            allowed(admin && s.status === 'Awaiting quote');
            s.price = money(data, 'price');
            s.rate = money(data, 'rate');
            requireThat(
              s.rate <= s.price,
              400,
              'Driver rate cannot exceed customer price.',
            );
            s.status = 'Quote ready';
            s.quoteExpiresAt = now() + 48 * 3600000;
            message = 'Quotation issued';
            break;
          case 'requote': {
            allowed(
              admin &&
                ['Quote ready', 'Ready to assign', 'Offered', 'Assigned'].includes(
                  s.status,
                ),
            );
            const price = money(data, 'price'),
              rate = money(data, 'rate'),
              reason = text(data, 'reason');
            requireThat(rate <= price, 400, 'Driver rate cannot exceed customer price.');
            requireThat(
              price !== s.price || rate !== s.rate,
              400,
              'Change a quote amount before issuing a correction.',
            );
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
              price,
              rate,
              quoteVersion: s.quoteVersion + 1,
              driverId: null,
              offeredTo: null,
              status: 'Quote ready',
            });
            delete s.handover;
            delete s.offerExpiresAt;
            s.quoteExpiresAt = now() + 48 * 3600000;
            delete s.arrivedAt;
            delete s.pickupArrivedAt;
            message = `Quotation corrected to v${s.quoteVersion}; acceptance and assignment reset: ${reason}`;
            break;
          }
          case 'handover': {
            allowed(admin && active && !!s.driverId);
            requireThat(
              !s.handover && !s.offeredTo,
              409,
              'Withdraw the pending handover before offering another driver.',
            );
            const replacementId = text(data, 'driverId'),
              reason = text(data, 'reason');
            requireThat(
              replacementId !== s.driverId,
              400,
              'Choose a different replacement driver.',
            );
            const replacement = account(
              db.prepare('SELECT * FROM users WHERE id=?').get(replacementId),
            );
            requireThat(
              suitable(s, replacement),
              400,
              'Replacement driver and truck must be approved and suitable.',
            );
            requireThat(
              driverAvailable(s, commitments(replacementId, s.date), replacementId),
              409,
              'Replacement driver already has a commitment in this pickup window.',
            );
            requireThat(
              !cargoStates.includes(s.status) ||
                canTakeCargo(s.id, cargoCommitments(replacementId), replacementId),
              409,
              'Replacement driver must finish the current live load or pending cargo handover first.',
            );
            s.offeredTo = replacementId;
            s.offerExpiresAt = now() + 3600000;
            s.handover = {
              fromDriverId: s.driverId,
              reason,
              offeredAt: new Date().toISOString(),
            };
            message = `Driver handover offered to ${replacement.name}: ${reason}`;
            break;
          }
          case 'withdrawHandover':
            allowed(admin && active && !!s.handover && !!s.offeredTo);
            message = `Driver handover withdrawn: ${text(data, 'reason')}`;
            s.offeredTo = null;
            delete s.offerExpiresAt;
            delete s.handover;
            break;
          case 'acceptQuote':
            allowed(owner && s.status === 'Quote ready');
            s.status = 'Ready to assign';
            delete s.quoteExpiresAt;
            message = 'Quotation accepted';
            break;
          case 'offer': {
            allowed(admin && s.status === 'Ready to assign');
            const driver = account(
              db.prepare('SELECT * FROM users WHERE id=?').get(text(data, 'driverId')),
            );
            requireThat(
              suitable(s, driver),
              400,
              'Driver and truck must be approved and suitable.',
            );
            requireThat(
              driverAvailable(s, commitments(driver.id, s.date), driver.id),
              409,
              'Driver already has a commitment in this pickup window.',
            );
            s.offeredTo = driver.id;
            s.offerExpiresAt = now() + 3600000;
            s.status = 'Offered';
            message = 'Job offered';
            break;
          }
          case 'acceptJob':
            allowed(offered && (s.status === 'Offered' || (active && !!s.handover)));
            requireThat(
              suitable(s, user),
              403,
              'Driver and truck approval or suitability is missing.',
            );
            requireThat(
              driverAvailable(s, commitments(user.id, s.date), user.id),
              409,
              'You already have a commitment in this pickup window.',
            );
            requireThat(
              !s.handover ||
                !cargoStates.includes(s.status) ||
                canTakeCargo(s.id, cargoCommitments(user.id), user.id),
              409,
              'Finish the current live load or pending cargo handover before accepting another load.',
            );
            if (s.handover) {
              const previousDriver = db
                .prepare('SELECT name FROM users WHERE id=?')
                .get(s.driverId);
              s.handoverHistory = [
                ...(s.handoverHistory || []),
                {
                  ...s.handover,
                  toDriverId: user.id,
                  acceptedAt: new Date().toISOString(),
                  status: s.status,
                },
              ];
              message = `Driver accepted handover from ${previousDriver?.name || s.driverId}: ${s.handover.reason}`;
              delete s.handover;
              delete s.arrivedAt;
            } else {
              s.status = 'Assigned';
              message = 'Job accepted';
            }
            s.driverId = user.id;
            s.offeredTo = null;
            delete s.offerExpiresAt;
            break;
          case 'decline':
            allowed(offered && (s.status === 'Offered' || (active && !!s.handover)));
            s.offeredTo = null;
            delete s.offerExpiresAt;
            if (s.handover) {
              delete s.handover;
              message = 'Driver handover declined; current assignment retained';
            } else {
              s.status = 'Ready to assign';
              message = 'Job offer declined';
            }
            break;
          case 'arrival':
            allowed(assigned && active);
            requireThat(!s.arrivedAt, 409, 'Arrival is already recorded for this leg.');
            s.arrivedAt = new Date().toISOString();
            message = `Arrival recorded at ${s.status === 'Assigned' ? 'pickup' : 'delivery'}`;
            break;
          case 'pickup':
            allowed(assigned && s.status === 'Assigned' && suitable(s, user));
            requireThat(
              !s.issue || s.issue.resolved,
              409,
              'Resolve the open issue before collecting the load.',
            );
            requireThat(
              canTakeCargo(s.id, cargoCommitments(user.id), user.id),
              409,
              'Finish the current live load or pending cargo handover before collecting another load.',
            );
            s.pickupArrivedAt = s.arrivedAt || null;
            delete s.arrivedAt;
            s.status = 'In transit';
            message = 'Pickup confirmed';
            break;
          case 'deliver':
            allowed(assigned && s.status === 'In transit');
            requireThat(
              !(s.stops || []).some((stop) => !stop.completedAt),
              409,
              'Complete every intermediate stop before final delivery.',
            );
            requireThat(
              !s.issue || s.issue.resolved,
              409,
              'Resolve the open issue before completing delivery.',
            );
            s.pod = text(data, 'pod');
            s.recipient = text(data, 'recipient');
            s.status = 'Delivered';
            s.offeredTo = null;
            delete s.offerExpiresAt;
            delete s.handover;
            message = 'Delivery confirmed';
            break;
          case 'issue':
            allowed(assigned && active && (!s.issue || s.issue.resolved));
            s.issueArchive = [...(s.issueArchive || []), ...(s.issue ? [s.issue] : [])];
            s.issue = {
              reason: text(data, 'reason'),
              note: text(data, 'note'),
              resolved: false,
            };
            message = `Delivery issue: ${s.issue.reason} — ${s.issue.note}`;
            break;
          case 'resolve':
            allowed(admin && s.issue && !s.issue.resolved);
            s.issue.resolution = text(data, 'resolution');
            s.issue.resolved = true;
            message = `Issue resolved: ${s.issue.resolution}`;
            break;
          case 'change': {
            allowed(admin && prePickup.includes(s.status));
            const destination = text(data, 'destination'),
              kg = positive(data, 'kg'),
              pallets = positive(data, 'pallets', true),
              reason = text(data, 'reason');
            requireThat(
              destination !== s.destination || kg !== s.kg || pallets !== s.pallets,
              400,
              'Change a destination or cargo value first.',
            );
            requireThat(
              destination.toLowerCase() !== s.pickup.toLowerCase(),
              400,
              'Pickup and destination must differ.',
            );
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
              destination,
              kg,
              pallets,
              quoteVersion: s.quoteVersion + 1,
              price: null,
              rate: null,
              driverId: null,
              offeredTo: null,
              status: 'Awaiting quote',
            });
            delete s.arrivedAt;
            delete s.pickupArrivedAt;
            delete s.handover;
            message = `Shipment revised; quotation and assignment reset: ${reason}`;
            break;
          }
          case 'cancel':
            allowed(
              (admin && prePickup.includes(s.status)) ||
                (owner && ['Awaiting quote', 'Quote ready'].includes(s.status)),
            );
            s.status = 'Cancelled';
            s.driverId = null;
            s.offeredTo = null;
            delete s.offerExpiresAt;
            delete s.handover;
            message = 'Delivery cancelled';
            break;
          default:
            throw new HttpError(400, 'Unknown delivery action.');
        }
      s.version++;
      persist(s);
      if (['Delivered', 'Returned', 'Cancelled'].includes(s.status)) {
        db.prepare(
          'UPDATE mobile_devices SET revoked_at=? WHERE shipment_id=? AND revoked_at IS NULL',
        ).run(now(), id);
        db.prepare('DELETE FROM mobile_pairings WHERE shipment_id=?').run(id);
      } else {
        db.prepare(
          'UPDATE mobile_devices SET revoked_at=? WHERE shipment_id=? AND user_id IS NOT ? AND revoked_at IS NULL',
        ).run(now(), id, s.driverId);
        db.prepare(
          'DELETE FROM mobile_pairings WHERE shipment_id=? AND user_id IS NOT ?',
        ).run(id, s.driverId);
      }
      audit(s, user, message);
      const result = { version: s.version };
      if (data.requestKey)
        db.prepare('INSERT INTO action_requests VALUES (?,?,?,?,?)').run(
          user.id,
          data.requestKey,
          id,
          requestHash,
          JSON.stringify(result),
        );
      // Progress changes invalidate old route/ETA so recipients never see an old leg.
      if (
        [
          'pickup',
          'completeStop',
          'deliver',
          'return',
          'confirmReturn',
          'cancel',
          'change',
          'reschedule',
          'handover',
          'acceptJob',
        ].includes(data.action)
      ) {
        const row = db.prepare('SELECT data FROM tracking WHERE shipment_id=?').get(id);
        if (row) {
          const t = JSON.parse(row.data);
          delete t.route;
          delete t.eta;
          delete t.etaUpdatedAt;
          db.prepare('UPDATE tracking SET data=? WHERE shipment_id=?').run(
            JSON.stringify(t),
            id,
          );
        }
      }
      return result;
    });
  }
  function serveStatic(req, res, pathname) {
    requireThat(
      req.method === 'GET' || req.method === 'HEAD',
      405,
      'Method not allowed.',
    );
    if (pathname === '/') {
      res.writeHead(302, { Location: '/react/' });
      res.end();
      return;
    }
    if (pathname === '/react' || pathname === '/demo') {
      res.writeHead(302, { Location: pathname + '/' });
      res.end();
      return;
    }
    const path = resolve(
      publicPath,
      '.' + pathname + (pathname.endsWith('/') ? 'index.html' : ''),
    );
    requireThat(path.startsWith(resolve(publicPath) + sep), 404, 'File not found.');
    const mime = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    };
    requireThat(mime[extname(path)], 404, 'File not found.');
    let content;
    try {
      requireThat(statSync(path).isFile(), 404, 'File not found.');
      content = readFileSync(path);
    } catch {
      throw new HttpError(404, 'File not found. Build the frontend with npm run build.');
    }
    res.writeHead(200, {
      'Content-Type': mime[extname(path)],
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  }
  const operations = createOperations({
    db,
    now,
    text,
    positive,
    choice,
    requireThat,
    transaction,
    shipments,
    persist,
    audit,
    account,
    accountEvent,
    send,
    sendNotification,
  });
  const mobility = createMobility({
    db,
    now,
    requireThat,
    text,
    transaction,
    shipments,
    persist,
    audit,
    send,
    calculateRoute,
    publicOrigin,
  });
  const mobile = createMobile({
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
  });
  const server = createServer(async (req, res) => {
    try {
      let path;
      try {
        path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      } catch {
        throw new HttpError(400, 'Invalid request URL.');
      }
      if (!path.startsWith('/api/')) {
        serveStatic(req, res, path);
        return;
      }
      if (path === '/api/recipient-tracking' && req.method === 'POST') {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        const data = await readBody(req);
        mobility.recipientView(data.token, res);
        return;
      }
      if (path.startsWith('/api/mobile/')) {
        const data = req.method === 'POST' ? await readBody(req) : {};
        if (await mobile.publicRoute(path, req, res, data)) return;
        throw new HttpError(404, 'Mobile endpoint not found.');
      }
      const write = !['GET', 'HEAD'].includes(req.method);
      if (write && req.headers.origin) {
        let origin;
        try {
          origin = new URL(req.headers.origin);
        } catch {
          throw new HttpError(403, 'Invalid request origin.');
        }
        requireThat(
          origin.origin === req.headers.origin &&
            origin.host === req.headers.host &&
            ['http:', 'https:'].includes(origin.protocol),
          403,
          'Cross-origin requests are not allowed.',
        );
      }
      if (
        req.method === 'POST' &&
        ['/api/password-reset/request', '/api/password-reset/complete'].includes(path)
      ) {
        const data = await readBody(req);
        const release = resetLimiter.reserve(req.socket.remoteAddress || 'local');
        requireThat(release, 429, 'Too many recovery requests. Try again later.');
        try {
          if (path.endsWith('/request')) {
            const email = text(data, 'email').toLowerCase();
            requireThat(
              sendResetLink,
              503,
              'Email recovery is not configured. Contact YYC for a recovery link.',
            );
            const target = db
              .prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE AND disabled=0')
              .get(email);
            if (target) {
              const issued = issueReset(target.id, null, 'Account email request');
              try {
                await sendResetLink({
                  email: issued.email,
                  resetUrl: issued.resetUrl,
                  expiresAt: issued.expiresAt,
                });
              } catch {
                db.prepare('DELETE FROM password_resets WHERE token_hash=?').run(
                  issued.tokenHash,
                );
                console.error('Password recovery delivery failed.');
              }
            }
            send(res, 200, {
              message:
                'If this account is eligible, recovery instructions will be provided. Contact YYC if no message arrives.',
            });
          } else {
            resetTarget(data.token);
            const hash = await passwordHash(password(data));
            transaction(db, () => {
              const target = resetTarget(data.token);
              db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(
                hash,
                target.user_id,
              );
              db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.user_id);
              db.prepare('DELETE FROM mobile_pairings WHERE user_id=?').run(
                target.user_id,
              );
              db.prepare(
                'UPDATE mobile_devices SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL',
              ).run(now(), target.user_id);
              db.prepare('DELETE FROM password_resets WHERE user_id=?').run(
                target.user_id,
              );
              accountEvent(
                target.user_id,
                target.user_id,
                'Password changed through account recovery',
              );
            });
            send(res, 200, { ok: true });
          }
        } finally {
          release();
        }
        return;
      }
      if (req.method === 'POST' && path === '/api/register') {
        const data = await readBody(req);
        const release = registrationLimiter.reserve(req.socket.remoteAddress || 'local');
        requireThat(release, 429, 'Too many registration requests. Try again later.');
        try {
          send(res, 201, await register(data));
        } finally {
          release();
        }
        return;
      }
      if (req.method === 'POST' && path === '/api/login') {
        const data = await readBody(req),
          email = text(data, 'email').toLowerCase(),
          value = password(data),
          now = Date.now();
        const key = loginLimiter.reserve(req.socket.remoteAddress || 'local', email);
        requireThat(
          key,
          429,
          'Too many login attempts for this account. Try again later.',
        );
        const row = db
          .prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE')
          .get(email);
        const valid = await passwordMatches(
          value,
          row?.password_hash || `scrypt:invalid:${'00'.repeat(64)}`,
        );
        requireThat(
          row && valid && !row.disabled,
          401,
          'Email or password is incorrect.',
        );
        loginLimiter.succeed(key);
        const token = randomBytes(32).toString('hex'),
          csrf = randomBytes(32).toString('hex');
        transaction(db, () => {
          const fresh = db
            .prepare('SELECT disabled,password_hash FROM users WHERE id=?')
            .get(row.id);
          requireThat(
            fresh && !fresh.disabled && fresh.password_hash === row.password_hash,
            401,
            'Email or password is incorrect.',
          );
          db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now);
          db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(
            sha256(token),
            row.id,
            csrf,
            now + 8 * 3600000,
          );
        });
        res.setHeader('Set-Cookie', cookie(token, 8 * 3600));
        send(res, 200, { csrf });
        return;
      }
      const current = session(req);
      if (path === '/api/session' && req.method === 'GET') {
        send(res, 200, { user: current?.user || null, csrf: current?.csrf || null });
        return;
      }
      requireThat(current, 401, 'Log in to continue.');
      if (write)
        requireThat(
          req.headers['x-csrf-token'] === current.csrf,
          403,
          'Invalid CSRF token. Reload and try again.',
        );
      let user = current.user;
      operations.expire();
      if (path === '/api/logout' && req.method === 'POST') {
        db.prepare('DELETE FROM sessions WHERE token_hash=?').run(current.token_hash);
        res.setHeader('Set-Cookie', cookie('', 0));
        send(res, 200, { ok: true });
        return;
      }
      if (path === '/api/state' && req.method === 'GET') {
        const list = shipments(user).map((s) => {
          if (user.role === 'store') {
            delete s.rate;
            s.quoteArchive = s.quoteArchive?.map(({ rate: _rate, ...quote }) => quote);
          }
          if (user.role === 'driver') {
            delete s.price;
            s.quoteArchive = s.quoteArchive?.map(({ price: _price, ...quote }) => quote);
          }
          return s;
        });
        send(res, 200, {
          csrf: current.csrf,
          user,
          shipments: list,
          accounts:
            user.role === 'admin'
              ? db
                  .prepare(
                    `SELECT u.*,t.id AS truck_id,t.plate AS truck_plate,t.profile AS truck_profile,t.approved AS truck_approved
            FROM users u LEFT JOIN trucks t ON t.driver_id=u.id ORDER BY u.created_at,u.id`,
                  )
                  .all()
                  .map(account)
              : [],
          drivers:
            user.role === 'admin'
              ? db
                  .prepare(
                    `SELECT u.*,t.id AS truck_id,t.plate AS truck_plate,t.profile AS truck_profile,t.approved AS truck_approved
                  FROM users u LEFT JOIN trucks t ON t.driver_id=u.id WHERE u.role='driver'`,
                  )
                  .all()
                  .map(account)
              : [],
        });
        return;
      }
      const data = write ? await readBody(req) : {};
      if (write) {
        const freshSession = session(req);
        requireThat(
          freshSession && freshSession.user.id === user.id,
          401,
          'Log in to continue.',
        );
        user = freshSession.user;
        operations.expire();
      }
      if (mobile.route(path, req, res, user, data)) return;
      if (await mobility.route(path, req, res, user, data)) return;
      if (
        await operations.route(
          path,
          req,
          res,
          user,
          data,
          new URL(req.url, 'http://localhost'),
        )
      ) {
        const location = /^\/api\/shipments\/([^/]+)\/tracking$/.exec(path);
        if (location && req.method === 'POST')
          await mobility.autoRoute(location[1], user);
        return;
      }
      if (path === '/api/profile' && req.method === 'PATCH') {
        requireThat(user.role === 'store', 403, 'Only stores can edit this profile.');
        const name = text(data, 'name'),
          profile = {
            phone: text(data, 'phone'),
            address: text(data, 'address'),
            contact: text(data, 'contact'),
          };
        db.prepare('UPDATE users SET name=?,profile=? WHERE id=?').run(
          name,
          JSON.stringify(profile),
          user.id,
        );
        send(res, 200, { ok: true });
        return;
      }
      const accountRoute = /^\/api\/accounts\/([^/]+)\/(status|password-reset)$/.exec(
        path,
      );
      if (accountRoute && req.method === 'POST') {
        requireThat(user.role === 'admin', 403, 'Broker access required.');
        const targetId = accountRoute[1],
          reason = text(data, 'reason');
        const target = db.prepare('SELECT * FROM users WHERE id=?').get(targetId);
        requireThat(target, 404, 'Account not found.');
        if (accountRoute[2] === 'password-reset') {
          const { resetUrl, expiresAt } = issueReset(targetId, user.id, reason);
          send(res, 200, { resetUrl, expiresAt });
        } else {
          requireThat(
            typeof data.disabled === 'boolean',
            400,
            'disabled must be a boolean.',
          );
          requireThat(
            !(data.disabled && targetId === user.id),
            400,
            'You cannot disable your own account.',
          );
          transaction(db, () => {
            if (data.disabled && target.role === 'admin')
              requireThat(
                db
                  .prepare(
                    "SELECT count(*) AS total FROM users WHERE role='admin' AND disabled=0",
                  )
                  .get().total > 1,
                409,
                'At least one broker must remain active.',
              );
            db.prepare('UPDATE users SET disabled=? WHERE id=?').run(
              data.disabled ? 1 : 0,
              targetId,
            );
            if (data.disabled) {
              db.prepare('DELETE FROM sessions WHERE user_id=?').run(targetId);
              db.prepare('DELETE FROM password_resets WHERE user_id=?').run(targetId);
              db.prepare('DELETE FROM mobile_pairings WHERE user_id=?').run(targetId);
              db.prepare(
                'UPDATE mobile_devices SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL',
              ).run(now(), targetId);
              // Withdraw unaccepted offers; preserve accepted jobs for broker review.
              for (const s of shipments(user).filter(
                (s) =>
                  s.offeredTo === targetId && (s.status === 'Offered' || !!s.handover),
              )) {
                s.offeredTo = null;
                delete s.offerExpiresAt;
                if (s.handover) delete s.handover;
                else s.status = 'Ready to assign';
                s.version++;
                persist(s);
                audit(
                  s,
                  user,
                  `Job offer withdrawn because the driver account was disabled: ${reason}`,
                );
              }
            }
            accountEvent(
              user.id,
              targetId,
              `${data.disabled ? 'Account disabled' : 'Account enabled'}: ${reason}`,
            );
          });
          send(res, 200, { ok: true });
        }
        return;
      }
      const approval = /^\/api\/drivers\/([^/]+)\/approve$/.exec(path);
      if (approval && req.method === 'POST') {
        requireThat(user.role === 'admin', 403, 'Broker access required.');
        transaction(db, () => {
          const driver = account(
            db.prepare('SELECT * FROM users WHERE id=?').get(approval[1]),
          );
          requireThat(
            driver?.role === 'driver' && !driver.disabled && driver.truck,
            404,
            'Driver or truck not found.',
          );
          db.prepare('UPDATE users SET approved=1 WHERE id=?').run(driver.id);
          db.prepare('UPDATE trucks SET approved=1 WHERE driver_id=?').run(driver.id);
          db.prepare('UPDATE users SET profile=? WHERE id=?').run(
            JSON.stringify({
              ...driver.profile,
              version: driver.version + 1,
              reviewDecision: 'approve',
              reviewReason: 'Manual broker approval',
            }),
            driver.id,
          );
          accountEvent(user.id, driver.id, 'Driver and truck manually approved');
        });
        send(res, 200, { ok: true });
        return;
      }
      if (path === '/api/shipments' && req.method === 'POST') {
        requireThat(user.role === 'store', 403, 'Only stores can request delivery.');
        const requestKey = req.headers['idempotency-key'];
        requireThat(
          typeof requestKey === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(requestKey),
          400,
          'A valid Idempotency-Key header is required.',
        );
        const requestHash = sha256(
          JSON.stringify(
            Object.fromEntries(
              Object.keys(data)
                .sort()
                .map((key) => [key, data[key]]),
            ),
          ),
        );
        const result = transaction(db, () => {
          const previous = db
            .prepare(
              'SELECT request_hash,shipment_id FROM booking_requests WHERE user_id=? AND request_key=?',
            )
            .get(user.id, requestKey);
          if (previous) {
            requireThat(
              previous.request_hash === requestHash,
              409,
              'This booking request was already used with different details.',
            );
            return { id: previous.shipment_id };
          }
          const input = shipmentInput(data);
          db.prepare(
            "INSERT INTO counters(name,value) VALUES ('shipment',1042) ON CONFLICT(name) DO NOTHING",
          ).run();
          let id;
          do {
            db.prepare("UPDATE counters SET value=value+1 WHERE name='shipment'").run();
            id =
              'YYC-' +
              db.prepare("SELECT value FROM counters WHERE name='shipment'").get().value;
          } while (db.prepare('SELECT id FROM shipments WHERE id=?').get(id));
          const createdAt = new Date(now()).toISOString();
          db.prepare('INSERT INTO shipments VALUES (?,?,NULL,NULL,?,1,?,?,?)').run(
            id,
            user.id,
            'Awaiting quote',
            JSON.stringify({ ...input, quoteVersion: 1, price: null, rate: null }),
            createdAt,
            createdAt,
          );
          audit({ id, storeId: user.id }, user, 'Delivery request received');
          const draft = db
            .prepare('SELECT data,version FROM booking_drafts WHERE user_id=?')
            .get(user.id);
          if (
            draft &&
            Object.entries(JSON.parse(draft.data)).every(
              ([key, value]) => String(value) === String(data[key] ?? ''),
            )
          )
            db.prepare(
              'UPDATE booking_drafts SET data=?,version=version+1,updated_at=? WHERE user_id=?',
            ).run('{}', new Date(now()).toISOString(), user.id);
          db.prepare('INSERT INTO booking_requests VALUES (?,?,?,?)').run(
            user.id,
            requestKey,
            requestHash,
            id,
          );
          return { id };
        });
        send(res, 201, result);
        return;
      }
      const action = /^\/api\/shipments\/([^/]+)\/actions$/.exec(path);
      if (action && req.method === 'POST') {
        send(res, 200, applyAction(action[1], user, data));
        return;
      }
      throw new HttpError(404, 'Endpoint not found.');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('Request failed:', error);
      if (!res.headersSent)
        send(res, status, {
          error: status === 500 ? 'Server error. Please try again.' : error.message,
        });
      else res.end();
    }
  });
  return {
    server,
    processNotifications: operations.processNotifications,
    expire: operations.expire,
    close: () => db.close(),
    createAdmin: (data) => register(data, true),
  };
}
