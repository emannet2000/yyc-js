export interface RoadMapRoute {
  geometry?: { type?: string; coordinates?: number[][] };
  distanceMeters?: number;
  durationSeconds?: number;
  shipmentVersion?: number;
  calculatedAt?: string;
}

export function roadLine(route?: RoadMapRoute, version?: number): [number, number][] {
  if (
    !route ||
    (version !== undefined && route.shipmentVersion !== version) ||
    route.geometry?.type !== 'LineString' ||
    !Array.isArray(route.geometry.coordinates) ||
    route.geometry.coordinates.length < 2 ||
    route.geometry.coordinates.length > 20000
  )
    return [];
  if (
    !route.geometry.coordinates.every(
      (point) =>
        Array.isArray(point) &&
        point.length >= 2 &&
        Number.isFinite(point[0]) &&
        Math.abs(point[0]) <= 180 &&
        Number.isFinite(point[1]) &&
        Math.abs(point[1]) <= 90,
    )
  )
    return [];
  return route.geometry.coordinates.map(([longitude, latitude]) => [latitude, longitude]);
}
