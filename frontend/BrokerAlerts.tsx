import { useEffect, useRef, useState } from 'react';
import { api, getSessionRevision } from './api';
interface Alert {
  id: string;
  shipmentId: string;
  kind: string;
  message: string;
  acknowledgedAt: string | null;
}
export function BrokerAlerts({ onOpen }: { onOpen: (id: string) => void }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    let active = true,
      busy = false;
    const session = getSessionRevision();
    async function load() {
      if (busy) return;
      busy = true;
      try {
        const value = await api<{ alerts: Alert[] }>('/api/broker-alerts');
        if (active && session === getSessionRevision()) {
          setAlerts(value.alerts);
          setError('');
        }
      } catch {
        if (active) {
          setAlerts([]);
          setError('Delivery alerts could not refresh.');
        }
      } finally {
        busy = false;
      }
    }
    const refresh = () => void load();
    reload.current = refresh;
    void load();
    const timer = setInterval(refresh, 30000);
    window.addEventListener('online', refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('online', refresh);
    };
  }, []);
  async function acknowledge(id: string) {
    setPending(id);
    const session = getSessionRevision();
    try {
      const result = await api<Alert>(`/api/broker-alerts/${id}/acknowledge`, 'POST', {});
      if (session === getSessionRevision())
        setAlerts((items) => items.map((item) => (item.id === id ? result : item)));
    } catch {
      setError('Alert could not be acknowledged. Refresh to check its current state.');
      reload.current();
    } finally {
      setPending('');
    }
  }
  return (
    <section className="broker-alerts" aria-label="Broker delivery alerts">
      <div className="map-delivery-heading">
        <h3>Delivery alerts</h3>
        <button type="button" className="btn light" onClick={() => reload.current()}>
          Refresh delivery alerts
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!error && (
        <p>
          {alerts.filter((item) => !item.acknowledgedAt).length} need acknowledgment ·{' '}
          {alerts.length} active conditions
        </p>
      )}
      <ul className="broker-alert-list">
        {alerts.map((item) => (
          <li key={item.id} className="delivery-alert-item">
            <strong>{item.shipmentId}</strong>
            <p>{item.message}</p>
            <button
              type="button"
              className="btn light"
              onClick={() => onOpen(item.shipmentId)}
            >
              Review delivery
            </button>
            <button
              type="button"
              className="btn light"
              disabled={!!item.acknowledgedAt || !!pending}
              onClick={() => void acknowledge(item.id)}
            >
              {item.acknowledgedAt
                ? 'Acknowledged'
                : pending === item.id
                  ? 'Acknowledging…'
                  : 'Acknowledge alert'}
            </button>
          </li>
        ))}
      </ul>
      <p className="muted">
        Acknowledging records that a broker has seen the alert; it does not resolve the
        delivery issue.
      </p>
    </section>
  );
}
