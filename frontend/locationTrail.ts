// Recent driver positions for drawing a route trail. Pure so it can be tested.
export type TrailPoint = [number, number];

export const TRAIL_MAX_POINTS = 60;

// Adds a point unless it repeats the last one, and keeps only the newest `max`.
export function appendTrailPoint(
  trail: TrailPoint[],
  point: TrailPoint,
  max = TRAIL_MAX_POINTS,
): TrailPoint[] {
  const last = trail[trail.length - 1];
  if (last && last[0] === point[0] && last[1] === point[1]) return trail;
  const next = [...trail, point];
  return next.length > max ? next.slice(next.length - max) : next;
}

// Converts stored history samples into trail points, dropping repeats and
// keeping the newest `max` points. Input is ordered oldest first.
export function trailFromHistory(
  samples: { latitude: number; longitude: number }[],
  max = TRAIL_MAX_POINTS,
): TrailPoint[] {
  let trail: TrailPoint[] = [];
  for (const s of samples)
    trail = appendTrailPoint(trail, [s.latitude, s.longitude], max);
  return trail;
}
