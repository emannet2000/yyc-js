import { performance, monitorEventLoopDelay } from 'node:perf_hooks';

const started = performance.now();
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
const safeCount = (db, sql) => db.prepare(sql).get().total;
export function createSysadmin({ db, now = Date.now }) {
  function snapshot() {
    const integrity = db.prepare('PRAGMA quick_check').all().map((row) => Object.values(row)[0]);
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all().length;
    const counts = {
      users: safeCount(db, 'SELECT count(*) AS total FROM users'),
      activeSessions: db.prepare('SELECT count(*) AS total FROM sessions WHERE expires_at > ?').get(now()).total,
      shipments: safeCount(db, 'SELECT count(*) AS total FROM shipments'),
      pendingOffers: safeCount(db, "SELECT count(*) AS total FROM shipments WHERE status='Offered'"),
      shipmentEvents: safeCount(db, 'SELECT count(*) AS total FROM audit'),
    };
    return {
      checkedAt: new Date(now()).toISOString(),
      uptimeSeconds: Math.floor((performance.now() - started) / 1000),
      services: { api: 'healthy', sqlite: integrity.every((x) => x === 'ok') && !foreignKeys ? 'healthy' : 'degraded' },
      counts,
      database: { integrityOk: integrity.every((x) => x === 'ok'), foreignKeyViolations: foreignKeys },
      runtime: { node: process.version, memoryRssBytes: process.memoryUsage().rss, eventLoopDelayMeanMs: Number.isFinite(loop.mean) ? Math.round(loop.mean / 1e6 * 100) / 100 : null },
    };
  }
  function events(limit = 50) {
    const n = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50;
    return db.prepare(`SELECT a.id,a.shipment_id AS shipmentId,a.event,a.created_at AS createdAt
      FROM audit a ORDER BY a.id DESC LIMIT ?`).all(n);
  }
  function incidents() {
    const pending = db.prepare(`SELECT id,status,updated_at AS updatedAt
      FROM shipments WHERE status IN ('Delivery failed','Returning') ORDER BY updated_at DESC LIMIT 50`).all();
    return pending.map((s) => ({ id: s.id, type: 'shipment_exception', status: s.status, updatedAt: s.updatedAt }));
  }
  return { snapshot, events, incidents };
}
