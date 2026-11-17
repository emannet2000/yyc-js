import { useEffect, useRef, useState } from 'react';
import { api, getSessionRevision } from './api';
import { RasterMap, type FleetPoint } from './RasterMap';
import type { Shipment } from './types';

interface FleetDelivery {
  shipmentId: string;
  driverId: string;
  driverName: string;
  latitude?: number;
  longitude?: number;
  recordedAt?: string;
}

function hasPosition(row: FleetDelivery) {
  return (
    typeof row.latitude === 'number' &&
    Number.isFinite(row.latitude) &&
    Math.abs(row.latitude) <= 90 &&
    typeof row.longitude === 'number' &&
    Number.isFinite(row.longitude) &&
    Math.abs(row.longitude) <= 180 &&
    !!row.recordedAt &&
    Number.isFinite(Date.parse(row.recordedAt))
  );
}

export function FleetMap({
  shipments,
  onOpen,
}: {
  shipments: Shipment[];
  onOpen: (id: string) => void;
}) {
  const [data, setData] = useState<{ deliveries: FleetDelivery[]; truncated: boolean }>({
    deliveries: [],
    truncated: false,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const [offline, setOffline] = useState(() => !navigator.onLine);
  const [query, setQuery] = useState('');
  const [freshness, setFreshness] = useState('all');
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    let active = true,
      pending = false;
    let timer: ReturnType<typeof setTimeout>;
    const session = getSessionRevision();
    async function load() {
      if (!active || pending || !navigator.onLine) return;
      pending = true;
      setBusy(true);
      clearTimeout(timer);
      try {
        const result = await api<typeof data>('/api/fleet/tracking');
        if (active && session === getSessionRevision()) {
          setData(result);
          setError('');
        }
      } catch {
        if (active && session === getSessionRevision()) {
          setData({ deliveries: [], truncated: false });
          setError('Fleet locations could not load. Retry or check your connection.');
        }
      } finally {
        pending = false;
        if (active && session === getSessionRevision()) {
          setBusy(false);
          timer = setTimeout(() => void load(), 30000);
        }
      }
    }
    refresh.current = () => void load();
    const online = () => {
      setOffline(false);
      void load();
    };
    const disconnected = () => {
      setOffline(true);
      clearTimeout(timer);
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', disconnected);
    const age = setInterval(() => setClock(Date.now()), 15000);
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
      clearInterval(age);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', disconnected);
    };
  }, []);
  const visible = new Set(shipments.map((s) => s.id));
  const drivers = new Map<string, FleetDelivery>();
  for (const row of data.deliveries) {
    if (!visible.has(row.shipmentId)) continue;
    const previous = drivers.get(row.driverId);
    if (
      !previous ||
      (hasPosition(row) &&
        (!hasPosition(previous) ||
          Date.parse(row.recordedAt!) > Date.parse(previous.recordedAt!)))
    )
      drivers.set(row.driverId, row);
  }
  const status = (row: FleetDelivery) =>
    !hasPosition(row)
      ? 'missing'
      : clock - Date.parse(row.recordedAt!) >= 300000
        ? 'stale'
        : 'recent';
  const all = [...drivers.values()];
  const matching = all.filter((row) => {
    const shipment = shipments.find((s) => s.id === row.shipmentId);
    return (
      (freshness === 'all' || status(row) === freshness) &&
      `${row.driverName} ${row.shipmentId} ${shipment?.pickup || ''} ${shipment?.destination || ''}`
        .toLowerCase()
        .includes(query.trim().toLowerCase())
    );
  });
  const points: FleetPoint[] = matching.filter(hasPosition).map((row) => ({
    id: row.shipmentId,
    latitude: row.latitude!,
    longitude: row.longitude!,
    label: `${row.driverName} · ${row.shipmentId}`,
    stale: clock - Date.parse(row.recordedAt!) >= 300000,
  }));
  return (
    <div className="fleet-map">
      <button
        type="button"
        className="btn light"
        disabled={busy || offline}
        onClick={() => refresh.current()}
      >
        {busy ? 'Refreshing fleet…' : 'Refresh fleet'}
      </button>
      {error && <p role="alert">{error}</p>}
      {offline && (
        <p role="status">Offline — fleet markers show last received positions.</p>
      )}
      <p role="status">
        {all.filter(hasPosition).length} drivers located ·{' '}
        {all.filter((row) => status(row) === 'stale').length} stale ·{' '}
        {all.filter((row) => status(row) === 'missing').length} without GPS. Amber markers
        are at least five minutes old.
      </p>
      <div className="fleet-filters">
        <label>
          Find driver or delivery
          <input
            type="search"
            name="fleetSearch"
            value={query}
            maxLength={200}
            placeholder="Driver, reference or address"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          GPS status
          <select
            name="fleetFreshness"
            value={freshness}
            onChange={(event) => setFreshness(event.target.value)}
          >
            <option value="all">All drivers</option>
            <option value="recent">Recent GPS</option>
            <option value="stale">Stale GPS</option>
            <option value="missing">No GPS</option>
          </select>
        </label>
        <button
          type="button"
          className="btn light"
          disabled={!query && freshness === 'all'}
          onClick={() => {
            setQuery('');
            setFreshness('all');
          }}
        >
          Clear fleet filters
        </button>
      </div>
      <p>
        {matching.length} matching drivers · {points.length} markers shown
      </p>
      {data.truncated && (
        <p>Showing the first 500 active deliveries. Some drivers may not appear.</p>
      )}
      <RasterMap points={points} onSelect={onOpen} />
      {!busy && !points.length && (
        <p>
          {matching.length
            ? 'These drivers have not shared a valid GPS position. Open their delivery to follow up.'
            : 'No drivers match these filters.'}
        </p>
      )}
      <ul className="fleet-driver-list">
        {matching.map((row) => (
          <li key={row.driverId}>
            <button
              type="button"
              className="btn light"
              onClick={() => onOpen(row.shipmentId)}
            >
              {row.driverName} · {row.shipmentId} ·{' '}
              {status(row) === 'missing'
                ? 'No GPS'
                : status(row) === 'stale'
                  ? 'Stale'
                  : 'Recent'}{' '}
              · Open delivery
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
