import { performance, monitorEventLoopDelay } from 'node:perf_hooks';

const started = performance.now();
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
const safeCount = (db, sql) => db.prepare(sql).get().total;
export function createSysadmin({ db, now = Date.now }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sysadmin_incidents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    severity TEXT NOT NULL CHECK(severity IN ('low','medium','high','critical')),
    status TEXT NOT NULL CHECK(status IN ('open','acknowledged','resolved')),
    details TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    updated_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sysadmin_incident_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id TEXT NOT NULL REFERENCES sysadmin_incidents(id),
    actor_id TEXT NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`);
  function recordIncident({ id, title, severity, details, actorId }) {
    const timestamp = new Date(now()).toISOString();
    db.prepare(`INSERT INTO sysadmin_incidents
      (id,title,severity,status,details,created_by,updated_by,created_at,updated_at)
      VALUES (?,?,?,'open',?,?,?,?,?)`).run(id,title,severity,details,actorId,actorId,timestamp,timestamp);
    db.prepare('INSERT INTO sysadmin_incident_audit(incident_id,actor_id,action,created_at) VALUES (?,?,?,?)')
      .run(id,actorId,'created',timestamp);
    return getIncident(id);
  }
  function getIncident(id) {
    return db.prepare('SELECT id,title,severity,status,details,created_at AS createdAt,updated_at AS updatedAt FROM sysadmin_incidents WHERE id=?').get(id);
  }
  function changeIncident({ id, status, actorId }) {
    const timestamp = new Date(now()).toISOString();
    const result = db.prepare('UPDATE sysadmin_incidents SET status=?,updated_by=?,updated_at=? WHERE id=? AND status<>?')
      .run(status,actorId,timestamp,id,status);
    if (result.changes) db.prepare('INSERT INTO sysadmin_incident_audit(incident_id,actor_id,action,created_at) VALUES (?,?,?,?)')
      .run(id,actorId,'status:'+status,timestamp);
    return getIncident(id);
  }
  function trackedIncidents() {
    return db.prepare('SELECT id,title,severity,status,details,created_at AS createdAt,updated_at AS updatedAt FROM sysadmin_incidents ORDER BY updated_at DESC LIMIT 100').all();
  }
  function incidentHistory(id) {
    return db.prepare(`SELECT action,created_at AS createdAt FROM sysadmin_incident_audit
      WHERE incident_id=? ORDER BY id DESC LIMIT 100`).all(id);
  }
  function dataQuality() {
    const unassignedActive = db.prepare(`SELECT count(*) AS total FROM shipments
      WHERE status IN ('Assigned','In transit','Delivery failed','Returning') AND driver_id IS NULL`).get().total;
    const missingStores = db.prepare(`SELECT count(*) AS total FROM shipments s
      LEFT JOIN users u ON u.id=s.store_id WHERE u.id IS NULL`).get().total;
    const orphanedOffers = db.prepare(`SELECT count(*) AS total FROM shipments
      WHERE status='Offered' AND offered_to IS NULL`).get().total;
    return { checkedAt: new Date(now()).toISOString(), unassignedActive, missingStores, orphanedOffers,
      healthy: unassignedActive===0 && missingStores===0 && orphanedOffers===0 };
  }
  function readiness() {
    const quality = dataQuality();
    const openCritical = db.prepare(`SELECT count(*) AS total FROM sysadmin_incidents
      WHERE severity='critical' AND status<>'resolved'`).get().total;
    return { checkedAt: new Date(now()).toISOString(), checks: {
      dataQuality: quality.healthy, noOpenCriticalIncidents: openCritical===0,
      backupVerified: null, browserTestsPassed: null, securityReviewPassed: null,
      rollbackVerified: null
    }, ready: false, reason: 'Manual and external checks have not been verified' };
  }
  const http = { total: 0, errors4xx: 0, errors5xx: 0, latencyMsTotal: 0, latencyMsMax: 0, routes: new Map() };
  function observeHttp({ method, route, status, durationMs }) {
    // Record only the route category, never URLs, tokens, IPs, or request bodies.
    const key = method + ' ' + route;
    const row = http.routes.get(key) || { route: key, requests: 0, errors: 0, latencyMsTotal: 0 };
    row.requests++;
    row.latencyMsTotal += durationMs;
    if (status >= 400) row.errors++;
    http.routes.set(key, row);
    http.total++;
    if (status >= 400 && status < 500) http.errors4xx++;
    if (status >= 500) http.errors5xx++;
    http.latencyMsTotal += durationMs;
    http.latencyMsMax = Math.max(http.latencyMsMax, durationMs);
  }
  function httpMetrics() {
    return {
      sinceStart: true, total: http.total, errors4xx: http.errors4xx, errors5xx: http.errors5xx,
      averageLatencyMs: http.total ? Math.round(http.latencyMsTotal / http.total * 100) / 100 : 0,
      maxLatencyMs: Math.round(http.latencyMsMax * 100) / 100,
      routes: [...http.routes.values()].map((row) => ({
        route: row.route, requests: row.requests, errors: row.errors,
        averageLatencyMs: Math.round(row.latencyMsTotal / row.requests * 100) / 100,
      })).sort((a,b) => b.requests-a.requests).slice(0,30),
    };
  }
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
  return { snapshot, events, incidents, recordIncident, getIncident, changeIncident, trackedIncidents, incidentHistory, dataQuality, readiness, observeHttp, httpMetrics };
}
