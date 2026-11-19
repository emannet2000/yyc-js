// Turns a delivery address into coordinates. Uses the same operator settings as
// road routing: OpenRouteService (ORS_API_KEY), or a Nominatim-compatible
// service (GEOCODING_URL). Returns null when neither is configured.
const TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 1000;

function validPoint(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}

function withCache(lookup) {
  const cache = new Map();
  return async (address) => {
    const key = address.trim().toLowerCase();
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return hit.point;
    const point = await lookup(address);
    if (point) {
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
      cache.set(key, { point, until: Date.now() + TTL_MS });
    }
    return point;
  };
}

export function createGeocoder(env = process.env, request = fetch) {
  const headers = (extra = {}) => ({ 'User-Agent': 'YYC-Delivery/1.0', ...extra });
  if (env.ORS_API_KEY) {
    const origin = new URL(env.ORS_BASE_URL || 'https://api.openrouteservice.org');
    if (origin.protocol !== 'https:') throw new Error('ORS_BASE_URL requires HTTPS.');
    return withCache(async (address) => {
      const url = new URL('/geocode/search', origin);
      url.searchParams.set('text', address);
      url.searchParams.set('size', '1');
      const response = await request(url, {
        headers: headers({ Authorization: env.ORS_API_KEY }),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('Geocoding unavailable.');
      const coordinates = (await response.json()).features?.[0]?.geometry?.coordinates;
      if (!Array.isArray(coordinates)) return null;
      const [longitude, latitude] = coordinates;
      return validPoint(latitude, longitude) ? { latitude, longitude } : null;
    });
  }
  if (env.GEOCODING_URL) {
    const endpoint = new URL(env.GEOCODING_URL);
    if (endpoint.protocol !== 'https:') throw new Error('GEOCODING_URL requires HTTPS.');
    return withCache(async (address) => {
      const url = new URL(endpoint);
      url.searchParams.set('q', address);
      url.searchParams.set('format', 'json');
      url.searchParams.set('limit', '1');
      const response = await request(url, {
        headers: headers(
          env.ROUTING_TOKEN ? { Authorization: `Bearer ${env.ROUTING_TOKEN}` } : {},
        ),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('Geocoding unavailable.');
      const [first] = await response.json();
      if (!first) return null;
      const latitude = Number(first.lat);
      const longitude = Number(first.lon);
      return validPoint(latitude, longitude) ? { latitude, longitude } : null;
    });
  }
  return null;
}
