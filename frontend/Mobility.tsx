import { useEffect, useState, type FormEvent } from 'react';
import { useTracking } from './tracking';
import { api, ApiError, getSessionRevision } from './api';
import { useAppStore } from './stores/useAppStore';
import {
  pendingActions,
  discardPending,
  sendDriverAction,
  isConnectionFailure,
} from './offline';
import type { Shipment, User, Stop } from './types';

export function Journey({ s, user }: { s: Shipment; user: User }) {
  const { act, save, busy } = useAppStore();
  const [stopDraft, setStopDraft] = useState<{ base: string; stops: Stop[] } | null>(
    null,
  );
  const savedStops = s.stops || [];
  const savedStopKey = JSON.stringify(savedStops);
  const stops = stopDraft?.stops ?? savedStops;
  const stopConflict = !!stopDraft && stopDraft.base !== savedStopKey;
  function setStops(editedStops: Stop[]) {
    setStopDraft({ base: stopDraft?.base ?? savedStopKey, stops: editedStops });
  }
  const [link, setLink] = useState(''),
    [error, setError] = useState('');
  const [route, setRoute] = useState<{
    distanceMeters: number;
    durationSeconds: number;
    calculatedAt: string;
    eta?: string;
    source: string;
  } | null>(null);
  useEffect(() => {
    setRoute(null);
  }, [s.id, s.version]);
  useEffect(() => {
    let cancelled = false;
    async function refreshRoute() {
      try {
        const value = await api<typeof route>(`/api/shipments/${s.id}/route`);
        if (!cancelled) setRoute(value);
      } catch {
        // Keep the last route when the connection drops.
      }
    }
    void refreshRoute();
    const timer = setInterval(() => void refreshRoute(), 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [s.id, s.version]);
  const editable =
    (user.role === 'admin' || (user.role === 'store' && s.status === 'Awaiting quote')) &&
    ['Awaiting quote', 'Quote ready', 'Ready to assign', 'Offered', 'Assigned'].includes(
      s.status,
    );
  const returning = ['Returning', 'Returned'].includes(s.status);
  const visibleStops = returning
    ? (s.stops || []).filter((stop) => stop.completedAt)
    : s.stops || [];
  const next = returning ? undefined : s.stops?.find((stop) => !stop.completedAt);
  const pickedUp = [
    'In transit',
    'Delivery failed',
    'Returning',
    'Returned',
    'Delivered',
  ].includes(s.status);
  const finished = ['Delivered', 'Returned'].includes(s.status);
  const completed =
    (pickedUp ? 1 : 0) +
    (s.stops || []).filter((stop) => stop.completedAt).length +
    (finished ? 1 : 0);
  const total = visibleStops.length + 2;
  const [calculating, setCalculating] = useState(false);
  async function calculate() {
    if (calculating) return;
    setCalculating(true);
    setError('');
    try {
      setRoute(await api(`/api/shipments/${s.id}/route`, 'POST', {}));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCalculating(false);
    }
  }
  return (
    <section className="card journey-card">
      <div className="section-heading">
        <div>
          <span className="section-eyebrow">YOUR ITINERARY</span>
          <h2>Route and stops</h2>
        </div>
        <span className="count-pill">
          {completed} / {total} complete
        </span>
      </div>
      <progress
        className="journey-progress"
        aria-label="Route completion"
        max={total}
        value={completed}
      />
      <ol className="stop-timeline">
        <li data-state={pickedUp ? 'complete' : 'next'}>
          <span className="stop-marker" aria-hidden="true">
            {pickedUp ? '✓' : '1'}
          </span>
          <div>
            <span className="stop-kind">ORIGIN · PICKUP</span>
            <strong>{s.pickup}</strong>
            <span className="stop-detail">
              {pickedUp ? 'Collected' : 'Ready for collection'}
            </span>
          </div>
        </li>
        {visibleStops.map((stop, index) => (
          <li
            key={stop.id}
            data-state={
              stop.completedAt
                ? 'complete'
                : pickedUp && next?.id === stop.id
                  ? 'next'
                  : 'pending'
            }
          >
            <span className="stop-marker" aria-hidden="true">
              {stop.completedAt ? '✓' : index + 2}
            </span>
            <div>
              <span className="stop-kind">
                STOP {index + 1} · {stop.kind === 'pickup' ? 'PICKUP' : 'DROPOFF'}
              </span>
              <strong>{stop.address}</strong>
              <span className="stop-detail">
                {stop.contact && `${stop.contact} · `}
                {stop.completedAt
                  ? `Completed · ${stop.recipient} · ${stop.pod}`
                  : next?.id === stop.id && pickedUp
                    ? 'Next stop'
                    : 'Pending'}
              </span>
            </div>
          </li>
        ))}
        <li data-state={finished ? 'complete' : pickedUp && !next ? 'next' : 'pending'}>
          <span className="stop-marker" aria-hidden="true">
            {finished ? '✓' : total}
          </span>
          <div>
            <span className="stop-kind">
              {returning ? 'RETURN · PICKUP LOCATION' : 'DESTINATION · FINAL DELIVERY'}
            </span>
            <strong>{returning ? s.returnDestination || s.pickup : s.destination}</strong>
            <span className="stop-detail">
              {returning
                ? finished
                  ? 'Return confirmed'
                  : 'Return cargo to pickup'
                : finished
                  ? 'Delivery confirmed'
                  : 'Recipient handoff'}
            </span>
          </div>
        </li>
      </ol>
      {error && <p role="alert">{error}</p>}
      {route &&
        s.status !== 'Delivery failed' &&
        (!returning || route.source === 'driver-location') && (
          <div className="route-summary">
            <div>
              <span>Road distance</span>
              <strong>
                {(route.distanceMeters / 1000).toFixed(1)} <small>km</small>
              </strong>
            </div>
            <div>
              <span>Driving time</span>
              <strong>
                {Math.ceil(route.durationSeconds / 60)} <small>min</small>
              </strong>
            </div>
            <div>
              <span>Next stop ETA</span>
              <strong className="eta-value">
                {s.arrivedAt
                  ? 'Arrived'
                  : route.eta
                    ? new Date(route.eta).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : 'Awaiting GPS'}
              </strong>
            </div>
            <p>
              {route.source === 'driver-location'
                ? 'Based on recent driver GPS'
                : 'Based on planned addresses'}{' '}
              · Updated{' '}
              {new Date(route.calculatedAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
          </div>
        )}
      <div className="journey-tools">
        {(user.role === 'admin' || s.driverId === user.id) &&
          s.status !== 'Delivery failed' &&
          !['Delivered', 'Returned', 'Cancelled'].includes(s.status) && (
            <button
              className="btn light"
              disabled={busy || calculating}
              onClick={() => void calculate()}
              aria-busy={calculating}
            >
              {calculating ? 'Calculating route…' : 'Calculate road route and ETA'}
            </button>
          )}
        <a
          className="btn light"
          target="_blank"
          rel="noreferrer"
          href={`https://www.google.com/maps/dir/?${new URLSearchParams({
            api: '1',
            ...(returning ? {} : { origin: s.pickup }),
            destination: returning ? s.returnDestination || s.pickup : s.destination,
            travelmode: 'driving',
            waypoints: (returning ? [] : s.stops || [])
              .filter((p) => !p.completedAt)
              .map((p) => p.address)
              .join('|'),
          })}`}
        >
          Open route in maps <span aria-hidden="true">↗</span>
        </a>
      </div>
      <p className="muted route-disclaimer">
        Road estimates exclude live traffic and unloading time. Check truck restrictions
        before travel.
      </p>
      {editable && (
        <details>
          <summary>Edit intermediate stops</summary>
          <form
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (stopConflict) return;
              const form = event.currentTarget;
              const reason = String(new FormData(form).get('reason'));
              void save(
                () =>
                  api(`/api/shipments/${s.id}/actions`, 'POST', {
                    action: 'setStops',
                    version: s.version,
                    stops,
                    reason,
                  }),
                'Delivery updated.',
                () => {
                  setStopDraft(null);
                  form.reset();
                },
              );
            }}
          >
            {stops.map((stop, i) => (
              <fieldset className="stop-editor" key={stop.id}>
                <legend>Stop {i + 1}</legend>
                <label>
                  Type
                  <select
                    value={stop.kind}
                    onChange={(e) =>
                      setStops(
                        stops.map((p, j) =>
                          i === j ? { ...p, kind: e.target.value as Stop['kind'] } : p,
                        ),
                      )
                    }
                  >
                    <option value="pickup">Pickup</option>
                    <option value="dropoff">Dropoff</option>
                  </select>
                </label>
                <label>
                  Address
                  <input
                    required
                    maxLength={2000}
                    value={stop.address}
                    onChange={(e) =>
                      setStops(
                        stops.map((p, j) =>
                          i === j ? { ...p, address: e.target.value } : p,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  Contact
                  <input
                    maxLength={2000}
                    value={stop.contact || ''}
                    onChange={(e) =>
                      setStops(
                        stops.map((p, j) =>
                          i === j ? { ...p, contact: e.target.value } : p,
                        ),
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setStops(stops.filter((_, j) => j !== i))}
                >
                  Remove stop {i + 1}
                </button>
                {i > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      const next = [...stops];
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      setStops(next);
                    }}
                  >
                    Move up
                  </button>
                )}
              </fieldset>
            ))}
            <button
              type="button"
              disabled={stops.length >= 18}
              onClick={() =>
                setStops([
                  ...stops,
                  { id: crypto.randomUUID(), kind: 'dropoff', address: '', contact: '' },
                ])
              }
            >
              Add stop
            </button>
            <label>
              Revision reason
              <input name="reason" required maxLength={2000} />
            </label>
            <p>
              Changing stops clears the quote and driver assignment and requires a new
              customer acceptance.
            </p>
            {stopConflict && (
              <div className="notice" role="status">
                <p>
                  The saved stops changed. Review the current itinerary above before
                  saving your edits.
                </p>
                <button type="button" onClick={() => setStopDraft(null)}>
                  Use saved stops
                </button>
                <button
                  type="button"
                  onClick={() => setStopDraft({ base: savedStopKey, stops })}
                >
                  Keep my edits
                </button>
              </div>
            )}
            <button className="btn" disabled={busy || stopConflict}>
              Save stops
            </button>
          </form>
        </details>
      )}
      {next &&
        s.status === 'In transit' &&
        s.driverId === user.id &&
        user.role === 'driver' && (
          <form
            key={`${s.id}:${next.id}`}
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              void act(s.id, s.version, 'completeStop', {
                stopId: next.id,
                pod: String(data.get('pod')),
                recipient: String(data.get('recipient')),
              });
            }}
          >
            <h3>Complete next stop: {next.address}</h3>
            <label>
              Receipt reference
              <input name="pod" required maxLength={2000} />
            </label>
            <label>
              Received / released by
              <input name="recipient" required maxLength={2000} />
            </label>
            <button className="btn" disabled={busy || !!(s.issue && !s.issue.resolved)}>
              Confirm stop
            </button>
          </form>
        )}
      {['store', 'admin'].includes(user.role) && (
        <details>
          <summary>Recipient tracking link</summary>
          <p>
            The link shows delivery status, stop counts and ETA for seven days. Creating
            another link revokes the previous one.
          </p>
          <button
            className="btn light"
            disabled={busy}
            onClick={() =>
              void save(async () => {
                const result = await api<{ url: string }>(
                  `/api/shipments/${s.id}/recipient-link`,
                  'POST',
                  {},
                );
                setLink(result.url);
              }, 'Recipient link created.')
            }
          >
            Create tracking link
          </button>
          <button
            className="btn light"
            disabled={busy}
            onClick={() =>
              void save(async () => {
                await api(`/api/shipments/${s.id}/recipient-link`, 'DELETE', {});
                setLink('');
              }, 'Recipient link revoked.')
            }
          >
            Revoke link
          </button>
          {link && (
            <label>
              Share privately with recipient
              <input readOnly value={link} onFocus={(e) => e.target.select()} />
            </label>
          )}
        </details>
      )}
    </section>
  );
}

export function RecipientTracking({ token }: { token: string }) {
  const [value, setValue] = useState<{
      id: string;
      status: string;
      eta: string | null;
      arrived?: boolean;
      date: string;
      window: string;
      stopsCompleted: number;
      redeliveryDate?: string;
      redeliveryWindow?: string;
      stopsTotal: number;
    } | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    history.replaceState(null, '', location.pathname);
    let cancelled = false;
    async function refresh() {
      try {
        const result = await api<typeof value>('/api/recipient-tracking', 'POST', {
          token,
        });
        if (!cancelled) {
          setValue(result);
          setError('');
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [token]);
  return (
    <main className="recipient-page">
      <div className="recipient-brand">
        <img src="/assets/yyc-brokers-logo.jpg" alt="YYC Brokers" />
        <span>
          YYC BROKERS<small>DELIVERY TRACKING</small>
        </span>
      </div>
      <section className="recipient-card">
        <span className="section-eyebrow">EVERY STOP, ONE STEP CLOSER</span>
        <h1>YYC delivery tracking</h1>
        {error && <p role="alert">{error}</p>}
        {value ? (
          <>
            <div className="recipient-shipment">
              <h2>{value.id}</h2>
              <span className="recipient-status">
                <span className="status-dot" />
                {value.status}
              </span>
            </div>
            <div className="recipient-eta">
              <span>NEXT STOP</span>
              <strong>
                {value.eta
                  ? new Date(value.eta).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : value.status === 'Delivered'
                    ? 'Delivered'
                    : ['Cancelled', 'Returned', 'Delivery failed'].includes(value.status)
                      ? value.status
                      : value.arrived
                        ? 'Arrived'
                        : 'ETA pending'}
              </strong>
              <p>
                {value.eta
                  ? new Date(value.eta).toLocaleDateString([], {
                      month: 'long',
                      day: 'numeric',
                    })
                  : 'Check below for the latest delivery status.'}
              </p>
            </div>
            <div className="recipient-schedule">
              <span>Scheduled pickup</span>
              <strong>
                {value.date} · {value.window}
              </strong>
            </div>
            {value.redeliveryDate && (
              <div className="recipient-schedule">
                <span>Scheduled redelivery</span>
                <strong>
                  {value.redeliveryDate} · {value.redeliveryWindow}
                </strong>
              </div>
            )}
            <p>
              {value.stopsCompleted} of {value.stopsTotal} intermediate stops completed
            </p>
            <p>
              {value.eta
                ? `Next stop ETA: ${new Date(value.eta).toLocaleString()}`
                : 'ETA is not currently available.'}
            </p>
            <p className="recipient-refresh">
              <span className="status-dot" /> Updates every 30 seconds.
            </p>
          </>
        ) : (
          !error && <p role="status">Loading delivery…</p>
        )}
      </section>
      <p className="recipient-footer">
        Your delivery, without the guesswork. · YYC Brokers
      </p>
    </main>
  );
}

let syncing = false;
export function OfflinePanel({ user }: { user: User }) {
  const [revision, setRevision] = useState(0),
    [message, setMessage] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  const entries = pendingActions(user.id);
  useEffect(() => {
    const update = () => {
      setRevision((v) => v + 1);
      setOnline(navigator.onLine);
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    window.addEventListener('yyc-offline-change', update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      window.removeEventListener('yyc-offline-change', update);
      window.removeEventListener('storage', update);
    };
  }, []);
  async function sync() {
    if (syncing || !navigator.onLine) return;
    syncing = true;
    setMessage('Syncing saved actions…');
    try {
      const store = useAppStore.getState();
      await store.refresh(); // Live session + CSRF, never trust a cached identity.
      if (useAppStore.getState().state?.user.id !== user.id) return;
      const session = getSessionRevision();
      const conflicts = new Map<string, string>();
      for (const entry of pendingActions(user.id)) {
        if (session !== getSessionRevision()) return;
        if (conflicts.has(entry.id)) continue;
        try {
          await sendDriverAction(entry);
        } catch (error) {
          if (
            !(error instanceof ApiError) ||
            ![400, 403, 404, 409, 422].includes(error.status)
          )
            throw error;
          conflicts.set(entry.id, error.message);
          continue;
        }
        if (session !== getSessionRevision()) return;
        discardPending(user.id, entry.requestKey);
      }
      await useAppStore.getState().refresh();
      if (session !== getSessionRevision()) return;
      setMessage(
        conflicts.size
          ? `Review saved actions for ${[...conflicts.keys()].join(', ')} before retrying or discarding them. ${conflicts.values().next().value}`
          : 'All saved driver actions synced.',
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) await useAppStore.getState().boot();
      setMessage(
        isConnectionFailure(e)
          ? 'Still offline. Saved actions remain on this device.'
          : `${(e as Error).message} Sync stopped. Review the latest delivery before discarding or retrying.`,
      );
    } finally {
      syncing = false;
    }
  }
  useEffect(() => {
    if (online && pendingActions(user.id).length) void sync();
    // Reconnect and account changes trigger automatic replay. Conflicts require explicit review.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, user.id]);
  if (user.role !== 'driver') return null;
  return (
    <section
      className={`sync-panel ${!online ? 'is-offline' : entries.length ? 'has-pending' : 'is-synced'}`}
      data-revision={revision}
    >
      <div className="sync-summary">
        <span className="connection-icon" aria-hidden="true">
          {online ? '✓' : '↻'}
        </span>
        <div>
          <h2>Driver sync</h2>
          <p>
            {online ? 'Online' : 'Offline'} · {entries.length} action(s) awaiting server
            confirmation.
          </p>
        </div>
        <span className="connection-pill">
          <span className="status-dot" />
          {online ? (entries.length ? 'Pending sync' : 'Connected') : 'Working offline'}
        </span>
      </div>
      {message && (
        <p className="sync-message" role="status">
          {message}
        </p>
      )}
      {entries.length > 0 && (
        <>
          <button
            className="btn"
            disabled={!online || syncing}
            onClick={() => void sync()}
          >
            Sync saved actions
          </button>
          <ol className="sync-queue">
            {entries.map((entry) => (
              <li key={entry.requestKey}>
                {entry.id}: {entry.action} · {new Date(entry.queuedAt).toLocaleString()}{' '}
                <button
                  disabled={syncing}
                  onClick={() => {
                    if (
                      confirm(
                        'Discard this and all later saved actions for this delivery? Unsynced work will be lost.',
                      )
                    ) {
                      for (const queued of pendingActions(user.id).filter(
                        (p) => p.id === entry.id && p.version >= entry.version,
                      ))
                        discardPending(user.id, queued.requestKey);
                      void useAppStore.getState().refresh();
                    }
                  }}
                >
                  Discard from this action
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

export function DriverTracking({
  user,
  shipments,
}: {
  user: User;
  shipments: Shipment[];
}) {
  const { owner, shipment, error, stop, report } = useTracking();
  const job = shipments.find(
    (s) =>
      s.id === shipment &&
      s.driverId === user.id &&
      ['Assigned', 'In transit', 'Delivery failed', 'Returning'].includes(s.status),
  );
  const eligible = owner === user.id && user.role === 'driver' && !!job;
  useEffect(() => {
    if (!eligible) {
      stop();
      return;
    }
    if (!navigator.geolocation) {
      report('Location sharing is unavailable on this device.');
      return;
    }
    let cancelled = false,
      lastSent = 0,
      sending = false;
    const storageKey = `yyc-location:${user.id}`;
    async function flush() {
      if (cancelled || sending || !navigator.onLine) return;
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const point = JSON.parse(raw);
      if (
        point.shipment !== shipment ||
        Date.now() - Date.parse(point.recordedAt) > 5 * 60000
      ) {
        localStorage.removeItem(storageKey);
        return;
      }
      sending = true;
      try {
        await api(`/api/shipments/${shipment}/tracking`, 'POST', point);
        if (cancelled) return;
        if (localStorage.getItem(storageKey) === raw) localStorage.removeItem(storageKey);
        report('');
      } catch (e) {
        if (!cancelled) report(`Location waiting to sync: ${(e as Error).message}`);
      } finally {
        sending = false;
      }
    }
    const watch = navigator.geolocation.watchPosition(
      (position) => {
        if (cancelled || Date.now() - lastSent < 30000) return;
        lastSent = Date.now();
        try {
          localStorage.setItem(
            storageKey,
            JSON.stringify({
              shipment,
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy: position.coords.accuracy,
              recordedAt: new Date(position.timestamp || Date.now()).toISOString(),
            }),
          );
          void flush();
        } catch {
          report(
            'Cannot store location on this device. Check available browser storage.',
          );
        }
      },
      () =>
        report(
          'Location permission or GPS is unavailable. Check device permissions and retry.',
        ),
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 },
    );
    const resume = () => void flush();
    window.addEventListener('online', resume);
    const timer = setInterval(resume, 30000);
    return () => {
      cancelled = true;
      navigator.geolocation.clearWatch(watch);
      window.removeEventListener('online', resume);
      clearInterval(timer);
      localStorage.removeItem(storageKey);
    };
  }, [eligible, owner, shipment, user.id, stop, report]);
  useEffect(() => () => stop(), [stop]);
  if (!eligible) return null;
  return (
    <section className="tracking-banner">
      <span className="tracking-beacon" aria-hidden="true">
        ◎
      </span>
      <div>
        <p role="status">
          Location sharing active for {shipment}. You can close the delivery drawer and
          navigate this workspace.
        </p>
        <p>
          Keep this app open. Phone locking or closing the browser can suspend location
          sharing.
        </p>
        {error && <p role="alert">{error}</p>}
      </div>
      <button className="btn light" onClick={stop}>
        Stop location sharing
      </button>
    </section>
  );
}
