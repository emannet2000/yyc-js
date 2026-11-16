import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoadRouter } from '../server/routing.js';
const routed = {
  features: [
    {
      geometry: {
        type: 'LineString',
        coordinates: [
          [-114, 51],
          [-113, 52],
        ],
      },
      properties: {
        summary: { distance: 1200, duration: 600 },
        segments: [{ distance: 1200, duration: 600 }],
      },
    },
  ],
};
test('ORS key configures hosted geocoding and HGV routing with server-side authentication', async () => {
  const calls = [];
  const router = createRoadRouter(
    { ORS_API_KEY: 'test-private-key' },
    async (url, options) => {
      calls.push({ url: new URL(url), options });
      return {
        ok: true,
        json: async () =>
          String(url).includes('/geocode')
            ? { features: [{ geometry: { coordinates: [-114, 51] } }] }
            : routed,
      };
    },
  );
  const points = [{ address: 'Calgary warehouse' }, { latitude: 52, longitude: -113 }];
  const result = await router(points);
  assert.equal(result.provider, 'openrouteservice');
  assert.equal(result.durationSeconds, 600);
  assert.equal(calls[0].url.origin, 'https://api.openrouteservice.org');
  assert.equal(calls[0].url.searchParams.get('text'), 'Calgary warehouse');
  assert.equal(calls[0].url.searchParams.has('api_key'), false);
  assert.equal(calls[0].options.headers.Authorization, 'test-private-key');
  assert.equal(calls[1].url.pathname, '/v2/directions/driving-hgv/geojson');
  assert.deepEqual(JSON.parse(calls[1].options.body).coordinates, [
    [-114, 51],
    [-113, 52],
  ]);
  assert.equal(calls[1].options.redirect, 'error');
  await router(points);
  assert.equal(calls.filter((call) => call.url.pathname === '/geocode/search').length, 1);
});
test('ORS geocoding merges concurrent lookups and rejects provider failures or malformed coordinates', async () => {
  let lookups = 0;
  const router = createRoadRouter(
    { ORS_API_KEY: 'key', ORS_PROFILE: 'driving-car' },
    async (url) => {
      if (String(url).includes('/geocode')) {
        lookups++;
        await new Promise((resolve) => setImmediate(resolve));
        return {
          ok: true,
          json: async () => ({ features: [{ geometry: { coordinates: [-114, 51] } }] }),
        };
      }
      return { ok: true, json: async () => routed };
    },
  );
  await Promise.all([
    router([{ address: 'Same address' }, { latitude: 51, longitude: -114 }]),
    router([{ address: 'Same address' }, { latitude: 52, longitude: -113 }]),
  ]);
  assert.equal(lookups, 1);
  const bad = createRoadRouter({ ORS_API_KEY: 'key' }, async () => ({
    ok: true,
    json: async () => ({ features: [{ geometry: { coordinates: [999, 999] } }] }),
  }));
  await assert.rejects(
    bad([{ address: 'Missing' }, { latitude: 51, longitude: -114 }]),
    /located/,
  );
  const failed = createRoadRouter({ ORS_API_KEY: 'key' }, async () => ({ ok: false }));
  await assert.rejects(
    failed([{ address: 'Unknown' }, { latitude: 51, longitude: -114 }]),
    /unavailable/,
  );
  assert.throws(
    () => createRoadRouter({ ORS_API_KEY: 'key', ORS_BASE_URL: 'http://unsafe' }),
    /HTTPS/,
  );
  assert.throws(
    () => createRoadRouter({ ORS_API_KEY: 'key', ORS_PROFILE: 'flight' }),
    /ORS_PROFILE/,
  );
});
