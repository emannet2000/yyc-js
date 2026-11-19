import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeocoder } from '../server/geocoder.js';

const json = (body, ok = true) => ({ ok, json: async () => body });

test('no geocoder is returned when no service is configured', () => {
  assert.equal(
    createGeocoder({}, async () => json({})),
    null,
  );
});

test('OpenRouteService answers are read as longitude then latitude', async () => {
  const calls = [];
  const geocode = createGeocoder({ ORS_API_KEY: 'key-123' }, async (url, options) => {
    calls.push({ url: String(url), auth: options.headers.Authorization });
    return json({ features: [{ geometry: { coordinates: [-114.0719, 51.0447] } }] });
  });
  const point = await geocode('12 Industrial Rd, Calgary');
  assert.deepEqual(point, { latitude: 51.0447, longitude: -114.0719 });
  assert.match(calls[0].url, /geocode\/search\?text=12\+Industrial/);
  assert.equal(calls[0].auth, 'key-123');
});

test('Nominatim-style answers are read from lat and lon strings', async () => {
  const geocode = createGeocoder(
    { GEOCODING_URL: 'https://geo.example.com/search' },
    async () => json([{ lat: '51.0447', lon: '-114.0719' }]),
  );
  assert.deepEqual(await geocode('88 Main St'), {
    latitude: 51.0447,
    longitude: -114.0719,
  });
});

test('an address with no match returns null rather than a guess', async () => {
  const geocode = createGeocoder({ ORS_API_KEY: 'k' }, async () =>
    json({ features: [] }),
  );
  assert.equal(await geocode('nowhere at all'), null);
});

test('provider errors are raised so the caller can skip the address', async () => {
  const geocode = createGeocoder({ ORS_API_KEY: 'k' }, async () => json({}, false));
  await assert.rejects(geocode('anything'), /Geocoding unavailable/);
});

test('repeated lookups of the same address are served from the cache', async () => {
  let calls = 0;
  const geocode = createGeocoder({ ORS_API_KEY: 'k' }, async () => {
    calls++;
    return json({ features: [{ geometry: { coordinates: [-114, 51] } }] });
  });
  await geocode('Same Address');
  await geocode('same address ');
  assert.equal(calls, 1);
});

test('insecure geocoding endpoints are refused', () => {
  assert.throws(
    () =>
      createGeocoder({ GEOCODING_URL: 'http://geo.example.com/search' }, async () =>
        json([]),
      ),
    /HTTPS/,
  );
});
