// OSRM-compatible road routing with a Nominatim-compatible address lookup.
// No requests are made until an authenticated user calculates a route.
export function createRoadRouter(env = process.env, request = fetch) {
  if (env.ORS_API_KEY) return createOpenRouteService(env, request);
  const routing = env.ROUTING_URL;
  const geocoding = env.GEOCODING_URL;
  if (!routing || !geocoding) return null;
  for (const endpoint of [routing, geocoding]) {
    if (new URL(endpoint).protocol !== 'https:')
      throw new Error('Routing endpoints require HTTPS.');
  }
  const headers = {
    'User-Agent': 'YYC-Delivery/1.0',
    ...(env.ROUTING_TOKEN ? { Authorization: `Bearer ${env.ROUTING_TOKEN}` } : {}),
  };
  async function json(url) {
    const response = await request(url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Routing provider unavailable.');
    return response.json();
  }
  return async (points) => {
    const coordinates = [];
    // Sequential lookup avoids bursts against address services.
    for (const point of points) {
      if (Number.isFinite(point.latitude) && Number.isFinite(point.longitude)) {
        coordinates.push([point.longitude, point.latitude]);
      } else {
        const url = new URL(geocoding);
        url.searchParams.set('q', point.address);
        url.searchParams.set('format', 'json');
        url.searchParams.set('limit', '1');
        const matches = await json(url);
        const lat = Number(matches[0]?.lat),
          lon = Number(matches[0]?.lon);
        if (
          !Number.isFinite(lat) ||
          !Number.isFinite(lon) ||
          Math.abs(lat) > 90 ||
          Math.abs(lon) > 180
        )
          throw new Error(`Address could not be located: ${point.address}`);
        coordinates.push([lon, lat]);
      }
    }
    const url = new URL(
      `${routing.replace(/\/$/, '')}/route/v1/driving/${coordinates.map((p) => p.join(',')).join(';')}`,
    );
    url.searchParams.set('overview', 'simplified');
    url.searchParams.set('geometries', 'geojson');
    const result = await json(url);
    if (result.code !== 'Ok' || !result.routes?.length)
      throw new Error('No road route was found.');
    const route = result.routes[0];
    return {
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      legs: route.legs.map((leg) => ({
        distanceMeters: leg.distance,
        durationSeconds: leg.duration,
      })),
      coordinates,
      geometry: route.geometry,
    };
  };
}

// Hosted provider: one server-side credential enables both address lookup and truck routing.
function createOpenRouteService(env, request) {
  const origin = new URL(env.ORS_BASE_URL || 'https://api.openrouteservice.org');
  if (origin.protocol !== 'https:' || origin.username || origin.password)
    throw new Error('ORS_BASE_URL requires HTTPS without URL credentials.');
  const profile = env.ORS_PROFILE || 'driving-hgv';
  if (!['driving-car', 'driving-hgv'].includes(profile))
    throw new Error('ORS_PROFILE must be driving-car or driving-hgv.');
  const cache = new Map(),
    pending = new Map();
  async function json(path, body) {
    const response = await request(new URL(path, origin), {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: env.ORS_API_KEY,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Road provider unavailable or quota exhausted.');
    return response.json();
  }
  async function geocode(address) {
    const key = address.trim().toLowerCase(),
      cached = cache.get(key);
    if (cached && cached.until > Date.now()) return cached.point;
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      const value = await json(
        `/geocode/search?${new URLSearchParams({ text: address, size: '1' })}`,
      );
      const point = value.features?.[0]?.geometry?.coordinates;
      if (
        !Array.isArray(point) ||
        point.length !== 2 ||
        !point.every(Number.isFinite) ||
        Math.abs(point[0]) > 180 ||
        Math.abs(point[1]) > 90
      )
        throw new Error('Address could not be located.');
      if (cache.size >= 1000) cache.delete(cache.keys().next().value);
      cache.set(key, { point, until: Date.now() + 86400000 });
      return point;
    })();
    pending.set(key, work);
    try {
      return await work;
    } finally {
      pending.delete(key);
    }
  }
  return async (points) => {
    const coordinates = [];
    for (const point of points) {
      if (
        Number.isFinite(point.latitude) &&
        Number.isFinite(point.longitude) &&
        Math.abs(point.latitude) <= 90 &&
        Math.abs(point.longitude) <= 180
      )
        coordinates.push([point.longitude, point.latitude]);
      else coordinates.push(await geocode(point.address));
    }
    const value = await json(`/v2/directions/${profile}/geojson`, {
      coordinates,
      instructions: false,
    });
    const route = value.features?.[0];
    if (!route?.properties?.summary || !Array.isArray(route.properties.segments))
      throw new Error('No road route was found.');
    return {
      distanceMeters: route.properties.summary.distance,
      durationSeconds: route.properties.summary.duration,
      legs: route.properties.segments.map((leg) => ({
        distanceMeters: leg.distance,
        durationSeconds: leg.duration,
      })),
      coordinates,
      geometry: route.geometry,
      provider: 'openrouteservice',
      profile,
    };
  };
}
