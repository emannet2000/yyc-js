import { useEffect, useState } from 'react';
import { api } from './api';
import { useAppStore } from './stores/useAppStore';
import type { Shipment, User } from './types';
interface Device {
  id: string;
  name: string;
  expiresAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}
export function NativeTracking({ s, user }: { s: Shipment; user: User }) {
  const [devices, setDevices] = useState<Device[]>([]),
    [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null),
    [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const { busy, save } = useAppStore();
  useEffect(() => {
    setPairing(null);
    setDevices([]);
  }, [s.id]);
  const canManage =
    user.role === 'admin' || (user.role === 'driver' && s.driverId === user.id);
  const active = ['Assigned', 'In transit', 'Delivery failed', 'Returning'].includes(
    s.status,
  );
  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    const load = () =>
      void api<Device[]>(`/api/shipments/${s.id}/mobile-devices`)
        .then((value) => {
          if (!cancelled) {
            setDevices(value);
            setError('');
          }
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        });
    load();
    const timer = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [s.id, canManage, revision]);
  if (!canManage) return null;
  return (
    <section className="card native-tracking">
      <div className="section-heading">
        <div>
          <span className="section-eyebrow">ANDROID COMPANION</span>
          <h2>Background location sharing</h2>
        </div>
        <span className="count-pill">Native app</span>
      </div>
      <p>
        Keep sharing this delivery's location with the phone locked or the browser closed.
        Start sharing in YYC Driver; its notification lets you stop at any time.
      </p>
      {error && <p role="alert">{error}</p>}
      {user.role === 'driver' && active && (
        <button
          className="btn light"
          disabled={busy}
          onClick={() =>
            void save(async () => {
              setPairing(await api(`/api/shipments/${s.id}/mobile-devices`, 'POST', {}));
            }, 'Phone pairing code created.')
          }
        >
          Pair Android phone
        </button>
      )}
      {pairing && (
        <div className="native-pairing">
          <label>
            One-time phone pairing code
            <input readOnly value={pairing.code} onFocus={(e) => e.target.select()} />
          </label>
          <p>
            In YYC Driver, enter workspace address <strong>{location.origin}</strong> and
            this code. Expires at {new Date(pairing.expiresAt).toLocaleTimeString()}. Keep
            the code private.
          </p>
        </div>
      )}
      {devices.length ? (
        <ul className="native-devices">
          {devices.map((device) => (
            <li key={device.id}>
              <div>
                <strong>{device.name}</strong>
                <span>
                  {device.revokedAt
                    ? 'Revoked'
                    : device.expiresAt <= Date.now()
                      ? 'Expired'
                      : device.lastSeenAt
                        ? `Last connected ${new Date(device.lastSeenAt).toLocaleString()}`
                        : 'Paired · waiting for phone'}
                  {!device.revokedAt &&
                    device.expiresAt > Date.now() &&
                    ` · Authorized until ${new Date(device.expiresAt).toLocaleDateString()}`}
                </span>
              </div>
              {!device.revokedAt && device.expiresAt > Date.now() && (
                <button
                  className="btn light"
                  disabled={busy}
                  onClick={() =>
                    void save(async () => {
                      await api(
                        `/api/shipments/${s.id}/mobile-devices/${device.id}`,
                        'DELETE',
                        {},
                      );
                      setRevision((v) => v + 1);
                    }, 'Phone authorization revoked.')
                  }
                >
                  Revoke phone
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No Android phone paired with this delivery yet.</p>
      )}
      <p className="muted">
        Force-stop, disabled location, removed permissions, battery restrictions or
        powering off can interrupt tracking. Reopen YYC Driver to check and resume.
      </p>
    </section>
  );
}
