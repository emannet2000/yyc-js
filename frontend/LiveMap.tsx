import { useEffect, useRef, useState } from 'react';
import { api, getSessionRevision } from './api';
import type { Shipment, User } from './types';
import { RasterMap } from './RasterMap';
import { useTracking } from './tracking';
import { FleetMap } from './FleetMap';
import { roadLine, type RoadMapRoute } from './roadMap';
import { nextStep } from './workflow';
import { BrokerAlerts } from './BrokerAlerts';

export interface MapLocation {
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  recordedAt?: string;
  eta?: string;
  etaUpdatedAt?: string;
  route?: RoadMapRoute;
  destinationEta?: string;
  completionEta?: string;
  etaTiming?: { stopServiceMinutes: number; unloadingMinutes: number };
  etaBreakdown?: {
    drivingSeconds: number;
    bufferSeconds: number;
    stopServiceSeconds: number;
    unloadingSeconds: number;
  };
}

function MapOverview() {
  return (
    <div className="live-map">
      <p>Calgary overview · No driver position displayed.</p>
      <RasterMap />
      <a
        href="https://www.openstreetmap.org/#map=11/51.05/-114.07"
        target="_blank"
        rel="noreferrer"
      >
        Open larger map · © OpenStreetMap contributors
      </a>
    </div>
  );
}

export function LocationMap({
  location,
  shipmentVersion,
}: {
  location?: MapLocation;
  shipmentVersion?: number;
}) {
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  const latitude = location?.latitude;
  const longitude = location?.longitude;
  const line = roadLine(location?.route, shipmentVersion);
  if (
    typeof latitude !== 'number' ||
    !Number.isFinite(latitude) ||
    Math.abs(latitude) > 90 ||
    typeof longitude !== 'number' ||
    !Number.isFinite(longitude) ||
    Math.abs(longitude) > 180 ||
    !location?.recordedAt ||
    !Number.isFinite(Date.parse(location.recordedAt))
  )
    return (
      <>
        <p>
          No location has been shared. The assigned driver must enable location sharing.
        </p>
        {line.length ? (
          <>
            <p>Saved road route · Driver GPS has not been shared.</p>
            <RasterMap route={line} />
          </>
        ) : (
          <MapOverview />
        )}
      </>
    );
  const ageSeconds = Math.max(
    0,
    Math.floor((clock - Date.parse(location.recordedAt)) / 1000),
  );
  const stale = ageSeconds >= 300;
  const age =
    ageSeconds < 60
      ? `${ageSeconds} seconds ago`
      : `${Math.floor(ageSeconds / 60)} minutes ago`;
  const accuracy =
    typeof location.accuracy === 'number' &&
    Number.isFinite(location.accuracy) &&
    location.accuracy >= 0
      ? location.accuracy
      : null;
  return (
    <div className="live-map">
      <p role="status" className={`map-freshness ${stale ? 'is-stale' : 'is-recent'}`}>
        {stale ? 'Stale location — last known position' : 'Recent driver location'} ·{' '}
        {age} · {new Date(location.recordedAt).toLocaleString()}
        {accuracy !== null && ` · Accuracy ±${Math.round(accuracy)} m`}
      </p>
      {accuracy !== null && accuracy > 100 && (
        <p role="status">
          Low GPS accuracy. The driver may be more than 100 metres from this marker.
        </p>
      )}
      {stale && (
        <p>
          Waiting for a fresh GPS update. Check that the driver’s phone has location
          access, a connection, and this app open.
        </p>
      )}
      <RasterMap latitude={latitude} longitude={longitude} stale={stale} route={line} />
      {!!line.length && (
        <p>
          Blue line: saved road route
          {location.route?.calculatedAt &&
            ` · Calculated ${new Date(location.route.calculatedAt).toLocaleString()}`}
          . Traffic and truck restrictions may change.
        </p>
      )}
      {location.eta && Number.isFinite(Date.parse(location.eta)) && (
        <p>
          Last arrival estimate: {new Date(location.eta).toLocaleString()}
          {location.etaUpdatedAt &&
            Number.isFinite(Date.parse(location.etaUpdatedAt)) &&
            ` · Updated ${new Date(location.etaUpdatedAt).toLocaleString()}`}
        </p>
      )}
      {location.destinationEta && (
        <p>
          Estimated final arrival: {new Date(location.destinationEta).toLocaleString()}
        </p>
      )}
      {location.completionEta && (
        <p>
          Estimated completion including unloading:{' '}
          {new Date(location.completionEta).toLocaleString()}
        </p>
      )}
      {location.etaBreakdown && (
        <p>
          Estimate includes {Math.round(location.etaBreakdown.drivingSeconds / 60)} min
          driving, {Math.round(location.etaBreakdown.bufferSeconds / 60)} min buffer,{' '}
          {Math.round(location.etaBreakdown.stopServiceSeconds / 60)} min stop service and{' '}
          {Math.round(location.etaBreakdown.unloadingSeconds / 60)} min unloading. Live
          traffic is not included.
        </p>
      )}
      <a
        href={`https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=15/${latitude}/${longitude}`}
        target="_blank"
        rel="noreferrer"
      >
        Open larger map · © OpenStreetMap contributors
      </a>
      <p className="muted">
        Map requires internet access. GPS updates refresh approximately every 30 seconds.
      </p>
    </div>
  );
}

function ShipmentMap({
  id,
  shipmentVersion,
  canRoute,
}: {
  id: string;
  shipmentVersion: number;
  canRoute: boolean;
}) {
  const [location, setLocation] = useState<MapLocation>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(() => !navigator.onLine);
  const [checkedAt, setCheckedAt] = useState('');
  const [routing, setRouting] = useState(false);
  const [routeError, setRouteError] = useState('');
  const [stopMinutes, setStopMinutes] = useState<string>();
  const [unloadMinutes, setUnloadMinutes] = useState<string>();
  const refreshNow = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    const session = getSessionRevision();
    async function refresh() {
      if (inFlight || cancelled) return;
      if (!navigator.onLine) {
        setOffline(true);
        setLoading(false);
        return;
      }
      inFlight = true;
      setRefreshing(true);
      clearTimeout(timer);
      try {
        const result = await api<MapLocation>(
          `/api/shipments/${encodeURIComponent(id)}/tracking`,
        );
        if (!cancelled && session === getSessionRevision()) {
          setLocation(result);
          setError('');
          setCheckedAt(new Date().toLocaleTimeString());
        }
      } catch {
        if (!cancelled && session === getSessionRevision()) {
          setLocation(undefined);
          setError('Cannot load driver location. Retrying in 30 seconds.');
        }
      } finally {
        inFlight = false;
        if (!cancelled && session === getSessionRevision()) {
          setLoading(false);
          setRefreshing(false);
          timer = setTimeout(() => void refresh(), 30000);
        }
      }
    }
    const updated = (event: Event) => {
      if ((event as CustomEvent<string>).detail === id) void refresh();
    };
    refreshNow.current = () => void refresh();
    const connected = () => {
      setOffline(false);
      void refresh();
    };
    const disconnected = () => {
      setOffline(true);
      clearTimeout(timer);
    };
    window.addEventListener('online', connected);
    window.addEventListener('offline', disconnected);
    window.addEventListener('yyc-location-updated', updated);
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener('yyc-location-updated', updated);
      window.removeEventListener('online', connected);
      window.removeEventListener('offline', disconnected);
      refreshNow.current = () => {};
    };
  }, [id]);
  return (
    <>
      <div className="map-update-controls">
        <button
          type="button"
          className="btn light"
          disabled={refreshing || offline}
          onClick={() => refreshNow.current()}
        >
          {refreshing ? 'Refreshing location…' : 'Refresh location'}
        </button>
        {checkedAt && <span>Last checked: {checkedAt}</span>}
        {canRoute && (
          <button
            type="button"
            className="btn light"
            disabled={routing || offline}
            onClick={() => {
              setRouting(true);
              setRouteError('');
              void api(`/api/shipments/${encodeURIComponent(id)}/route`, 'POST', {
                stopServiceMinutes: Number(
                  stopMinutes ?? location?.etaTiming?.stopServiceMinutes ?? 0,
                ),
                unloadingMinutes: Number(
                  unloadMinutes ?? location?.etaTiming?.unloadingMinutes ?? 0,
                ),
              })
                .then(() => refreshNow.current())
                .catch((error: Error) => setRouteError(error.message))
                .finally(() => setRouting(false));
            }}
          >
            {routing ? 'Calculating mapped route…' : 'Update mapped road route'}
          </button>
        )}
      </div>
      {canRoute && (
        <div className="fleet-filters">
          <label>
            Service minutes per pickup/intermediate stop
            <input
              name="stopServiceMinutes"
              type="number"
              min="0"
              max="240"
              step="1"
              value={stopMinutes ?? location?.etaTiming?.stopServiceMinutes ?? 0}
              onChange={(event) => setStopMinutes(event.target.value)}
            />
          </label>
          <label>
            Final unloading minutes
            <input
              name="unloadingMinutes"
              type="number"
              min="0"
              max="240"
              step="1"
              value={unloadMinutes ?? location?.etaTiming?.unloadingMinutes ?? 0}
              onChange={(event) => setUnloadMinutes(event.target.value)}
            />
          </label>
          <p>
            Apply timing by updating the mapped road route. These are planning allowances,
            not measured service times.
          </p>
        </div>
      )}
      {offline && (
        <p role="status">
          Offline — showing the last received data. Live updates resume when your
          connection returns.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {routeError && <p role="alert">{routeError}</p>}
      {loading ? (
        <>
          <p role="status">Loading driver location…</p>
          <MapOverview />
        </>
      ) : error ? (
        <MapOverview />
      ) : (
        <LocationMap location={location} shipmentVersion={shipmentVersion} />
      )}
    </>
  );
}

export function LiveMap({
  shipments,
  user,
  onOpen,
}: {
  shipments: Shipment[];
  user: User;
  onOpen: (id: string) => void;
}) {
  const tracking = useTracking();
  const [gpsError, setGpsError] = useState('');
  const [fleetView, setFleetView] = useState(false);
  const active = shipments.filter((s) =>
    user.role === 'store'
      ? !['Delivered', 'Returned', 'Cancelled'].includes(s.status)
      : s.driverId &&
        ['Assigned', 'In transit', 'Delivery failed', 'Returning'].includes(s.status),
  );
  const [selected, setSelected] = useState('');
  const id = active.find((s) => s.id === selected)?.id || active[0]?.id;
  const delivery = active.find((s) => s.id === id);
  const nextStop =
    delivery &&
    ['Awaiting quote', 'Quote ready', 'Ready to assign', 'Offered', 'Assigned'].includes(
      delivery.status,
    )
      ? delivery.pickup
      : delivery?.status === 'Returning'
        ? delivery.returnDestination || delivery.pickup
        : delivery?.stops?.find((stop) => !stop.completedAt)?.address ||
          delivery?.destination;
  const sharing = tracking.owner === user.id && tracking.shipment === id;
  const guidance = delivery ? nextStep(delivery, user, shipments) : null;
  return (
    <section className="card mapcard">
      <h2>
        {user.role === 'admin'
          ? 'Broker dispatch map'
          : user.role === 'driver'
            ? 'Driver map'
            : 'Store delivery map'}
      </h2>
      <p>
        {user.role === 'admin'
          ? 'Monitor assigned deliveries, resolve exceptions, and switch to the fleet overview.'
          : user.role === 'driver'
            ? 'Share your phone GPS and navigate to your next stop.'
            : 'Follow your deliveries from booking to arrival. Your location is not shared.'}
      </p>
      {user.role === 'admin' && <BrokerAlerts onOpen={onOpen} />}
      {user.role === 'admin' && (
        <div className="map-update-controls">
          <button
            type="button"
            className="btn light"
            aria-pressed={!fleetView}
            onClick={() => setFleetView(false)}
          >
            Single delivery
          </button>
          <button
            type="button"
            className="btn light"
            aria-pressed={fleetView}
            onClick={() => setFleetView(true)}
          >
            Fleet view
          </button>
        </div>
      )}
      {fleetView && user.role === 'admin' ? (
        <FleetMap shipments={active} onOpen={onOpen} />
      ) : id ? (
        <>
          <label>
            Delivery
            <select value={id} onChange={(event) => setSelected(event.target.value)}>
              {active.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id} ·{' '}
                  {s.driverName ||
                    (s.driverId ? 'Assigned driver' : 'Awaiting driver assignment')}{' '}
                  · {s.destination}
                </option>
              ))}
            </select>
          </label>
          {delivery && (
            <div className="map-delivery-summary">
              <div className="map-delivery-heading">
                <strong>
                  {delivery.driverName ||
                    (delivery.driverId
                      ? 'Assigned driver'
                      : 'Awaiting driver assignment')}
                </strong>
                <span className="tag">{delivery.status}</span>
              </div>
              <ol className="map-progress" aria-label="Delivery progress">
                {['Requested', 'Driver assigned', 'Picked up', 'Delivered'].map(
                  (label, index) => (
                    <li
                      key={label}
                      data-complete={
                        index === 0 ||
                        (index === 1 && !!delivery.driverId) ||
                        (index === 2 &&
                          ['In transit', 'Delivery failed', 'Returning'].includes(
                            delivery.status,
                          ))
                      }
                    >
                      {label}
                    </li>
                  ),
                )}
              </ol>
              {guidance && (
                <p>
                  <strong>{guidance.title}</strong> · {guidance.detail}
                </p>
              )}
              <dl>
                <div>
                  <dt>Pickup</dt>
                  <dd>{delivery.pickup}</dd>
                </div>
                <div>
                  <dt>Destination</dt>
                  <dd>{delivery.destination}</dd>
                </div>
                <div>
                  <dt>Next stop</dt>
                  <dd>{nextStop}</dd>
                </div>
                <div>
                  <dt>Delivery window</dt>
                  <dd>
                    {delivery.date} · {delivery.window}
                  </dd>
                </div>
              </dl>
              {user.role === 'driver' && nextStop && (
                <a
                  className="btn light"
                  target="_blank"
                  rel="noreferrer"
                  href={`https://www.google.com/maps/dir/?${new URLSearchParams({ api: '1', destination: nextStop, travelmode: 'driving' })}`}
                >
                  Navigate to next stop ↗
                </a>
              )}
              {delivery.issue && !delivery.issue.resolved && (
                <p role="status">Open delivery issue: {delivery.issue.reason}</p>
              )}
              <button
                type="button"
                className="btn light"
                onClick={() => onOpen(delivery.id)}
              >
                Open mapped delivery
              </button>
            </div>
          )}
          {user.role === 'driver' &&
            active.find((s) => s.id === id)?.driverId === user.id && (
              <div className="phone-gps-controls">
                <p>
                  Use this phone’s GPS to share your position with the broker and store
                  for this delivery. Allow location access when prompted. Keep this page
                  open while sharing.
                </p>
                <button
                  type="button"
                  className="btn light"
                  onClick={() => {
                    if (sharing) {
                      tracking.stop();
                      return;
                    }
                    if (!navigator.geolocation || window.isSecureContext === false) {
                      setGpsError(
                        'Phone GPS requires HTTPS and a browser with location access enabled.',
                      );
                      return;
                    }
                    setGpsError('');
                    tracking.start(user.id, id);
                  }}
                >
                  {sharing ? 'Stop sharing phone GPS' : 'Share phone GPS'}
                </button>
                {(gpsError || (sharing && tracking.error)) && (
                  <p role="alert">{gpsError || tracking.error}</p>
                )}
              </div>
            )}
          <ShipmentMap
            key={`${user.id}:${id}:${delivery?.version}`}
            id={id}
            shipmentVersion={delivery!.version}
            canRoute={
              user.role === 'admin' ||
              (user.role === 'driver' && delivery?.driverId === user.id)
            }
          />
        </>
      ) : (
        <>
          <p>
            {user.role === 'store'
              ? 'No active deliveries to track.'
              : 'No active assigned deliveries to track.'}
          </p>
          <MapOverview />
        </>
      )}
    </section>
  );
}
