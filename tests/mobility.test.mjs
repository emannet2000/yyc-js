import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, booking, action, attachDeliveryEvidence } from './helpers/app.mjs';
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
  const original = await find(f, id);
  await action(f.admin, id, 'setStops', { stops: [], reason: 'No changes' }, 400);
  assert.deepEqual(await find(f, id), original);
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
  const withStops = await find(f, id);
  await action(f.admin, id, 'setStops', { stops, reason: 'Same route' }, 400);
  assert.deepEqual(await find(f, id), withStops);
  await action(f.driver, id, 'pickup');
  await attachDeliveryEvidence(f.driver, id);
  s = await find(f, id);
  await action(f.driver, id, 'arrival', {}, 409);
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
  await action(f.driver, id, 'arrival');
  assert.equal((await find(f, id)).evidenceCount, 0);
  await action(f.driver, id, 'deliver', { pod: 'final', recipient: 'Store' }, 409);
  await action(f.driver, id, 'deliver', { pod: 'final', recipient: 'Store' });
  s = await find(f, id);
  assert.equal(s.status, 'Delivered');
  assert.ok(s.stops.every((stop) => stop.completedAt && stop.pod && stop.recipient));
});
test('driver action retry is idempotent after a lost response and rejects changed payload', async (t) => {
  const f = await setup(t),
    id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  await assign(f, id);
  await action(f.driver, id, 'arrival');
  const s = await find(f, id),
    payload = { action: 'pickup', version: s.version, requestKey: randomUUID() };
  const first = await f.driver(`/api/shipments/${id}/actions`, 'POST', payload);
  assert.equal(first.status, 200);
  assert.equal(
    (
      await f.driver(`/api/shipments/${id}/actions`, 'POST', {
        ...payload,
        queuedAt: new Date().toISOString(),
      })
    ).status,
    200,
  );
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
      'aiMessage',
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
  assert.equal(tstate.eta, null);
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

test('return routing waits for a recent driver location and uses it as the origin', async (t) => {
  const calls = [];
  let now = Date.now();
  const f = await setup(t, {
    now: () => now,
    calculateRoute: async (points) => {
      calls.push(points);
      return {
        durationSeconds: 600,
        distanceMeters: 5000,
        legs: [{ durationSeconds: 600, distanceMeters: 5000 }],
      };
    },
  });
  const { id } = (await f.store('/api/shipments', 'POST', booking())).value;
  await assign(f, id);
  await action(f.driver, id, 'pickup');
  await action(f.admin, id, 'return', { reason: 'Recover the cargo' });
  const path = `/api/shipments/${id}/route`;
  const unavailable = await f.driver(path, 'POST', {});
  assert.equal(unavailable.status, 409);
  assert.match(unavailable.value.error, /recent driver location/);
  assert.equal(calls.length, 0);
  const position = { latitude: 51, longitude: -114, accuracy: 10 };
  assert.equal(
    (await f.driver(`/api/shipments/${id}/tracking`, 'POST', position)).status,
    200,
  );
  const routed = await f.driver(path, 'POST', {});
  assert.equal(routed.status, 200);
  assert.equal(routed.value.distanceMeters, 5000);
  assert.deepEqual(calls.at(-1), [
    { latitude: position.latitude, longitude: position.longitude },
    { id: 'return', kind: 'dropoff', address: booking().pickup },
  ]);
  now += 5 * 60000;
  assert.equal((await f.driver(path, 'POST', {})).status, 409);
});

test('quote history preserves the ordered itinerary accepted before a stop revision', async (t) => {
  const f = await setup(t);
  const { id } = (await f.store('/api/shipments', 'POST', booking())).value;
  const stops = [
    { kind: 'dropoff', address: 'Original drop-off', contact: 'Receiving' },
    { kind: 'pickup', address: 'Original collection', contact: '' },
  ];
  await action(f.store, id, 'setStops', { stops, reason: 'Add two stops' });
  await assign(f, id);
  const accepted = await find(f, id);
  await action(f.admin, id, 'setStops', {
    stops: [{ kind: 'dropoff', address: 'Replacement drop-off' }],
    reason: 'Change itinerary',
  });
  const revision = await find(f, id);
  assert.equal(revision.stops[0].address, 'Replacement drop-off');
  const archived = revision.quoteArchive.find(
    (quote) => quote.version === accepted.quoteVersion,
  );
  assert.equal(archived.pickup, accepted.pickup);
  assert.equal(archived.destination, accepted.destination);
  assert.deepEqual(archived.stops, stops);
  const owner = (await f.store('/api/state')).value.shipments[0];
  assert.deepEqual(owner.quoteArchive.at(-1).stops, stops);
  assert.equal(owner.quoteArchive.at(-1).rate, undefined);
});

test('tracking views keep manual estimates through distance-only routing and expire them together', async (t) => {
  let now = Date.now();
  const f = await setup(t, {
    now: () => now,
    calculateRoute: async (points) => ({
      distanceMeters: 1000,
      durationSeconds: 600,
      legs: points.slice(1).map(() => ({ distanceMeters: 1000, durationSeconds: 600 })),
    }),
  });
  const { id } = (await f.store('/api/shipments', 'POST', booking())).value;
  await assign(f, id);
  const tracking = `/api/shipments/${id}/tracking`;
  const route = `/api/shipments/${id}/route`;
  const eta = new Date(now + 60000).toISOString();
  assert.equal((await f.admin(tracking, 'PATCH', { eta })).status, 200);
  const planned = await f.admin(route, 'POST', {});
  assert.equal(planned.value.source, 'planned-addresses');
  assert.equal(planned.value.eta, eta);
  const link = (await f.store(`/api/shipments/${id}/recipient-link`, 'POST', {})).value
    .url;
  const token = new URL(link).hash.slice(7);
  const recipient = () => f.client()('/api/recipient-tracking', 'POST', { token });
  assert.equal((await recipient()).value.eta, eta);
  assert.equal((await f.store(tracking)).value.eta, eta);
  await action(f.store, id, 'requestChange', {
    kind: 'cancellation',
    details: 'Please check whether cancellation is still possible',
  });
  const pending = (await find(f, id)).customerRequests.at(-1);
  await action(f.admin, id, 'respondRequest', {
    requestId: pending.id,
    decision: 'decline',
    response: 'The current delivery plan remains in effect',
  });
  assert.equal((await recipient()).value.eta, eta);
  assert.equal((await f.store(route)).value.distanceMeters, 1000);
  now += 60001;
  assert.equal((await recipient()).value.eta, null);
  assert.equal((await f.store(tracking)).value.eta, null);
  assert.equal((await f.store(route)).value.eta, null);
  assert.equal(
    (await f.driver(tracking, 'POST', { latitude: 51, longitude: -114, accuracy: 10 }))
      .status,
    200,
  );
  const automatic = (await f.store(tracking)).value;
  assert.equal(automatic.etaSource, 'road-route');
  const override = new Date(now + 120000).toISOString();
  await f.admin(tracking, 'PATCH', { eta: override });
  assert.equal((await recipient()).value.eta, override);
  await f.admin(tracking, 'PATCH', { eta: '' });
  assert.equal((await recipient()).value.eta, automatic.eta);
});

test('recording final arrival retires the ETA from participant and recipient views', async (t) => {
  const f = await setup(t);
  const { id } = (await f.store('/api/shipments', 'POST', booking())).value;
  await assign(f, id);
  await action(f.driver, id, 'pickup');
  const path = `/api/shipments/${id}/tracking`;
  const eta = new Date(Date.now() + 3600000).toISOString();
  assert.equal((await f.admin(path, 'PATCH', { eta })).status, 200);
  const { url } = (await f.store(`/api/shipments/${id}/recipient-link`, 'POST', {}))
    .value;
  const token = new URL(url).hash.slice(7);
  const recipient = () => f.client()('/api/recipient-tracking', 'POST', { token });
  assert.equal((await recipient()).value.eta, eta);
  await action(f.driver, id, 'arrival');
  const tracking = (await f.store(path)).value;
  assert.equal(tracking.eta, null);
  assert.equal(tracking.etaUpdatedAt, null);
  const published = (await recipient()).value;
  assert.equal(published.eta, null);
  assert.equal(published.arrived, true);
  assert.equal((await f.admin(path, 'PATCH', { eta })).status, 409);
});
