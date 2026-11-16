import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, booking, action } from './helpers/app.mjs';
import { createRoadRouter } from '../server/routing.js';
const find = async (f, id) =>
  (await f.admin('/api/state')).value.shipments.find((s) => s.id === id);
async function assign(f, id) {
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  await action(f.admin, id, 'quote', { price: 450, rate: 300 });
  await action(f.store, id, 'acceptQuote');
  await action(f.admin, id, 'offer', { driverId: f.driverId });
  await action(f.driver, id, 'acceptJob');
}
test('multiple stops require fresh quote acceptance, ordered evidence and all stops before delivery', async (t) => {
  const f = await setup(t),
    id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  await assign(f, id);
  const stops = [
    { kind: 'pickup', address: 'Second warehouse', contact: 'Shipping' },
    { kind: 'dropoff', address: 'First store' },
  ];
  await action(f.driver, id, 'setStops', { stops, reason: 'Extra cargo' }, 403);
  await action(f.admin, id, 'setStops', { stops, reason: 'Extra cargo' });
  let s = await find(f, id);
  assert.equal(s.status, 'Awaiting quote');
  assert.equal(s.driverId, null);
  assert.equal(s.price, null);
  assert.equal(s.quoteArchive.length, 1);
  await action(f.store, id, 'acceptQuote', {}, 403);
  await assign(f, id);
  await action(f.driver, id, 'pickup');
  s = await find(f, id);
  await action(f.driver, id, 'deliver', { pod: 'final', recipient: 'Store' }, 409);
  await action(
    f.driver,
    id,
    'completeStop',
    { stopId: s.stops[1].id, pod: 'early', recipient: 'Staff' },
    409,
  );
  assert.deepEqual(await find(f, id), s);
  for (const stop of s.stops)
    await action(f.driver, id, 'completeStop', {
      stopId: stop.id,
      pod: `receipt-${stop.id}`,
      recipient: 'Staff',
    });
  await action(f.driver, id, 'deliver', { pod: 'final', recipient: 'Store' });
  s = await find(f, id);
  assert.equal(s.status, 'Delivered');
  assert.ok(s.stops.every((stop) => stop.completedAt && stop.pod && stop.recipient));
});
test('driver action retry is idempotent after a lost response and rejects changed payload', async (t) => {
  const f = await setup(t),
    id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  await assign(f, id);
  const s = await find(f, id),
    payload = { action: 'pickup', version: s.version, requestKey: randomUUID() };
  const first = await f.driver(`/api/shipments/${id}/actions`, 'POST', payload);
  assert.equal(first.status, 200);
  const after = await find(f, id);
  assert.deepEqual(
    await f.driver(`/api/shipments/${id}/actions`, 'POST', payload).then((r) => r.value),
    first.value,
  );
  assert.deepEqual(await find(f, id), after);
  assert.equal(
    (
      await f.driver(`/api/shipments/${id}/actions`, 'POST', {
        ...payload,
        action: 'arrival',
      })
    ).status,
    409,
  );
});
test('recipient links are private, expiring, revocable and rotated without exposing account data', async (t) => {
  let now = Date.now();
  const f = await setup(t, { now: () => now }),
    id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  const endpoint = `/api/shipments/${id}/recipient-link`;
  assert.equal((await f.other(endpoint, 'POST', {})).status, 404);
  const issued = await f.store(endpoint, 'POST', {});
  assert.equal(issued.status, 200);
  const token = new URL(issued.value.url).hash.slice(7);
  const guest = f.client();
  const view = await guest('/api/recipient-tracking', 'POST', { token });
  assert.equal(view.status, 200);
  assert.deepEqual(
    Object.keys(view.value).sort(),
    [
      'date',
      'eta',
      'etaUpdatedAt',
      'expiresAt',
      'id',
      'status',
      'stopsCompleted',
      'stopsTotal',
      'window',
    ].sort(),
  );
  assert.equal(view.headers.get('cache-control'), 'no-store');
  const second = await f.store(endpoint, 'POST', {});
  assert.equal((await guest('/api/recipient-tracking', 'POST', { token })).status, 404);
  const secondToken = new URL(second.value.url).hash.slice(7);
  now += 7 * 86400000 + 1;
  assert.equal(
    (await guest('/api/recipient-tracking', 'POST', { token: secondToken })).status,
    404,
  );
});
test('routing uses recent driver GPS, computes next-stop ETA and clears it on progress', async (t) => {
  const calls = [],
    time = Date.now();
  const f = await setup(t, {
    now: () => time,
    calculateRoute: async (points) => {
      calls.push(points);
      return {
        durationSeconds: 1200,
        distanceMeters: 10000,
        legs: points.slice(1).map(() => ({ durationSeconds: 600, distanceMeters: 5000 })),
      };
    },
  });
  const id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  await assign(f, id);
  await f.driver(`/api/shipments/${id}/tracking`, 'POST', {
    latitude: 51,
    longitude: -114,
    accuracy: 10,
  });
  const result = await f.driver(`/api/shipments/${id}/route`, 'POST', {});
  assert.equal(result.status, 200);
  assert.equal(result.value.source, 'driver-location');
  assert.equal(result.value.eta, new Date(time + 600000).toISOString());
  assert.equal(calls[0][0].latitude, 51);
  assert.equal(calls[0][1].address, booking().pickup);
  assert.equal((await f.store(`/api/shipments/${id}/route`, 'POST', {})).status, 403);
  await action(f.driver, id, 'pickup');
  assert.equal((await f.driver(`/api/shipments/${id}/route`)).value, null);
  const tstate = (await f.driver(`/api/shipments/${id}/tracking`)).value;
  assert.equal(tstate.eta, undefined);
  assert.equal(
    (
      await f.driver(`/api/shipments/${id}/tracking`, 'POST', {
        latitude: 51,
        longitude: -114,
        accuracy: 10,
        recordedAt: new Date(time - 3600000).toISOString(),
      })
    ).status,
    400,
  );
});
test('route requests fail clearly without configuration and concurrent shipment changes invalidate results', async (t) => {
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const f = await setup(t, {
    calculateRoute: async () => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  const pending = f.admin(`/api/shipments/${id}/route`, 'POST', {});
  await started;
  assert.equal((await f.admin(`/api/shipments/${id}/route`, 'POST', {})).status, 429);
  await action(f.admin, id, 'cancel');
  release({
    distanceMeters: 100,
    durationSeconds: 60,
    legs: [{ distanceMeters: 100, durationSeconds: 60 }],
  });
  assert.equal((await pending).status, 409);
  assert.equal((await f.admin(`/api/shipments/${id}/route`)).value, null);
});
test('road adapter uses configured geocoding and OSRM provider with bounded requests', async () => {
  const calls = [];
  const router = createRoadRouter(
    {
      ROUTING_URL: 'https://routing.example',
      GEOCODING_URL: 'https://geo.example/search',
    },
    async (url, options) => {
      calls.push({ url: new URL(url), options });
      return {
        ok: true,
        json: async () =>
          String(url).includes('/search')
            ? [{ lat: '51', lon: '-114' }]
            : {
                code: 'Ok',
                routes: [
                  {
                    distance: 1000,
                    duration: 100,
                    legs: [{ distance: 1000, duration: 100 }],
                    geometry: {
                      type: 'LineString',
                      coordinates: [
                        [-114, 51],
                        [-113, 52],
                      ],
                    },
                  },
                ],
              },
      };
    },
  );
  const route = await router([
    { address: 'Warehouse' },
    { latitude: 52, longitude: -113 },
  ]);
  assert.equal(route.durationSeconds, 100);
  assert.equal(calls[0].url.searchParams.get('q'), 'Warehouse');
  assert.match(calls[1].url.pathname, /route\/v1\/driving\/-114,51;-113,52/);
  assert.ok(
    calls.every((call) => call.options.redirect === 'error' && call.options.signal),
  );
  assert.equal(createRoadRouter({}), null);
  assert.throws(
    () =>
      createRoadRouter({
        ROUTING_URL: 'http://unsafe',
        GEOCODING_URL: 'https://geo.example',
      }),
    /HTTPS/,
  );
});

test('offline evidence retries preserve exactly one attachment and audit event', async (t) => {
  const f = await setup(t),
    id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  await assign(f, id);
  const s = await find(f, id);
  const payload = {
    version: s.version,
    requestKey: randomUUID(),
    name: 'proof.png',
    mime: 'image/png',
    content: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString('base64'),
  };
  const endpoint = `/api/shipments/${id}/evidence`;
  assert.equal((await f.driver(endpoint, 'POST', payload)).status, 201);
  assert.equal((await f.driver(endpoint, 'POST', payload)).status, 201);
  assert.equal((await f.driver(endpoint)).value.length, 1);
  assert.equal(
    (await find(f, id)).history.filter((e) => e.text === 'Evidence attached: proof.png')
      .length,
    1,
  );
  assert.equal(
    (await f.driver(endpoint, 'POST', { ...payload, name: 'other.png' })).status,
    409,
  );
});
