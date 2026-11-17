import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export interface FleetPoint {
  id: string;
  latitude: number;
  longitude: number;
  label: string;
  stale: boolean;
}

export function RasterMap({
  latitude,
  longitude,
  stale = false,
  points,
  onSelect,
  route,
}: {
  latitude?: number;
  longitude?: number;
  stale?: boolean;
  points?: FleetPoint[];
  onSelect?: (id: string) => void;
  route?: [number, number][];
}) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);
  const following = useRef(true);
  const [follow, setFollow] = useState(true);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const sizeButton = useRef<HTMLButtonElement>(null);
  const fleet = useRef<L.LayerGroup | null>(null);
  const fleetPoints = useRef<FleetPoint[]>([]);
  const routeLayer = useRef<L.Polyline | null>(null);
  useEffect(() => {
    if (!map.current || !points) return;
    fleet.current?.remove();
    fleetPoints.current = points;
    const layer = L.layerGroup().addTo(map.current);
    fleet.current = layer;
    for (const point of points) {
      L.marker([point.latitude, point.longitude], {
        title: point.label,
        icon: L.divIcon({
          className: `driver-map-pin${point.stale ? ' is-stale' : ''}`,
          html: '<span aria-hidden="true">●</span>',
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        }),
      })
        .on('click', () => onSelect?.(point.id))
        .addTo(layer);
    }
    if (following.current && points.length)
      map.current.fitBounds(
        points.map((point) => [point.latitude, point.longitude] as L.LatLngTuple),
        { padding: [30, 30], maxZoom: 14, animate: false },
      );
    return () => {
      layer.remove();
    };
  }, [points, onSelect]);
  useEffect(() => {
    map.current?.invalidateSize();
    if (!expanded) return;
    const collapse = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setExpanded(false);
        sizeButton.current?.focus();
      }
    };
    window.addEventListener('keydown', collapse);
    return () => window.removeEventListener('keydown', collapse);
  }, [expanded]);
  useEffect(() => {
    if (!element.current) return;
    const view = L.map(element.current, { scrollWheelZoom: false }).setView(
      [51.05, -114.07],
      10,
    );
    map.current = view;
    view.on('dragstart', () => {
      following.current = false;
      setFollow(false);
    });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    })
      .on('tileerror', () => setFailed(true))
      .on('tileload', () => setFailed(false))
      .addTo(view);
    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => view.invalidateSize())
        : null;
    observer?.observe(element.current);
    return () => {
      observer?.disconnect();
      view.remove();
      map.current = null;
      marker.current = null;
    };
  }, []);
  useEffect(() => {
    if (!map.current) return;
    if (latitude === undefined || longitude === undefined) return;
    const position: L.LatLngExpression = [latitude, longitude];
    if (marker.current) marker.current.setLatLng(position);
    else
      marker.current = L.marker(position, {
        title: 'Last shared driver position',
        icon: L.divIcon({
          className: 'driver-map-pin',
          html: '<span aria-hidden="true">●</span>',
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        }),
      }).addTo(map.current);
    if (following.current)
      map.current.setView(
        position,
        marker.current && map.current.getZoom() >= 14 ? map.current.getZoom() : 14,
        { animate: false },
      );
  }, [latitude, longitude]);
  useEffect(() => {
    marker.current?.getElement()?.classList.toggle('is-stale', stale);
  }, [stale, latitude, longitude]);
  useEffect(() => {
    routeLayer.current?.remove();
    routeLayer.current = null;
    if (!map.current || !route?.length || !L.Browser.svg) return;
    const line = L.polyline(route, {
      color: '#2563eb',
      weight: 5,
      opacity: 0.8,
      className: 'delivery-road-line',
      renderer: L.svg(),
    }).addTo(map.current);
    routeLayer.current = line;
    if (following.current && latitude === undefined)
      map.current.fitBounds(line.getBounds(), {
        padding: [25, 25],
        maxZoom: 14,
        animate: false,
      });
    return () => {
      line.remove();
    };
  }, [route, latitude]);
  return (
    <>
      <button
        type="button"
        className="btn light"
        ref={sizeButton}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? 'Reduce map' : 'Enlarge map'}
      </button>
      {!!route?.length && (
        <button
          type="button"
          className="btn light"
          onClick={() => {
            following.current = false;
            setFollow(false);
            map.current?.fitBounds(route, {
              padding: [25, 25],
              maxZoom: 14,
              animate: false,
            });
          }}
        >
          Fit road route
        </button>
      )}
      {points && (
        <button
          type="button"
          className="btn light"
          disabled={!points.length}
          onClick={() => {
            following.current = true;
            setFollow(true);
            map.current?.fitBounds(
              fleetPoints.current.map(
                (point) => [point.latitude, point.longitude] as L.LatLngTuple,
              ),
              { padding: [30, 30], maxZoom: 14, animate: false },
            );
          }}
        >
          Fit all drivers
        </button>
      )}
      {latitude !== undefined && longitude !== undefined && (
        <button
          type="button"
          className="btn light"
          aria-pressed={follow}
          onClick={() => {
            following.current = true;
            setFollow(true);
            map.current?.setView([latitude, longitude], 14, { animate: false });
          }}
        >
          {follow ? 'Following driver · Recenter' : 'Recenter on driver'}
        </button>
      )}
      <div
        ref={element}
        className={`raster-map${expanded ? ' is-expanded' : ''}`}
        role="region"
        aria-label={
          points
            ? 'Fleet location map'
            : latitude === undefined
              ? 'Delivery area map'
              : 'Driver location map'
        }
      />
      {failed && (
        <p role="status">
          Map tiles could not load. Check your internet connection. Location details
          remain available above.
        </p>
      )}
    </>
  );
}
