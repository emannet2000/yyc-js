import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, booking, action } from './helpers/app.mjs';

async function assigned(t) {
  const f = await setup(t);
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  const id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  await action(f.admin, id, 'quote', { price: 450, rate: 300 });
  await action(f.store, id, 'acceptQuote');
  await action(f.admin, id, 'offer', { driverId: f.driverId });
  await action(f.driver, id, 'acceptJob');
  return { ...f, id };
}

const sample = (recordedAt, latitude = 51.0 + Math.random() / 100) => ({
  latitude,
  longitude: -114.07,
  accuracy: 12,
  recordedAt,
});

test('accepted samples are kept in order and visible to the broker and store', async (t) => {
  const f = await assigned(t);
  const base = Date.now() - 4 * 60000;
  for (let i = 0; i < 3; i++) {
    const res = await f.driver(`/api/shipments/${f.id}/tracking`, 'POST', {
      ...sample(new Date(base + i * 1000).toISOString(), 51 + i / 100),
    });
    assert.equal(res.status, 200);
  }
  for (const client of [f.admin, f.store]) {
    const h = (await client(`/api/shipments/${f.id}/tracking/history`)).value;
    assert.equal(h.driverId, f.driverId);
    assert.equal(h.points.length, 3);
    assert.deepEqual(
      h.points.map((p) => p.latitude),
      [51, 51.01, 51.02],
    );
    assert.ok(h.points.every((p) => typeof p.recordedAt === 'string'));
  }
});

test('rejected samples are not stored in history', async (t) => {
  const f = await assigned(t);
  const bad = await f.driver(`/api/shipments/${f.id}/tracking`, 'POST', {
    latitude: 200,
    longitude: -114,
    accuracy: 5,
    recordedAt: new Date().toISOString(),
  });
  assert.equal(bad.status, 400);
  const stale = await f.driver(`/api/shipments/${f.id}/tracking`, 'POST', {
    ...sample(new Date(Date.now() - 20 * 60000).toISOString()),
  });
  assert.equal(stale.status, 400);
  const h = (await f.admin(`/api/shipments/${f.id}/tracking/history`)).value;
  assert.deepEqual(h.points, []);
});

test('history read returns the newest 200 points oldest first', async (t) => {
  const f = await assigned(t);
  const base = Date.now() - 4 * 60000;
  const total = 205;
  for (let i = 0; i < total; i++) {
    const res = await f.driver(`/api/shipments/${f.id}/tracking`, 'POST', {
      ...sample(new Date(base + i * 500).toISOString(), 51 + i / 10000),
    });
    assert.equal(res.status, 200, `sample ${i}`);
  }
  const { points } = (await f.admin(`/api/shipments/${f.id}/tracking/history`)).value;
  assert.equal(points.length, 200);
  assert.equal(points[199].latitude, 51 + (total - 1) / 10000);
  assert.equal(points[0].latitude, 51 + (total - 200) / 10000);
});

test('history is limited to the signed-in roles that can view the delivery', async (t) => {
  const f = await assigned(t);
  const url = `/api/shipments/${f.id}/tracking/history`;
  assert.equal((await f.driver(url)).status, 200);
  const outsider = f.client();
  const res = await outsider(url);
  assert.equal(res.status, 401);
});

test('retention deletes location samples older than the keep period', async (t) => {
  const f = await assigned(t);
  await f.driver(`/api/shipments/${f.id}/tracking`, 'POST', {
    ...sample(new Date(Date.now() - 2 * 60000).toISOString()),
  });
  assert.equal(
    (await f.admin(`/api/shipments/${f.id}/tracking/history`)).value.points.length,
    1,
  );
  f.app.pruneTrackingHistory(90);
  assert.equal(
    (await f.admin(`/api/shipments/${f.id}/tracking/history`)).value.points.length,
    1,
    'recent samples are kept',
  );
  f.app.pruneTrackingHistory(0);
  assert.deepEqual(
    (await f.admin(`/api/shipments/${f.id}/tracking/history`)).value.points,
    [],
  );
});
