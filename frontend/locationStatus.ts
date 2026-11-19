// Pure helpers that decide what the live map panel shows. Kept separate from
// React so the rules can be tested directly.

// Matches the server's gpsFreshnessMs (five minutes).
export const LOCATION_FRESH_MS = 5 * 60000;

export interface LocationPoint {
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  recordedAt?: string;
  driverId?: string;
}

export type LocationState = 'live' | 'stale' | 'previous-driver' | 'none';

export interface LocationStatus {
  state: LocationState;
  ageMinutes: number | null;
  message: string;
}

export function locationStatus(
  point: LocationPoint | null | undefined,
  assignedDriverId: string | null | undefined,
  now: number,
): LocationStatus {
  if (point?.latitude == null || point?.longitude == null)
    return {
      state: 'none',
      ageMinutes: null,
      message: 'No location has been shared for this delivery yet.',
    };
  if (!assignedDriverId || point.driverId !== assignedDriverId)
    return {
      state: 'previous-driver',
      ageMinutes: null,
      message: 'The last location came from a previous driver and is hidden.',
    };
  const time = Date.parse(point.recordedAt ?? '');
  if (!Number.isFinite(time))
    return {
      state: 'stale',
      ageMinutes: null,
      message: 'Location received, but its time is unknown.',
    };
  const age = Math.max(0, Math.floor((now - time) / 60000));
  if (now - time < LOCATION_FRESH_MS)
    return {
      state: 'live',
      ageMinutes: age,
      message: age === 0 ? 'Updated less than a minute ago' : `Updated ${age} min ago`,
    };
  return {
    state: 'stale',
    ageMinutes: age,
    message: `Last update ${age} min ago. The driver may have stopped sharing.`,
  };
}
