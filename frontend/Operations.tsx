import { useUiStore } from './stores/useUiStore';
import { useTracking } from './tracking';
import { useEffect, useRef, useState, type RefObject, type FormEvent } from 'react';
import { api } from './api';
import { useAppStore } from './stores/useAppStore';
import { Field } from './Field';
import { dataFrom } from './forms';
import { ActionForm } from './ActionForm';
import { prePickup, cargoStates } from '../shared/planning.js';
import type { Action, Shipment, User, Payload } from './types';
type Save = (work: () => Promise<unknown>, message: string) => Promise<void>;
const cad = (cents: number) =>
  new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(
    cents / 100,
  );
function useResource<T>(path: string, revision: unknown) {
  const [value, setValue] = useState<T | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<T>(path)
      .then((value) => {
        if (active) {
          setValue(value);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [path, revision]);
  return { value, error };
}
function Planning({ s }: { s: Shipment }) {
  return (
    <>
      <Field id="plan-date" name="date" label="Pickup date" type="date" value={s.date} />
      <label>
        Pickup window
        <select name="window" defaultValue={s.window}>
          {['09:00–12:00', '13:00–16:00', 'Flexible'].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      <Field
        id="plan-deadline"
        name="deliveryDeadline"
        label="Delivery deadline (Edmonton time)"
        type="datetime-local"
        value={s.deliveryDeadline}
        required={false}
      />
      <label>
        Estimated loading and route minutes
        <input
          name="estimatedMinutes"
          type="number"
          min="0"
          max="10080"
          step="1"
          defaultValue={s.estimatedMinutes || 0}
        />
      </label>
      <label>
        Travel buffer minutes
        <input
          name="travelBufferMinutes"
          type="number"
          min="0"
          max="10080"
          step="1"
          defaultValue={s.travelBufferMinutes || 0}
        />
      </label>
    </>
  );
}
export function WorkflowActions({
  s,
  user,
  busy,
  act,
}: {
  s: Shipment;
  user: User;
  busy: boolean;
  act: (action: Action, data?: Payload) => Promise<void>;
}) {
  const form = (action: Action, label: string, plan = false) => (
    <ActionForm
      owner={user.id}
      shipmentId={s.id}
      action={action}
      busy={busy}
      label={label}
      onSave={(data) =>
        act(
          action,
          plan
            ? {
                ...data,
                estimatedMinutes: Number(data.estimatedMinutes),
                travelBufferMinutes: Number(data.travelBufferMinutes),
              }
            : data,
        )
      }
    >
      {plan && <Planning s={s} />}
      {action === 'confirmReturn' ? (
        <>
          <Field id="return-pod" name="pod" label="Return receipt reference" />
          <Field id="return-recipient" name="recipient" label="Return received by" />
        </>
      ) : (
        <Field id={`${action}-reason`} name="reason" label="Reason" />
      )}
      {action === 'failDelivery' && (
        <Field id="failure-note" name="note" label="Attempt details" />
      )}
    </ActionForm>
  );
  return (
    <>
      {s.quoteExpiresAt && s.status === 'Quote ready' && (
        <p>Quotation expires {new Date(s.quoteExpiresAt).toLocaleString()}</p>
      )}
      {s.offerExpiresAt && s.offeredTo && (
        <p>Offer expires {new Date(s.offerExpiresAt).toLocaleString()}</p>
      )}
      {user.role === 'admin' && prePickup.includes(s.status) && (
        <details>
          <summary>Reschedule delivery</summary>
          <p>Requires fresh customer acceptance and clears current driver commitments.</p>
          {form('reschedule', 'Save new schedule', true)}
        </details>
      )}
      {user.role === 'driver' && s.driverId === user.id && s.status === 'In transit' && (
        <details>
          <summary>Delivery attempt failed</summary>
          {form('failDelivery', 'Record failed attempt')}
        </details>
      )}
      {user.role === 'admin' && s.status === 'Delivery failed' && (
        <details>
          <summary>Arrange redelivery</summary>
          {form('redeliver', 'Schedule redelivery', true)}
        </details>
      )}
      {user.role === 'admin' && ['In transit', 'Delivery failed'].includes(s.status) && (
        <details>
          <summary>Arrange cargo return</summary>
          {form('return', 'Arrange return')}
        </details>
      )}
      {s.status === 'Returning' && <p>Return cargo to: {s.returnDestination}</p>}
      {user.role === 'driver' &&
        s.driverId === user.id &&
        s.status === 'Returning' &&
        (!s.issue || s.issue.resolved) &&
        form('confirmReturn', 'Confirm cargo return')}
    </>
  );
}
export function DriverProfile({
  user,
  busy,
  save,
}: {
  user: User;
  busy: boolean;
  save: Save;
}) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = dataFrom(event.currentTarget);
    await save(
      () =>
        api('/api/driver-profile', 'PATCH', {
          ...data,
          version: user.version,
          liftgate: data.liftgate === 'on',
        }),
      'Profile saved. Material truck changes require reapproval.',
    );
  }
  return (
    <form key={user.version} onSubmit={submit}>
      <p>{user.profile.reviewReason}</p>
      <Field name="name" label="Driver name" value={user.name} />
      <Field name="phone" label="Contact phone" value={user.profile.phone} />
      <Field name="truck" label="Truck make and model" value={user.truck?.truck} />
      <Field name="plate" label="Truck plate" value={user.truck?.plate} />
      <label>
        Truck type
        <select name="type" defaultValue={user.truck?.type}>
          <option>Box truck</option>
          <option>Dry van</option>
        </select>
      </label>
      <Field
        name="kg"
        label="Payload capacity (kg)"
        type="number"
        value={user.truck?.kg}
      />
      <Field
        name="pallets"
        label="Pallet capacity"
        type="number"
        value={user.truck?.pallets}
      />
      <Field name="area" label="Service area" value={user.truck?.area} />
      <label>
        <input type="checkbox" name="liftgate" defaultChecked={user.truck?.liftgate} />{' '}
        Liftgate
      </label>
      <p>
        Material changes require broker reapproval. Finish or hand over live cargo before
        changing trucks.
      </p>
      <button className="btn" disabled={busy}>
        Save driver profile
      </button>
    </form>
  );
}
export function DriverReview({
  driver,
  busy,
  save,
}: {
  driver: User;
  busy: boolean;
  save: Save;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = dataFrom(event.currentTarget);
        void save(
          () =>
            api(`/api/drivers/${driver.id}/review`, 'POST', {
              ...data,
              version: driver.version,
            }),
          'Driver review recorded.',
        );
      }}
    >
      <label>
        Decision
        <select name="decision">
          <option value="approve">Approve</option>
          <option value="reject">Reject</option>
          <option value="revoke">Revoke approval</option>
        </select>
      </label>
      <Field id={`${driver.id}-review-reason`} name="reason" label="Review reason" />
      <button className="btn light" disabled={busy || driver.disabled}>
        Record review decision
      </button>
    </form>
  );
}
export function EvidenceFiles({
  s,
  user,
  busy,
  save,
}: {
  s: Shipment;
  user: User;
  busy: boolean;
  save: Save;
}) {
  const { value, error } = useResource<{ id: string; name: string; sha256: string }[]>(
    `/api/shipments/${s.id}/evidence`,
    s.version,
  );
  const [message, setMessage] = useState('');
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get('file') as File;
    if (!file || file.size === 0 || file.size > 2 * 1024 * 1024) {
      setMessage('Choose a nonempty PNG, JPEG, or PDF up to 2 MiB.');
      return;
    }
    setMessage('');
    const reader = new FileReader();
    reader.onerror = () => setMessage('Cannot read the selected file.');
    reader.onload = () => {
      const content = String(reader.result).split(',')[1];
      if (user.role === 'driver') {
        void useAppStore.getState().act(s.id, s.version, 'attachEvidence', {
          name: file.name,
          mime: file.type,
          content,
        });
        return;
      }
      void save(
        () =>
          api(`/api/shipments/${s.id}/evidence`, 'POST', {
            name: file.name,
            mime: file.type,
            content,
            version: s.version,
          }),
        'Evidence attached.',
      );
    };
    reader.readAsDataURL(file);
  }
  return (
    <section className="card">
      <h2>Evidence files</h2>
      {(error || message) && <p role="alert">{error || message}</p>}
      {value?.map((file) => (
        <p key={file.id}>
          <a href={`/api/evidence/${file.id}`}>{file.name}</a>
        </p>
      ))}
      {(user.role === 'admin' || (user.role === 'driver' && user.id === s.driverId)) && (
        <form onSubmit={upload}>
          <label>
            Photo, signature image, or document
            <input
              name="file"
              type="file"
              accept="image/png,image/jpeg,application/pdf"
              required
            />
          </label>
          <p>PNG, JPEG, or PDF; up to 2 MiB each and ten files per delivery.</p>
          <button className="btn light" disabled={busy}>
            Attach evidence file
          </button>
        </form>
      )}
    </section>
  );
}
export function BookingDraftControls({
  container,
  owner,
  busy,
  save,
}: {
  container: RefObject<HTMLDivElement | null>;
  owner: string;
  busy: boolean;
  save: Save;
}) {
  const [message, setMessage] = useState('');
  const workspace = useAppStore((state) => state.state);
  const { value, error } = useResource<{ data: Payload; version: number }>(
    `/api/booking-draft?owner=${encodeURIComponent(owner)}`,
    workspace,
  );
  function values() {
    const form = container.current?.querySelector('form');
    return form ? dataFrom(form) : {};
  }
  function restore() {
    const form = container.current?.querySelector('form');
    if (!form || !value) return;
    for (const [name, data] of Object.entries(value.data)) {
      const field = form.elements.namedItem(name);
      if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement)
        field.value = String(data);
    }
    setMessage('Saved draft restored. Review the details before submitting.');
  }
  return (
    <section className="notice">
      <p>Save an unfinished request to your account and resume it on another device.</p>
      {(error || message) && <p role="status">{error || message}</p>}
      <button
        type="button"
        className="btn light"
        disabled={busy || !value}
        onClick={() =>
          void save(async () => {
            await api('/api/booking-draft', 'PUT', {
              version: value?.version,
              data: values(),
            });
          }, 'Booking draft saved.')
        }
      >
        Save booking draft
      </button>
      {value && Object.keys(value.data).length > 0 && (
        <>
          <button type="button" className="btn light" disabled={busy} onClick={restore}>
            Restore saved draft
          </button>
          <button
            type="button"
            className="textbtn"
            disabled={busy}
            onClick={() =>
              void save(async () => {
                await api('/api/booking-draft', 'DELETE', { version: value.version });
              }, 'Draft discarded.')
            }
          >
            Discard draft
          </button>
        </>
      )}
    </section>
  );
}
interface Notice {
  id: string;
  shipmentId: string | null;
  message: string;
  createdAt: string;
  readAt: string | null;
  deliveryStatus: string;
  attempts: number;
}
function Notifications({
  busy,
  save,
  revision,
}: {
  busy: boolean;
  save: Save;
  revision: unknown;
}) {
  const { value, error } = useResource<Notice[]>('/api/notifications', revision);
  const shipments = useAppStore((state) => state.state?.shipments || []);
  return (
    <section className="card">
      <h2>Notifications</h2>
      <p role="alert">{error}</p>
      {value?.length === 0 && <p>No notifications.</p>}
      {value?.map((n) => (
        <article key={n.id}>
          <p>{n.message}</p>
          <small>
            {new Date(n.createdAt).toLocaleString()} · {n.deliveryStatus}
          </small>
          {n.shipmentId && shipments.some((s) => s.id === n.shipmentId) && (
            <button
              className="btn light"
              disabled={busy}
              onClick={() => {
                const ui = useUiStore.getState();
                ui.setPage('shipments');
                ui.select(n.shipmentId);
              }}
            >
              Open delivery {n.shipmentId}
            </button>
          )}
          {!n.readAt && (
            <button
              className="btn light"
              disabled={busy}
              onClick={() =>
                void save(
                  () => api(`/api/notifications/${n.id}/read`, 'POST', {}),
                  'Notification marked read.',
                )
              }
            >
              Mark read
            </button>
          )}
          {n.deliveryStatus === 'failed' && (
            <button
              className="btn light"
              disabled={busy}
              onClick={() =>
                void save(
                  () => api(`/api/notifications/${n.id}/retry`, 'POST', {}),
                  'Notification queued for retry.',
                )
              }
            >
              Retry delivery
            </button>
          )}
        </article>
      ))}
    </section>
  );
}
interface Invoice {
  id: string;
  shipmentId: string;
  version: number;
  totalCents: number;
  paidCents: number;
  dueCents: number;
  rateCents: number;
  payoutCents: number;
  entries: {
    id: string;
    kind: string;
    amountCents: number;
    reference: string;
    reason: string;
  }[];
}
function InvoiceCard({
  invoice: i,
  user,
  busy,
  save,
}: {
  invoice: Invoice;
  user: User;
  busy: boolean;
  save: Save;
}) {
  const request = useRef<{ fingerprint: string; key: string } | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = dataFrom(event.currentTarget),
      payload = { ...data, amount: Number(data.amount) };
    const fingerprint = JSON.stringify(payload);
    if (request.current?.fingerprint !== fingerprint)
      request.current = { fingerprint, key: crypto.randomUUID() };
    const key = request.current.key;
    await save(async () => {
      await api(`/api/invoices/${i.id}/entries`, 'POST', {
        ...payload,
        version: i.version,
        requestKey: key,
      });
      request.current = null;
    }, 'Financial entry recorded.');
  }
  return (
    <article className="card">
      <h2>{i.shipmentId}</h2>
      <p>{i.id}</p>
      <p>
        {user.role === 'driver' ? 'Agreed rate' : 'Invoice total'}:{' '}
        {cad(user.role === 'driver' ? i.rateCents : i.totalCents)} · Outstanding:{' '}
        {cad(i.dueCents)}
      </p>
      {user.role === 'admin' && (
        <p>
          Driver rate {cad(i.rateCents)} · Paid out {cad(i.payoutCents)}
        </p>
      )}
      {i.entries.map((e) => (
        <p key={e.id}>
          {e.kind}: {cad(e.amountCents)} · {e.reference} · {e.reason}
        </p>
      ))}
      {user.role === 'admin' && (
        <form onSubmit={submit}>
          <label>
            Entry type
            <select name="kind">
              {['payment', 'refund', 'adjustment', 'payout', 'payoutRefund'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            Amount (CAD)
            <input name="amount" type="number" step="0.01" required />
          </label>
          <Field
            id={`${i.id}-reference`}
            name="reference"
            label="Payment or adjustment reference"
          />
          <Field id={`${i.id}-reason`} name="reason" label="Reason" />
          <button className="btn" disabled={busy}>
            Record financial entry
          </button>
        </form>
      )}
    </article>
  );
}
function Billing({
  user,
  shipments,
  busy,
  save,
  revision,
}: {
  user: User;
  shipments: Shipment[];
  busy: boolean;
  save: Save;
  revision: unknown;
}) {
  const { value, error } = useResource<Invoice[]>(
    user.role === 'driver' ? '/api/settlements' : '/api/invoices',
    revision,
  );
  return (
    <>
      <p>
        CAD ledger for verified external payments and driver payouts. No money is
        transferred by this application.
      </p>
      <p role="alert">{error}</p>
      {user.role === 'admin' && (
        <section className="card">
          <h2>Issue invoice</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = dataFrom(event.currentTarget),
                s = shipments.find((s) => s.id === data.shipmentId);
              if (s)
                void save(
                  () =>
                    api('/api/invoices', 'POST', {
                      shipmentId: s.id,
                      version: s.version,
                      taxCents: Number(data.taxCents),
                    }),
                  'Invoice issued.',
                );
            }}
          >
            <label>
              Completed delivery
              <select name="shipmentId" required>
                <option value="">Choose a delivery or return</option>
                {shipments
                  .filter(
                    (s) =>
                      ['Delivered', 'Returned'].includes(s.status) &&
                      !value?.some((i) => i.shipmentId === s.id),
                  )
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.id}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Verified tax amount (cents)
              <input
                name="taxCents"
                type="number"
                min="0"
                max="1000000000"
                step="1"
                defaultValue="0"
                required
              />
            </label>
            <button className="btn" disabled={busy}>
              Issue invoice
            </button>
          </form>
        </section>
      )}
      {value?.map((i) => (
        <InvoiceCard key={i.id} invoice={i} user={user} busy={busy} save={save} />
      ))}
    </>
  );
}
function Reports({ accounts, revision }: { accounts: User[]; revision: unknown }) {
  const [query, setQuery] = useState('');
  const { value, error } = useResource<{
    summary: Record<string, number>;
    shipments: Shipment[];
  }>(`/api/reports?${query}`, revision);
  return (
    <section className="card">
      <h2>Delivery and financial reports</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          setQuery(
            new URLSearchParams(
              [...data.entries()].map(([key, value]) => [key, String(value)]),
            ).toString(),
          );
        }}
      >
        <Field name="from" label="Pickup date from" type="date" required={false} />
        <Field name="to" label="Pickup date to" type="date" required={false} />
        {['customer', 'driver'].map((role) => (
          <label key={role}>
            {role}
            <select name={role}>
              <option value="">All</option>
              {accounts
                .filter((a) => a.role === (role === 'customer' ? 'store' : 'driver'))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
        ))}
        <label>
          Status
          <input name="status" placeholder="All statuses" />
        </label>
        <button className="btn">Apply report filters</button>
      </form>
      <a href={`/api/reports?${query}&format=csv`}>Export CSV</a>
      <p role="alert">{error}</p>
      {value && (
        <>
          <dl>
            {Object.entries(value.summary).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{key.endsWith('Cents') ? cad(value) : value}</dd>
              </div>
            ))}
          </dl>
          {value.shipments.map((s) => (
            <p key={s.id}>
              {s.id} · {s.date} · {s.status} · {s.customer}
            </p>
          ))}
        </>
      )}
    </section>
  );
}
export function OperationsPage({
  page,
  user,
  shipments,
  accounts,
  busy,
  save,
  revision,
}: {
  page: string;
  user: User;
  shipments: Shipment[];
  accounts: User[];
  busy: boolean;
  save: Save;
  revision: unknown;
}) {
  if (page === 'notifications')
    return <Notifications busy={busy} save={save} revision={revision} />;
  if (page === 'billing')
    return (
      <Billing
        user={user}
        shipments={shipments}
        busy={busy}
        save={save}
        revision={revision}
      />
    );
  return <Reports accounts={accounts} revision={revision} />;
}

interface Tracking {
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  recordedAt?: string;
  eta?: string;
  etaUpdatedAt?: string;
}
export function LocationTracker({ s, user }: { s: Shipment; user: User }) {
  const [revision, setRevision] = useState(0),
    [error, setError] = useState('');
  const tracking = useTracking();
  const watching = tracking.owner === user.id && tracking.shipment === s.id;
  function setWatching(value: boolean) {
    if (value) tracking.start(user.id, s.id);
    else tracking.stop();
  }
  const { value, error: loadError } = useResource<Tracking>(
    `/api/shipments/${s.id}/tracking`,
    revision,
  );
  const active = ['Assigned', ...cargoStates].includes(s.status),
    assigned = user.role === 'driver' && s.driverId === user.id;
  useEffect(() => {
    const interval = setInterval(() => setRevision((v) => v + 1), 30000);
    return () => clearInterval(interval);
  }, []);
  return (
    <section className="card">
      <h2>Location and ETA</h2>
      {(error || loadError) && <p role="alert">{error || loadError}</p>}
      {value?.recordedAt ? (
        <>
          <p>
            Last shared: {new Date(value.recordedAt).toLocaleString()} · Accuracy ±
            {Math.round(value.accuracy || 0)} m
          </p>
          <a
            href={`https://www.openstreetmap.org/?mlat=${value.latitude}&mlon=${value.longitude}#map=15/${value.latitude}/${value.longitude}`}
            target="_blank"
            rel="noreferrer"
          >
            View last shared location on map
          </a>
        </>
      ) : (
        <p>No location has been shared.</p>
      )}
      {value?.eta && (
        <p>
          Estimated arrival: {new Date(value.eta).toLocaleString()} · Updated{' '}
          {value.etaUpdatedAt && new Date(value.etaUpdatedAt).toLocaleString()}
        </p>
      )}
      {assigned && active && (
        <>
          <p>
            Sharing continues while you navigate this workspace. Keep the app open; device
            locking or closing the browser may stop GPS updates. Locations refresh
            approximately every 30 seconds.
          </p>
          <button
            className="btn light"
            onClick={() => {
              if (!navigator.geolocation) {
                setError(
                  'Location sharing is unavailable on this device. Use a secure HTTPS connection.',
                );
                return;
              }
              setError('');
              setWatching(!watching);
            }}
          >
            {watching ? 'Stop sharing location' : 'Share current location'}
          </button>
        </>
      )}
      {active && (user.role === 'admin' || assigned) && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const eta = String(new FormData(event.currentTarget).get('eta') || '');
            void api(`/api/shipments/${s.id}/tracking`, 'PATCH', {
              eta: eta ? new Date(eta).toISOString() : '',
            })
              .then(() => {
                setRevision((v) => v + 1);
                setError('');
              })
              .catch((e) => setError(e.message));
          }}
        >
          <Field
            id="tracking-eta"
            name="eta"
            label="Estimated arrival (your local time)"
            type="datetime-local"
            required={false}
          />
          <button className="btn light">Update ETA</button>
        </form>
      )}
    </section>
  );
}
