import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, start, login, booking, action } from './helpers/app.mjs';

async function assign(f, extra = {}) {
  const id = (await f.store('/api/shipments', 'POST', { ...booking(), ...extra })).value
    .id;
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  await action(f.admin, id, 'quote', { price: 450, rate: 300 });
  await action(f.store, id, 'acceptQuote');
  await action(f.admin, id, 'offer', { driverId: f.driverId });
  await action(f.driver, id, 'acceptJob');
  return id;
}
test('delivery alert acknowledgment survives a server restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'yyc-alert-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let time = Date.now();
  const options = { databasePath: join(directory, 'pilot.sqlite'), now: () => time };
  const f = await setup(t, options);
  await assign(f);
  time += 6 * 60000;
  const alert = (await f.admin('/api/broker-alerts')).value.alerts.find(
    (item) => item.kind === 'missing_gps',
  );
  await f.admin(`/api/broker-alerts/${alert.id}/acknowledge`, 'POST', {});
  await f.stop();
  const restarted = await start(t, options);
  const admin = restarted.client();
  await login(admin, 'admin@example.com');
  assert.ok(
    (await admin('/api/broker-alerts')).value.alerts.find((item) => item.id === alert.id)
      .acknowledgedAt,
  );
  await restarted.stop();
});
test('broker alert acknowledgments persist and new stale GPS evidence requires acknowledgment again', async (t) => {
  let time = Date.now();
  const f = await setup(t, { now: () => time });
  const id = await assign(f);
  const path = '/api/broker-alerts';
  assert.equal((await f.store(path)).status, 403);
  assert.equal((await f.driver(path)).status, 403);
  time += 6 * 60000;
  const missing = (await f.admin(path)).value.alerts.find(
    (a) => a.kind === 'missing_gps',
  );
  assert.ok(missing);
  assert.equal(
    (await f.store(`${path}/${missing.id}/acknowledge`, 'POST', {})).status,
    403,
  );
  assert.equal(
    (
      await f.admin(
        `${path}/${missing.id}/acknowledge`,
        'POST',
        {},
        { 'X-CSRF-Token': '' },
      )
    ).status,
    403,
  );
  assert.equal(
    (await f.admin(`${path}/${missing.id}/acknowledge`, 'POST', {})).status,
    200,
  );
  assert.ok(
    (await f.admin(path)).value.alerts.find((a) => a.id === missing.id).acknowledgedAt,
  );
  await f.driver(`/api/shipments/${id}/tracking`, 'POST', {
    latitude: 51,
    longitude: -114,
    accuracy: 10,
  });
  assert.ok(!(await f.admin(path)).value.alerts.some((a) => a.kind === 'missing_gps'));
  time += 6 * 60000;
  const stale = (await f.admin(path)).value.alerts.find((a) => a.kind === 'stale_gps');
  assert.ok(stale);
  assert.equal(stale.acknowledgedAt, null);
  await action(f.driver, id, 'issue', {
    reason: 'Vehicle issue',
    note: 'Waiting for assistance',
  });
  assert.ok((await f.admin(path)).value.alerts.some((a) => a.kind === 'open_issue'));
});
test('store receives pickup, deduplicated approaching notification and completion while other stores receive none', async (t) => {
  let time = Date.now();
  const f = await setup(t, { now: () => time });
  const id = await assign(f);
  await action(f.driver, id, 'pickup');
  await f.driver(`/api/shipments/${id}/tracking`, 'POST', {
    latitude: 51,
    longitude: -114,
    accuracy: 10,
  });
  await f.driver(`/api/shipments/${id}/tracking`, 'PATCH', {
    eta: new Date(time + 10 * 60000).toISOString(),
  });
  await f.app.processNotifications();
  await f.app.processNotifications();
  let notes = (await f.store('/api/notifications')).value;
  assert.ok(notes.some((n) => n.message.includes('Pickup confirmed')));
  assert.equal(
    notes.filter((n) => n.message.includes('Driver is approaching')).length,
    1,
  );
  assert.deepEqual((await f.other('/api/notifications')).value, []);
  time += 11 * 60000;
  assert.ok(
    (await f.admin('/api/broker-alerts')).value.alerts.some(
      (alert) => alert.kind === 'overdue_arrival',
    ),
  );
  await f.app.processNotifications();
  await f.app.processNotifications();
  assert.equal(
    (await f.store('/api/notifications')).value.filter((note) =>
      note.message.includes('Delivery is delayed'),
    ).length,
    1,
  );
  await action(f.driver, id, 'deliver', { pod: 'POD', recipient: 'Store receiver' });
  await f.app.processNotifications();
  notes = (await f.store('/api/notifications')).value;
  assert.ok(notes.some((n) => n.message.includes('Delivery confirmed')));
  assert.equal(
    notes.filter((n) => n.message.includes('Driver is approaching')).length,
    1,
  );
});
test('road ETA includes configured stop service and final unloading without changing next-stop arrival', async (t) => {
  const time = Date.now();
  const f = await setup(t, {
    now: () => time,
    calculateRoute: async (points) => ({
      durationSeconds: 1200,
      distanceMeters: 10000,
      legs: points.slice(1).map(() => ({ durationSeconds: 600, distanceMeters: 5000 })),
    }),
  });
  const id = await assign(f, { travelBufferMinutes: 5 });
  await f.driver(`/api/shipments/${id}/tracking`, 'POST', {
    latitude: 51,
    longitude: -114,
    accuracy: 10,
  });
  const route = await f.admin(`/api/shipments/${id}/route`, 'POST', {
    stopServiceMinutes: 10,
    unloadingMinutes: 20,
  });
  assert.equal(route.status, 200);
  assert.equal(route.value.eta, new Date(time + 10 * 60000).toISOString());
  assert.equal(route.value.destinationEta, new Date(time + 30 * 60000).toISOString());
  assert.equal(route.value.completionEta, new Date(time + 50 * 60000).toISOString());
  assert.equal(route.value.etaBreakdown.stopServiceSeconds, 600);
  assert.equal(
    (await f.admin(`/api/shipments/${id}/route`, 'POST', { unloadingMinutes: -1 }))
      .status,
    400,
  );
  await action(f.driver, id, 'pickup');
  const point = (await f.store(`/api/shipments/${id}/tracking`)).value;
  assert.equal(point.completionEta, undefined);
  assert.equal(point.etaTiming.unloadingMinutes, 20);
});
