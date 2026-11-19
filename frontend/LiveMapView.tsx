import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { appendTrailPoint, TRAIL_MAX_POINTS, type TrailPoint } from './locationTrail';

// Interactive map for one driver position. Shows the position and accuracy,
// draws the route taken while this page is open, follows the driver when they
// leave the visible area, and greys out when the position is stale.
// Mount one instance per delivery so trails never mix between deliveries.
export function LiveMapView({
  latitude,
  longitude,
  accuracy = 0,
  stale = false,
  title,
  history,
}: {
  latitude: number;
  longitude: number;
  accuracy?: number;
  stale?: boolean;
  title: string;
  // Stored route from the server, oldest first. Replaces the trail when it changes.
  history?: TrailPoint[];
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.CircleMarker | null>(null);
  const circleRef = useRef<L.Circle | null>(null);
  const trailRef = useRef<L.Polyline | null>(null);
  const pointsRef = useRef<TrailPoint[]>([]);
  const latestRef = useRef<TrailPoint>([latitude, longitude]);

  useEffect(() => {
    if (!elRef.current) return;
    const start: TrailPoint = [latitude, longitude];
    const map = L.map(elRef.current, { attributionControl: true }).setView(start, 15);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    trailRef.current = L.polyline([], {
      color: '#1f5fae',
      weight: 3,
      opacity: 0.6,
      dashArray: '6 6',
    }).addTo(map);
    mapRef.current = map;
    const resize = window.setTimeout(() => map.invalidateSize(), 0);
    return () => {
      window.clearTimeout(resize);
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      circleRef.current = null;
      trailRef.current = null;
      pointsRef.current = [];
    };
    // Created once per mount; position updates are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!history) return;
    pointsRef.current = history.slice(-TRAIL_MAX_POINTS);
    trailRef.current?.setLatLngs(pointsRef.current);
  }, [history]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const pos: TrailPoint = [latitude, longitude];
    latestRef.current = pos;
    const color = stale ? '#7a8594' : '#1f5fae';
    const radius = Math.max(accuracy, 5);
    if (circleRef.current) {
      circleRef.current.setLatLng(pos).setRadius(radius);
      circleRef.current.setStyle({ color, fillColor: color });
    } else {
      circleRef.current = L.circle(pos, {
        radius,
        color,
        fillColor: color,
        weight: 1,
        fillOpacity: 0.12,
      }).addTo(map);
    }
    if (markerRef.current) {
      markerRef.current.setLatLng(pos).setStyle({ fillColor: color });
    } else {
      markerRef.current = L.circleMarker(pos, {
        radius: 8,
        color: '#ffffff',
        weight: 3,
        fillColor: color,
        fillOpacity: 1,
      }).addTo(map);
    }
    pointsRef.current = appendTrailPoint(pointsRef.current, pos);
    trailRef.current?.setLatLngs(pointsRef.current);
    if (!map.getBounds().contains(pos)) map.panTo(pos);
  }, [latitude, longitude, accuracy, stale]);

  function recenter() {
    mapRef.current?.setView(latestRef.current, Math.max(mapRef.current.getZoom(), 15));
  }

  return (
    <div className="livemap-wrap">
      <div
        ref={elRef}
        className="livemap-canvas"
        role="region"
        aria-label={title}
        data-stale={stale ? 'true' : 'false'}
      />
      <button type="button" className="livemap-recenter" onClick={recenter}>
        Center on driver
      </button>
    </div>
  );
}
