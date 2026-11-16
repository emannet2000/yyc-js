import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, booking } from './helpers/app.mjs';

test('SysAdmin endpoints require authentication and broker role', async (t) => {
  const f = await setup(t);
  const anonymous = f.client();
  for (const endpoint of ['/api/sysadmin/overview', '/api/sysadmin/events', '/api/sysadmin/incidents']) {
    assert.equal((await anonymous(endpoint)).status, 401);
    assert.equal((await f.store(endpoint)).status, 403);
    assert.equal((await f.driver(endpoint)).status, 403);
    assert.equal((await f.admin(endpoint)).status, 200);
    assert.equal((await f.admin(endpoint, 'POST', {})).status, endpoint.endsWith('/incidents') ? 405 : 405);
  }
});

test('SysAdmin overview and events report persisted shipment changes', async (t) => {
  const f = await setup(t);
  const before = (await f.admin('/api/sysadmin/overview')).value;
  assert.equal(before.services.sqlite, 'healthy');
  assert.equal(before.database.integrityOk, true);
  assert.equal(before.counts.shipments, 0);
  const created = await f.store('/api/shipments', 'POST', booking());
  assert.equal(created.status, 201);
  const after = (await f.admin('/api/sysadmin/overview')).value;
  assert.equal(after.counts.shipments, 1);
  assert.ok(after.counts.shipmentEvents >= 1);
  const events = (await f.admin('/api/sysadmin/events')).value.events;
  assert.ok(events.some((event) => event.shipmentId === created.value.id));
  const incidents = (await f.admin('/api/sysadmin/incidents')).value;
  assert.ok(Array.isArray(incidents.incidents));
});

test('incident records require admin, validate input, and persist status changes', async (t) => {
  const f = await setup(t);
  const path = '/api/sysadmin/incident-records';
  const payload = { title: 'Tracking delayed', details: 'Investigate stale device updates', severity: 'high' };
  assert.equal((await f.store(path, 'POST', payload)).status, 403);
  assert.equal((await f.admin(path, 'POST', { ...payload, severity: 'invalid' })).status, 400);
  const created = await f.admin(path, 'POST', payload);
  assert.equal(created.status, 201);
  assert.equal(created.value.status, 'open');
  const id = created.value.id;
  assert.ok((await f.admin(path)).value.incidents.some((x) => x.id === id));
  const updated = await f.admin(path + '/' + id + '/status', 'POST', { status: 'acknowledged' });
  assert.equal(updated.status, 200);
  assert.equal(updated.value.status, 'acknowledged');
  assert.equal((await f.admin(path + '/' + id + '/status', 'POST', { status: 'bad' })).status, 400);
  assert.equal((await f.admin(path + '/not-an-incident/status', 'POST', { status: 'resolved' })).status, 405);
  const history = await f.admin(path + '/' + id + '/history');
  assert.equal(history.status, 200);
  assert.deepEqual(history.value.events.map((event) => event.action), ['status:acknowledged','created']);
});

test('data quality and readiness checks do not claim unverified release readiness', async (t) => {
  const f = await setup(t);
  const quality = await f.admin('/api/sysadmin/data-quality');
  assert.equal(quality.status, 200);
  assert.equal(quality.value.healthy, true);
  const readiness = await f.admin('/api/sysadmin/readiness');
  assert.equal(readiness.status, 200);
  assert.equal(readiness.value.ready, false);
  assert.equal(readiness.value.checks.backupVerified, null);
  assert.equal((await f.store('/api/sysadmin/readiness')).status, 403);
});

test('HTTP metrics count requests without exposing user data or request URLs', async (t) => {
  const f = await setup(t);
  await f.store('/api/state');
  await f.store('/api/sysadmin/overview');
  const result = await f.admin('/api/sysadmin/http-metrics');
  assert.equal(result.status, 200);
  assert.ok(result.value.total >= 2);
  assert.ok(result.value.errors4xx >= 1);
  assert.ok(result.value.routes.some((row) => row.route === 'GET /api/state'));
  assert.ok(result.value.routes.every((row) => !row.route.includes('example.com')));
  assert.equal((await f.store('/api/sysadmin/http-metrics')).status, 403);
});

test('operational alerts include unresolved critical incidents and clear after resolution', async (t) => {
  const f = await setup(t);
  const path = '/api/sysadmin/incident-records';
  const created = await f.admin(path, 'POST', {
    title: 'Major outage', severity: 'critical', details: 'Test incident',
  });
  assert.equal(created.status, 201);
  const before = await f.admin('/api/sysadmin/alerts');
  assert.equal(before.status, 200);
  assert.ok(before.value.alerts.some((a) => a.code === 'critical_incident' && a.incidentId === created.value.id));
  assert.equal((await f.store('/api/sysadmin/alerts')).status, 403);
  const resolved = await f.admin(path + '/' + created.value.id + '/status', 'POST', { status: 'resolved' });
  assert.equal(resolved.status, 200);
  const after = await f.admin('/api/sysadmin/alerts');
  assert.ok(!after.value.alerts.some((a) => a.incidentId === created.value.id));
});
