import {
  StrictMode,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';
import { Journey, RecipientTracking, DriverTracking, OfflinePanel } from './Mobility';
import { driverBlockers, nextStep } from './workflow';
import { WorkflowGuide, AttentionQueue, DispatchReadiness } from './WorkflowGuide';
import { NativeTracking } from './NativeTracking';
import { api, setCsrf } from './api';
import { Field } from './Field';
import { ActionForm } from './ActionForm';
import { eligibleActionDrafts } from './actionDrafts';
import { dataFrom } from './forms';
import { DeliveryEvidence } from './DeliveryEvidence';
import { locationStatus } from './locationStatus';
import { LiveMapView } from './LiveMapView';
import { AvailabilityForm } from './Availability';
import { SavedAddressesForm } from './SavedAddresses';
import { trailFromHistory, type TrailPoint } from './locationTrail';
import { Setup } from './Setup';
import { CustomerRequests } from './CustomerRequests';
import { RateChange } from './RateChange';
import { useWorkspaceSync } from './useWorkspaceSync';
import { ErrorBoundary } from './ErrorBoundary';
import { AiAssist } from './AiAssist';
import { Accounts } from './Accounts';
import { RecoveryRequest, ResetPassword } from './Recovery';
import { createBooking } from './booking';
import {
  LocationTracker,
  WorkflowActions,
  DriverProfile,
  DriverReview,
  EvidenceFiles,
  BookingDraftControls,
  OperationsPage,
} from './Operations';
import {
  prePickup,
  cargoStates,
  canRecordArrival,
  nextIntermediateStop,
  pickupDatePassed,
} from '../shared/planning.js';
import { canTakeCargo, driverVehicleBlockers } from '../shared/scheduling.js';
import { useAppStore } from './stores/useAppStore';
import { useUiStore } from './stores/useUiStore';
import type { Action, Payload, Shipment, User } from './types';
import './base.css';
import './react.css';

const money = (value?: number | null) =>
  value == null
    ? 'Pending'
    : new Intl.NumberFormat('en-CA', {
        style: 'currency',
        currency: 'CAD',
      }).format(value);
function Logo() {
  return (
    <div className="logo brandlogo">
      <img src="/assets/yyc-brokers-logo.jpg" alt="YYC Brokers" width="88" height="88" />
      <span className="brandword">
        YYC BROKERS<small>TRUCKING & DELIVERY</small>
      </span>
    </div>
  );
}
function Select({
  name,
  label,
  values,
}: {
  name: string;
  label: string;
  values: string[];
}) {
  return (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      <select id={name} name={name}>
        {values.map((v) => (
          <option key={v}>{v}</option>
        ))}
      </select>
    </div>
  );
}
function Badge({ status }: { status: string }) {
  return (
    <span
      className={`tag status-badge ${['Delivered', 'Approved', 'Returned'].includes(status) ? 'green' : ['Delivery failed', 'Cancelled'].includes(status) ? 'status-danger' : ['In transit', 'Assigned'].includes(status) ? 'status-blue' : 'amber'}`}
    >
      <span className="badge-dot" aria-hidden="true" />
      {status}
    </span>
  );
}
function Route({ shipment: s }: { shipment: Shipment }) {
  return (
    <div className="route">
      <div>
        <small>Pickup</small>
        <b>{s.pickup}</b>
      </div>
      <span aria-hidden="true">↓</span>
      <div>
        <small>Delivery</small>
        <b>{s.destination}</b>
      </div>
    </div>
  );
}
function LiveMap({
  shipments,
  selectedId,
}: {
  shipments: Shipment[];
  selectedId: string | null;
}) {
  const [revision, setRevision] = useState(0);
  const [tracking, setTracking] = useState<{
    latitude?: number;
    longitude?: number;
    accuracy?: number;
    recordedAt?: string;
    eta?: string;
    driverId?: string;
  } | null>(null);
  const [history, setHistory] = useState<TrailPoint[] | undefined>(undefined);

  const activeShipments = shipments.filter(
    (s) =>
      s.driverId &&
      ['Assigned', 'In transit', 'Delivery failed', 'Returning'].includes(s.status),
  );
  const target =
    shipments.find((s) => s.id === selectedId && s.driverId) ??
    activeShipments[0] ??
    null;

  useEffect(() => {
    if (!target) {
      setTracking(null);
      setHistory(undefined);
      return;
    }
    let cancelled = false;
    void api<typeof tracking>(`/api/shipments/${target.id}/tracking`)
      .then((v) => {
        if (!cancelled) setTracking(v);
      })
      .catch(() => {});
    void api<{ points: { latitude: number; longitude: number }[] }>(
      `/api/shipments/${target.id}/tracking/history`,
    )
      .then((v) => {
        if (!cancelled) setHistory(trailFromHistory(v.points));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [target?.id, target?.version, revision]);

  useEffect(() => {
    const timer = setInterval(() => setRevision((v) => v + 1), 30000);
    return () => clearInterval(timer);
  }, []);

  const status = locationStatus(tracking, target?.driverId, Date.now());

  if (!target) {
    return (
      <div className="unconnectedmap">
        <h2>Live delivery map</h2>
        <p>
          {activeShipments.length
            ? 'Select an active delivery to see where its driver is.'
            : 'Open a delivery to view its location, milestones, and ETA.'}
        </p>
      </div>
    );
  }

  if (status.state === 'none' || status.state === 'previous-driver') {
    return (
      <div className="unconnectedmap">
        <h2>Live delivery map</h2>
        <p>{status.message}</p>
        <p className="small">
          Delivery {target.id}. The map appears once the assigned driver shares a
          location:
        </p>
        <ol className="map-steps">
          <li>
            The driver opens this delivery and presses <b>Share current location</b>, or
            pairs the YYC Driver app.
          </li>
          <li>
            They allow location permission. The workspace must be opened over HTTPS.
          </li>
          <li>The first point appears here within about 30 seconds.</li>
        </ol>
        {!window.isSecureContext && (
          <p className="notice">
            This page is not secure (not HTTPS), so phone browsers will not share
            location.
          </p>
        )}
        <button className="btn light" onClick={() => setRevision((v) => v + 1)}>
          Check again
        </button>
      </div>
    );
  }

  const lat = tracking!.latitude!;
  const lon = tracking!.longitude!;
  const openUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`;

  return (
    <div className="livemap">
      <div className="livemap-header">
        <span className="livemap-beacon" aria-hidden="true">
          ◎
        </span>
        <div>
          <strong>Live location · {target.id}</strong>
          <span className="livemap-status">
            {status.message}
            {tracking!.recordedAt
              ? ` · ${new Date(tracking!.recordedAt).toLocaleTimeString()}`
              : ''}
            {tracking!.eta &&
            !['Delivered', 'Returned', 'Cancelled'].includes(target.status)
              ? ` · ETA ${new Date(tracking!.eta).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
              : ''}
          </span>
        </div>
        <a href={openUrl} target="_blank" rel="noreferrer" className="livemap-link">
          Open full map ↗
        </a>
      </div>
      <LiveMapView
        key={target.id}
        history={history}
        latitude={lat}
        longitude={lon}
        accuracy={tracking!.accuracy}
        stale={status.state === 'stale'}
        title={`Live location for ${target.id}`}
      />
      {status.state === 'stale' && (
        <p className="notice livemap-stale" role="status">
          The position below may be out of date. Ask the driver to check that sharing is
          on.
        </p>
      )}
      <div className="livemap-footer">
        <span>±{Math.round(tracking!.accuracy ?? 0)} m accuracy</span>
        <span>
          {lat.toFixed(5)}, {lon.toFixed(5)}
        </span>
        <span>
          {target.pickup} → {target.destination}
        </span>
      </div>
      <p className="small">
        Map tiles not loading? Use <b>Open full map ↗</b> above, or the coordinates shown
        here.
      </p>
    </div>
  );
}
function Form({
  children,
  onSave,
  label,
  busy,
}: {
  children: ReactNode;
  onSave: (data: Payload) => void | Promise<void>;
  label: string;
  busy: boolean;
}) {
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void onSave(dataFrom(e.currentTarget));
  }
  return (
    <form onSubmit={submit}>
      {children}
      <button className="btn" disabled={busy}>
        {busy ? 'Saving…' : label}
      </button>
    </form>
  );
}
function Auth({
  onLogin,
  notify,
}: {
  onLogin: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const [setupRequired, setSetupRequired] = useState(false);
  const [setup, setSetup] = useState(false);
  useEffect(() => {
    let active = true;
    void api<{ required: boolean }>('/api/setup')
      .then((result) => {
        if (active) setSetupRequired(result.required);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const [forgot, setForgot] = useState(false);
  const [register, setRegister] = useState(false),
    [role, setRole] = useState('store'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(data: Payload) {
    setBusy(true);
    setError('');
    try {
      if (register) {
        if (data.password !== data.confirm) throw new Error('Passwords must match.');
        delete data.confirm;
        await api('/api/register', 'POST', {
          ...data,
          role,
          liftgate: data.liftgate === 'on',
        });
        setRegister(false);
        notify(
          role === 'driver'
            ? 'Driver account created. Log in and wait for broker approval before accepting jobs.'
            : 'Account created. Log in with your email and password.',
        );
      } else {
        const result = await api<{ csrf: string }>('/api/login', 'POST', data);
        setCsrf(result.csrf);
        await onLogin();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cannot connect to server.');
    } finally {
      setBusy(false);
    }
  }
  if (setup)
    return (
      <Setup
        back={(created) => {
          if (created)
            notify('Broker account created. Log in with your email and password.');
          setSetup(false);
          void api<{ required: boolean }>('/api/setup').then((result) =>
            setSetupRequired(result.required),
          );
        }}
      />
    );
  if (forgot) return <RecoveryRequest back={() => setForgot(false)} />;
  return (
    <div className="auth">
      <section className="hero">
        <Logo />
        <div>
          <div className="eyebrow">YYC BROKERS</div>
          <h1>
            Your goods.
            <br />
            Your drivers.
            <br />
            <span>One workspace.</span>
          </h1>
          <p>Manage transport requests, quotations, assignments and delivery evidence.</p>
        </div>
        <div className="herofoot">
          <span>Request</span>
          <span>Assign</span>
          <span>Deliver</span>
        </div>
      </section>
      <section className="authright">
        <header>
          <span>YYC WORKSPACE</span>
        </header>
        <div className="authbox">
          <h1>{register ? 'Create your YYC account.' : 'Log in to your workspace.'}</h1>
          <p className="muted">
            Store owners, drivers and brokers use their own email and password.
          </p>
          {setupRequired && (
            <section className="auth-setup-notice">
              <div className="auth-setup-icon" aria-hidden="true">
                ⚙
              </div>
              <div>
                <strong>Workspace setup required</strong>
                <p>
                  Create a broker account to start approving drivers and dispatching
                  deliveries.
                </p>
              </div>
              <button className="btn" onClick={() => setSetup(true)}>
                Set up broker account
              </button>
            </section>
          )}
          <div className="switch">
            <button
              disabled={busy}
              className={!register ? 'selected' : ''}
              onClick={() => {
                setRegister(false);
                setError('');
              }}
            >
              Log in
            </button>
            <button
              disabled={busy}
              className={register ? 'selected' : ''}
              onClick={() => {
                setRegister(true);
                setError('');
              }}
            >
              Register
            </button>
          </div>
          {register && (
            <div className="roles">
              {['store', 'driver'].map((r) => (
                <button
                  disabled={busy}
                  key={r}
                  className={`role ${role === r ? 'selected' : ''}`}
                  onClick={() => setRole(r)}
                >
                  {r === 'store' ? 'Store owner' : 'Driver / truck owner'}
                </button>
              ))}
            </div>
          )}
          <div key={`${register}-${role}`}>
            <Form
              onSave={submit}
              busy={busy}
              label={register ? 'Create account' : 'Log in'}
            >
              {register && (
                <>
                  <Field
                    name="name"
                    label={role === 'store' ? 'Store / business name' : 'Full name'}
                  />
                  <Field name="phone" label="Contact phone" type="tel" />
                </>
              )}
              <Field name="email" label="Email address" type="email" />
              <Field name="password" label="Password" type="password" />
              {register && (
                <Field name="confirm" label="Confirm password" type="password" />
              )}
              {register && role === 'store' && (
                <>
                  <Field name="address" label="Store delivery address" />
                  <Field name="contact" label="Receiving contact" />
                </>
              )}
              {register && role === 'driver' && (
                <>
                  <h2>Register your truck</h2>
                  <Field name="truck" label="Truck make and model" />
                  <Field name="plate" label="Plate / unit reference" />
                  <Select
                    name="type"
                    label="Truck type"
                    values={['Box truck', 'Dry van']}
                  />
                  <Field
                    name="licenceExpires"
                    label="Driver licence expiry"
                    type="date"
                    required={false}
                  />
                  <Field
                    name="insuranceExpires"
                    label="Insurance expiry"
                    type="date"
                    required={false}
                  />
                  <Field
                    name="inspectionExpires"
                    label="Vehicle inspection expiry"
                    type="date"
                    required={false}
                  />
                  <div className="grid2">
                    <Field name="kg" label="Payload capacity (kg)" type="number" />
                    <Field name="pallets" label="Pallet capacity" type="number" />
                  </div>
                  <Field name="area" label="Service area" />
                  <label className="checkrow">
                    <input type="checkbox" name="liftgate" />
                    Truck has a liftgate
                  </label>
                </>
              )}
              <p className="error" role="alert">
                {error}
              </p>
            </Form>
          </div>
          <button className="textbtn" disabled={busy} onClick={() => setForgot(true)}>
            Forgot password?
          </button>
          <div className="notice">
            Accounts and delivery changes are saved on this server. Driver accounts
            require broker approval. Drivers require approval before accepting jobs.
          </div>
        </div>
      </section>
    </div>
  );
}
function Booking({
  user,
  busy,
  save,
  saveWork,
}: {
  user: User;
  busy: boolean;
  saveWork: (work: () => Promise<unknown>, message: string) => Promise<void>;
  save: (data: Payload) => Promise<void>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [aiFields, setAiFields] = useState<Record<string, unknown>>({});
  const [aiText, setAiText] = useState('');
  return (
    <div ref={container}>
      <section className="card ai-booking-assist">
        <h2>AI booking assistant</h2>
        <p className="muted">Describe the shipment in plain language and let AI fill the form.</p>
        <textarea
          className="ai-booking-textarea"
          value={aiText}
          onChange={(e) => setAiText(e.target.value)}
          placeholder="e.g. 10 pallets downtown Friday morning liftgate required, 500kg dry goods"
          rows={3}
        />
        <AiAssist<{ fields: Record<string, unknown> }>
          label="Parse with AI"
          endpoint="/api/ai/booking-parse"
          method="POST"
          body={{ text: aiText }}
        >
          {(result) => (
            <div>
              <ul className="ai-field-list">
                {Object.entries(result.fields).map(([k, v]) => (
                  <li key={k}><strong>{k}</strong>: {String(v)}</li>
                ))}
              </ul>
              <button type="button" className="btn light small" onClick={() => setAiFields(result.fields)}>
                Apply to form
              </button>
            </div>
          )}
        </AiAssist>
      </section>
      <section className="card wizard">
        <h2>Request a delivery</h2>
        <Form busy={busy} label="Submit delivery request" onSave={save}>
          <div className="grid2">
            <Field name="pickup" label="Pickup address" list="saved-addresses" />
            <datalist id="saved-addresses">
              {(user.profile.savedAddresses ?? []).map((a) => (
                <option key={a.label} value={a.address} label={a.label} />
              ))}
            </datalist>
            <Field
              name="destination"
              label="Delivery address"
              list="saved-addresses"
              value={user.profile.address}
            />
            <Field name="date" label="Pickup date" type="date" value={aiFields.date as string | undefined} />
            <Select
              name="window"
              label="Pickup window"
              values={['09:00–12:00', '13:00–16:00', 'Flexible']}
            />
            <Field name="goods" label="Goods / cargo" value={aiFields.goods as string | undefined} />
            <Select name="type" label="Vehicle type" values={['Box truck', 'Dry van']} />
            <Field name="kg" label="Weight (kg)" type="number" value={aiFields.kg as string | undefined} />
            <Field name="pallets" label="Pallet count" type="number" value={aiFields.pallets as string | undefined} />
            <Select
              name="unloading"
              label="Unloading requirements"
              values={['Store has a loading dock', 'Liftgate required']}
            />
            <Field name="pickupContact" label="Pickup contact" />
            <Field
              name="receivingContact"
              label="Receiving contact"
              value={user.profile.contact}
            />
            <Field name="hours" label="Receiving hours" />
            <Field name="appointment" label="Appointment reference" required={false} />
            <Field name="cargoNotes" label="Cargo details" required={false} />
          </div>
          <Field
            name="deliveryDeadline"
            label="Delivery deadline (Edmonton time)"
            type="datetime-local"
            required={false}
          />
          <Field name="notes" label="Additional instructions" required={false} />
        </Form>
      </section>
      <BookingDraftControls
        container={container}
        owner={user.id}
        busy={busy}
        save={saveWork}
      />
    </div>
  );
}
const emptyEvidence = { pod: '', recipient: '' };
function Actions({
  s,
  user,
  drivers,
  busy,
  act,
  shipments,
}: {
  shipments: Shipment[];
  s: Shipment;
  user: User;
  drivers: User[];
  busy: boolean;
  act: (action: Action, data?: Payload) => Promise<void>;
}) {
  const draft = useUiStore((state) =>
    state.draftOwner === user.id
      ? state.deliveryDrafts[s.id] || emptyEvidence
      : emptyEvidence,
  );
  const setDraft = useUiStore((state) => state.setDeliveryDraft);
  const missedPickup = prePickup.includes(s.status) && pickupDatePassed(s);
  const pendingStop = s.status === 'In transit' && nextIntermediateStop(s);
  const availableDrivers = drivers.filter(
    (driver) => driver.id !== s.driverId && !driverBlockers(s, driver, shipments).length,
  );
  const button = (action: Action, label: string, blocked = false) => (
    <button
      className="btn light"
      disabled={busy || blocked}
      onClick={() => void act(action)}
    >
      {label}
    </button>
  );
  const form = (
    action: Action,
    label: string,
    children: ReactNode,
    draftScope?: string,
  ) => (
    <ActionForm
      owner={user.id}
      shipmentId={s.id}
      action={action}
      draftScope={draftScope}
      busy={busy}
      label={label}
      onSave={(data) => act(action, data)}
    >
      {children}
    </ActionForm>
  );
  const active = ['Assigned', ...cargoStates].includes(s.status);
  return (
    <div className="actionforms">
      {user.role === 'admin' && (
        <>
          {s.status === 'Awaiting quote' &&
            !missedPickup &&
            form(
              'quote',
              'Issue quotation',
              <div className="grid2">
                <Field name="price" label="Customer quote (CAD)" type="number" />
                <Field name="rate" label="Driver rate (CAD)" type="number" />
              </div>,
            )}
          {['Quote ready', 'Ready to assign', 'Offered', 'Assigned'].includes(
            s.status,
          ) && (
            <details>
              <summary>Correct quotation</summary>
              <p className="notice">
                Keeps shipment details and archives the previous quotation. The store must
                accept again; current offers and assignments are cleared.
              </p>
              {form(
                'requote',
                'Issue corrected quotation',
                <>
                  <Field
                    id="requote-price"
                    name="price"
                    label="Corrected customer quote (CAD)"
                    type="number"
                    value={s.price ?? undefined}
                  />
                  <Field
                    id="requote-rate"
                    name="rate"
                    label="Corrected driver rate (CAD)"
                    type="number"
                    value={s.rate ?? undefined}
                  />
                  <Field
                    id="requote-reason"
                    name="reason"
                    label="Reason for quotation correction"
                  />
                </>,
              )}
            </details>
          )}
          {active &&
            s.driverId &&
            (s.handover && s.offeredTo ? (
              <section>
                <p>
                  Handover offered to{' '}
                  {drivers.find((d) => d.id === s.offeredTo)?.name || s.offeredTo}. The
                  current driver remains assigned until the replacement accepts.
                </p>
                {form(
                  'withdrawHandover',
                  'Withdraw handover offer',
                  <Field
                    id="withdraw-handover-reason"
                    name="reason"
                    label="Reason for withdrawing handover"
                  />,
                )}
              </section>
            ) : (
              !missedPickup && (
                <details>
                  <summary>Arrange driver handover</summary>
                  <p className="notice">
                    Keeps the shipment and accepted quote. The replacement must accept
                    before responsibility transfers. A picked-up delivery remains in
                    transit.
                  </p>
                  {form(
                    'handover',
                    'Offer handover',
                    <>
                      <div className="field">
                        <label htmlFor="handover-driver">Replacement driver</label>
                        <select id="handover-driver" name="driverId" required>
                          <option value="">Choose a replacement driver</option>
                          {availableDrivers.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name} · {d.truck?.plate}
                            </option>
                          ))}
                        </select>
                      </div>
                      <Field
                        id="handover-reason"
                        name="reason"
                        label="Reason for driver handover"
                      />
                    </>,
                  )}
                </details>
              )
            ))}
          {s.status === 'Offered' && s.offeredTo && (
            <details>
              <summary>Withdraw job offer</summary>
              {form(
                'withdrawOffer',
                'Withdraw offer',
                <Field
                  id="withdraw-offer-reason"
                  name="reason"
                  label="Reason for withdrawing offer"
                />,
                `${s.offeredTo}:${s.offerExpiresAt}`,
              )}
            </details>
          )}
          {s.status === 'Ready to assign' &&
            !missedPickup &&
            form(
              'offer',
              'Send job offer',
              <div className="field">
                <DispatchReadiness s={s} drivers={drivers} shipments={shipments} />
                <AiAssist<{ driverId: string; reason: string; alternatives: { driverId: string; reason: string }[] }>
                  label="AI dispatch recommendation"
                  endpoint="/api/ai/dispatch-recommend"
                  method="POST"
                  body={{ shipmentId: s.id }}
                >
                  {(result) => (
                    <div className="ai-dispatch-result">
                      <p><strong>Recommended:</strong> {drivers.find((d) => d.id === result.driverId)?.name || result.driverId} — {result.reason}</p>
                      {result.alternatives?.length > 0 && (
                        <details><summary>Alternatives</summary>
                          {result.alternatives.map((a) => (
                            <p key={a.driverId}>{drivers.find((d) => d.id === a.driverId)?.name || a.driverId} — {a.reason}</p>
                          ))}
                        </details>
                      )}
                    </div>
                  )}
                </AiAssist>
                <label htmlFor="driverId">Approved suitable driver</label>
                <select id="driverId" name="driverId" required>
                  <option value="">Choose a driver</option>
                  {availableDrivers.map((driver) => (
                    <option key={driver.id} value={driver.id}>
                      {driver.name} · {driver.truck?.plate}
                    </option>
                  ))}
                </select>
              </div>,
            )}
          {s.issue &&
            !s.issue.resolved &&
            (<>
              {form(
                'resolve',
                'Resolve exception',
                <Field name="resolution" label="Resolution" />,
              )}
              <AiAssist<{ suggestions: { action: string; reason: string; detail: string }[] }>
                label="AI exception suggestions"
                endpoint="/api/ai/exception-suggest"
                method="POST"
                body={{ shipmentId: s.id }}
              >
                {(result) => (
                  <ul className="ai-suggestions">
                    {result.suggestions.map((s, i) => (
                      <li key={i} className="ai-suggestion-item">
                        <strong>{s.action}</strong> — {s.reason}
                        {s.detail && <p>{s.detail}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </AiAssist>
            </>)}
          {prePickup.includes(s.status) && (
            <details>
              <summary>Revise shipment</summary>
              <p className="notice">
                A material change archives the quote and clears quote acceptance and
                assignment.
              </p>
              {form(
                'change',
                'Save revision',
                <>
                  <Field name="destination" label="Destination" value={s.destination} />
                  <Field name="kg" label="Weight (kg)" type="number" value={s.kg} />
                  <Field name="pallets" label="Pallets" type="number" value={s.pallets} />
                  <Field name="reason" label="Reason for change" />
                </>,
              )}
            </details>
          )}
          {prePickup.includes(s.status) && button('cancel', 'Cancel delivery')}
        </>
      )}
      {user.role === 'store' && (
        <>
          {s.status === 'Quote ready' &&
            button('acceptQuote', 'Accept quotation', missedPickup)}
          {['Awaiting quote', 'Quote ready'].includes(s.status) &&
            button('cancel', 'Cancel request')}
        </>
      )}
      {user.role === 'driver' && (
        <>
          {(s.status === 'Offered' || (active && s.handover)) &&
            s.offeredTo === user.id && (
              <>
                {button(
                  'acceptJob',
                  s.handover ? 'Accept handover' : 'Accept job',
                  missedPickup || !!driverBlockers(s, user, shipments).length,
                )}
                {button('decline', s.handover ? 'Decline handover' : 'Decline offer')}
                {s.issue && !s.issue.resolved && (
                  <p className="notice">
                    Accepting responsibility does not resolve the open exception. Pickup,
                    stop completion, delivery, and return completion remain on hold until
                    the broker records a resolution.
                  </p>
                )}
              </>
            )}
          {active && s.driverId === user.id && (
            <>
              {!s.arrivedAt &&
                canRecordArrival(s) &&
                button('arrival', 'Record arrival', missedPickup)}
              {s.status === 'Assigned' &&
                button(
                  'pickup',
                  'Confirm pickup',
                  missedPickup ||
                    !s.arrivedAt ||
                    !!driverVehicleBlockers(s, user).length ||
                    !canTakeCargo(s.id, shipments, user.id) ||
                    !!(s.issue && !s.issue.resolved),
                )}
              {s.status === 'Assigned' && s.issue && !s.issue.resolved && (
                <p className="notice">
                  Resolve the open exception before collecting the load.
                </p>
              )}
              {s.status === 'Assigned' && !canTakeCargo(s.id, shipments, user.id) && (
                <p className="notice">
                  Finish or arrange handover of your current live load before collecting
                  another one.
                </p>
              )}
              {s.status === 'In transit' &&
                (!s.issue || s.issue.resolved) &&
                !pendingStop && (
                  <DeliveryEvidence
                    draft={draft}
                    onChange={(next) => setDraft(user.id, s.id, next)}
                    onSave={(data) => act('deliver', { ...data })}
                    busy={busy}
                    arrived={!!s.arrivedAt}
                    evidenceCount={s.evidenceCount || 0}
                  />
                )}

              {(!s.issue || s.issue.resolved) && (
                <details>
                  <summary>Report an issue</summary>
                  {form(
                    'issue',
                    'Report issue',
                    <>
                      <Field name="reason" label="Issue" />
                      <Field name="note" label="Issue details" />
                    </>,
                  )}
                </details>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
function Delivery({
  s,
  user,
  drivers,
  busy,
  act,
  close,
  shipments,
  openBilling,
}: {
  shipments: Shipment[];
  s: Shipment;
  user: User;
  drivers: User[];
  busy: boolean;
  act: (action: Action, data?: Payload) => Promise<void>;
  close: () => void;
  openBilling: (id: string) => void;
}) {
  const container = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    container.current?.focus();
    function key(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab') {
        const elements = Array.from(
          container.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input, select, summary, [tabindex="0"]',
          ) || [],
        ).filter((el) => el.getClientRects().length);
        const first = elements[0],
          last = elements.at(-1);
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === container.current)
        ) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', key);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', key);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [close]);
  return (
    <div
      className="drawer"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className="drawerbody"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delivery-title"
        tabIndex={-1}
        ref={container}
      >
        <div className="row between">
          <h1 id="delivery-title">{s.id}</h1>
          <button className="close" aria-label="Close delivery" onClick={close}>
            ×
          </button>
        </div>
        <Badge status={s.status} />
        <p>{s.customer}</p>
        <WorkflowGuide
          s={s}
          user={user}
          shipments={shipments}
          openBilling={openBilling}
        />
        <Route shipment={s} />
        <section className="card">
          <h2>{s.goods}</h2>
          <p>
            {s.date} · {s.window}
            {s.redeliveryPlan && (
              <>
                <br />
                Redelivery: {s.redeliveryPlan.date} · {s.redeliveryPlan.window}
              </>
            )}
            <br />
            {s.pallets} pallets · {s.kg} kg · {s.type}
            <br />
            {s.unloading}
          </p>
          <p>
            Pickup contact: {s.pickupContact}
            <br />
            Receiving contact: {s.receivingContact}
            <br />
            Receiving hours: {s.hours}
          </p>
          {s.appointment && <p>Appointment: {s.appointment}</p>}
          <p>{s.cargoNotes}</p>
          <p>{s.notes}</p>
          <p>Driver: {s.driverName || 'Not assigned'}</p>
          {s.arrivedAt && <p>Arrival recorded at {s.arrivedAt}</p>}
          <p>
            Quotation v{s.quoteVersion} ·{' '}
            {money(user.role === 'driver' ? s.rate : s.price)}
          </p>
          {user.role === 'admin' && <p>Driver rate: {money(s.rate)}</p>}
        </section>
        {s.issue && (
          <section className="notice">
            <h2>{s.issue.resolved ? 'Resolved exception' : 'Open exception'}</h2>
            <p>
              {s.issue.reason}: {s.issue.note}
            </p>
            <p>{s.issue.resolution}</p>
          </section>
        )}
        <section className="card" key={`${s.id}-${s.version}`}>
          <h2>Next action</h2>
          <Actions
            shipments={shipments}
            s={s}
            user={user}
            drivers={drivers}
            busy={busy}
            act={act}
          />
        </section>
        <CustomerRequests s={s} user={user} busy={busy} act={act} />
        <RateChange s={s} user={user} busy={busy} act={act} />
        <WorkflowActions s={s} user={user} busy={busy} act={act} />
        <Journey key={`${user.id}:${s.id}`} s={s} user={user} />
        <LocationTracker key={s.driverId} s={s} user={user} />
        <NativeTracking s={s} user={user} />
        <EvidenceFiles s={s} user={user} busy={busy} save={useAppStore.getState().save} />
        {s.deliveryDeadline && (
          <p>Delivery deadline: {s.deliveryDeadline} (Edmonton time)</p>
        )}
        {s.failedAttempts?.map((attempt, index) => (
          <p key={index}>
            Failed attempt {index + 1}: {attempt.reason} · {attempt.note}
          </p>
        ))}
        {s.returnPod && (
          <p>
            Return receipt: {s.returnPod} · {s.returnRecipient}
          </p>
        )}
        {s.pod && (
          <section className="card">
            <h2>Delivery evidence</h2>
            <p>
              {s.pod} · Received by {s.recipient}
            </p>
          </section>
        )}
        {!!s.quoteArchive?.length && (
          <section className="card">
            <h2>Previous quotations</h2>
            {s.quoteArchive.map((q) => (
              <div key={q.version}>
                <p>
                  v{q.version} · {money(user.role === 'driver' ? q.rate : q.price)} ·{' '}
                  {q.reason}
                </p>
                {q.pickup && (
                  <ol>
                    <li>Pickup: {q.pickup}</li>
                    {q.stops?.map((stop, i) => (
                      <li key={i}>
                        {stop.kind === 'pickup' ? 'Pickup' : 'Drop-off'}: {stop.address}
                        {stop.contact && ` · ${stop.contact}`}
                      </li>
                    ))}
                    <li>Delivery: {q.destination}</li>
                  </ol>
                )}
              </div>
            ))}
          </section>
        )}
        <section className="card">
          <h2>AI summary</h2>
          <AiAssist<{ summary: string }>
            label="Summarize this delivery"
            endpoint={`/api/ai/shipment-summary/${s.id}`}
          >
            {(result) => <p>{result.summary}</p>}
          </AiAssist>
        </section>
        <section className="card">
          <h2>Activity history</h2>
          {s.history.map((h, i) => (
            <div className="activity" key={i}>
              <div>
                {h.text}
                <small>
                  {h.actor} · {new Date(h.time).toLocaleString()}
                </small>
              </div>
            </div>
          ))}
        </section>
      </section>
    </div>
  );
}
function App() {
  const [recoveryToken] = useState(
    () => new URLSearchParams(window.location.hash.slice(1)).get('token') || '',
  );
  const recoveryMode =
    recoveryToken !== '' ||
    new URLSearchParams(window.location.search).get('reset') === '1';
  useWorkspaceSync();
  const assignmentAlert = useAppStore((s) => s.assignmentAlert);
  const syncError = useAppStore((s) => s.syncError);
  const refreshVersion = useAppStore((s) => s.refreshVersion);
  const state = useAppStore((s) => s.state);
  const loading = useAppStore((s) => s.loading);
  const bootError = useAppStore((s) => s.bootError);
  const busy = useAppStore((s) => s.busy);
  const message = useAppStore((s) => s.message);
  const boot = useAppStore((s) => s.boot);
  const refresh = useAppStore((s) => s.refresh);
  const run = useAppStore((s) => s.run);
  const save = useAppStore((s) => s.save);
  const needsRefresh = useAppStore((s) => s.needsRefresh);
  const refreshReason = useAppStore((s) => s.refreshReason);
  const act = useAppStore((s) => s.act);
  const logout = useAppStore((s) => s.logout);
  const setMessage = useAppStore((s) => s.setMessage);
  const clearMessage = useAppStore((s) => s.clearMessage);

  const [installPromptVisible, setInstallPromptVisible] = useState(
    () => !localStorage.getItem('yyc-install-dismissed'),
  );
  const [aiFlags, setAiFlags] = useState<{ id: number; shipment_id: string; flag_type: string; severity: string; message: string; acknowledged: number }[]>([]);
  const PAGE_SIZE = 20;
  const [deliveryPage, setDeliveryPage] = useState(0);

  const page = useUiStore((s) => s.page);
  const billingShipmentId = useUiStore((s) => s.billingShipmentId);
  const selected = useUiStore((s) => s.selected);
  const query = useUiStore((s) => s.query);
  const status = useUiStore((s) => s.status);
  const setPage = useUiStore((s) => s.setPage);
  const select = useUiStore((s) => s.select);
  const close = useUiStore((s) => s.close);
  const setQuery = useUiStore((s) => s.setQuery);
  const setStatus = useUiStore((s) => s.setStatus);
  const resetFilters = useUiStore((s) => s.resetFilters);

  useEffect(() => {
    if (!recoveryMode) void boot();
  }, [boot, recoveryMode]);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => clearMessage(), 6000);
    return () => clearTimeout(timer);
  }, [message, clearMessage]);
  useEffect(() => {
    if (page !== 'alerts' || state?.user.role !== 'admin') return;
    void api<{ flags: typeof aiFlags }>('/api/ai/flags').then((r) => setAiFlags(r.flags)).catch(() => {});
  }, [page, state?.user.role]);
  useEffect(() => {
    if (!state) close();
    useUiStore
      .getState()
      .syncDeliveryDrafts(
        state?.user.id || null,
        state?.shipments
          .filter(
            (s) =>
              state.user.role === 'driver' &&
              s.driverId === state.user.id &&
              s.status === 'In transit',
          )
          .map((s) => s.id) || [],
        state ? eligibleActionDrafts(state) : [],
      );
  }, [state, close]);
  const toast = message && (
    <div className="toast" role="status">
      {message}
    </div>
  );
  useEffect(() => { setDeliveryPage(0); }, [query, status, page]);
  if (recoveryMode) return <ResetPassword token={recoveryToken} />;
  if (loading)
    return (
      <main className="authloading">
        <Logo />
        <p>Loading your YYC workspace…</p>
      </main>
    );
  if (bootError)
    return (
      <main className="authloading">
        <Logo />
        <h2>Cannot load YYC</h2>
        <p role="alert">{bootError}</p>
        <button className="btn" onClick={() => void boot()}>
          Retry
        </button>
      </main>
    );
  if (!state)
    return (
      <>
        <Auth
          notify={setMessage}
          onLogin={async () => {
            await refresh();
            setPage('dashboard');
            resetFilters();
          }}
        />
        {toast}
      </>
    );
  const { user, shipments, drivers, accounts } = state;
  const pages =
    user.role === 'admin'
      ? [
          ['dashboard', 'Operations'],
          ['shipments', 'Deliveries'],
          ['approvals', 'Approvals'],
          ['accounts', 'Accounts'],
          ['schedule', 'Work board'],
          ['alerts', 'Work queue'],
        ]
      : user.role === 'store'
        ? [
            ['dashboard', 'Dashboard'],
            ['booking', 'Request delivery'],
            ['shipments', 'My deliveries'],
            ['tracking', 'Tracking'],
            ['alerts', 'Action required'],
            ['profile', 'Store profile'],
          ]
        : [
            ['dashboard', 'My jobs'],
            ['offers', 'Job offers'],
            ['alerts', 'Action required'],
            ['shipments', 'Delivery history'],
            ['profile', 'Truck profile'],
          ];
  pages.push(
    ['notifications', 'Notifications'],
    ['billing', user.role === 'driver' ? 'Payouts' : 'Billing'],
  );
  if (user.role === 'admin') pages.push(['reports', 'Reports']);
  const filtered = shipments.filter(
    (s) =>
      (!query ||
        `${s.id} ${s.customer} ${s.pickup} ${s.destination} ${s.goods}`
          .toLowerCase()
          .includes(query.toLowerCase())) &&
      (!status || s.status === status) &&
      (page !== 'offers' ||
        ((s.status === 'Offered' || !!s.handover) && s.offeredTo === user.id)) &&
      (page !== 'tracking' ||
        (!!s.driverId && !['Delivered', 'Returned', 'Cancelled'].includes(s.status))) &&
      (page !== 'alerts' || nextStep(s, user, shipments).actionable),
  );
  const displayed =
    page === 'dashboard' && user.role === 'driver'
      ? filtered.filter(
          (s) =>
            s.driverId === user.id && ['Assigned', ...cargoStates].includes(s.status),
        )
      : page === 'alerts'
        ? [...filtered].sort(
            (a, b) =>
              nextStep(a, user, shipments).priority -
                nextStep(b, user, shipments).priority ||
              a.date.localeCompare(b.date) ||
              a.id.localeCompare(b.id),
          )
        : filtered;
  const pageCount = Math.ceil(displayed.length / PAGE_SIZE);
  const pageSlice = displayed.slice(deliveryPage * PAGE_SIZE, (deliveryPage + 1) * PAGE_SIZE);
  const current = shipments.find((s) => s.id === selected);
  function openBilling(id: string) {
    close();
    setPage('billing', id);
  }
  function cards(list: Shipment[]) {
    return (
    <ErrorBoundary>
    {list.length ? (
      <div className="grid2 shipment-grid">
        {list.map((s) => {
          const next = nextStep(s, user, shipments);
          const appointment = s.redeliveryPlan ?? s;
          return (
            <article className="card shipment-card" key={s.id}>
              <div className="row between">
                <h2>{s.id}</h2>
                <Badge status={s.status} />
              </div>
              <p className="shipment-customer">{s.customer}</p>
              <div className="shipment-appointment">
                <span aria-hidden="true">▦</span>
                <strong>
                  {new Date(`${appointment.date}T12:00:00`).toLocaleDateString('en-CA', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </strong>
                <span>
                  {s.redeliveryPlan && 'Redelivery · '}
                  {appointment.window}
                </span>
              </div>
              <Route shipment={s} />
              <div className="shipment-cargo">
                <span>{s.goods}</span>
                <span>
                  {s.pallets} pallets · {s.kg} kg
                </span>
                {!!s.stops?.length && <span>{s.stops.length + 2} stops</span>}
              </div>
              {s.issue && !s.issue.resolved && (
                <div className="shipment-alert">
                  <span aria-hidden="true">!</span> Open exception · {s.issue.reason}
                </div>
              )}
              <div className="shipment-next-step">
                <small>{next.actionable ? 'Next step' : 'Current handoff'}</small>
                <strong>{next.title}</strong>
              </div>
              <div className="shipment-card-footer">
                <div>
                  <small>
                    {user.role === 'driver' ? 'Your driver rate' : 'Customer quotation'}
                  </small>
                  <strong>{money(user.role === 'driver' ? s.rate : s.price)}</strong>
                </div>
                <button
                  className="btn light"
                  onClick={() =>
                    page === 'alerts' && next.action === 'invoice'
                      ? openBilling(s.id)
                      : select(s.id)
                  }
                >
                  {page === 'alerts' && next.action === 'invoice'
                    ? `Issue invoice for ${s.id}`
                    : 'View delivery →'}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    ) : (
      <section className="card empty">
        <span className="empty-symbol" aria-hidden="true">
          ▤
        </span>
        <h2>{query || status ? 'No matching deliveries' : 'No deliveries here yet.'}</h2>
        <p>
          {query || status
            ? 'Try a different reference, address or status to find your delivery.'
            : 'Your delivery requests and assignments will appear here as work comes in.'}
        </p>
        {(query || status) && (
          <button className="btn light" onClick={resetFilters}>
            Clear filters
          </button>
        )}
      </section>
    )}
    </ErrorBoundary>
    );
  }
  return (
    <>
      <div className="app">
        <aside className="sidebar">
          <Logo />
          <p className="nav-eyebrow">YOUR WORKSPACE</p>
          <nav aria-label="Workspace">
            {pages.map(([id, label]) => (
              <button
                key={id}
                className={page === id ? 'active' : ''}
                aria-current={page === id ? 'page' : undefined}
                onClick={() => setPage(id)}
              >
                <span className="nav-marker" aria-hidden="true">
                  {id === 'dashboard'
                    ? '◫'
                    : id === 'booking'
                      ? '+'
                      : id === 'tracking'
                        ? '◎'
                        : id === 'notifications'
                          ? '◉'
                          : id === 'billing'
                            ? '$'
                            : id === 'profile'
                              ? '○'
                              : '▤'}
                </span>
                {label}
              </button>
            ))}
          </nav>
          {installPromptVisible && deferredInstallPrompt && (
            <div className="install-banner">
              <p>Add YYC to your home screen for faster access.</p>
              <div className="row">
                <button
                  className="btn light small"
                  onClick={async () => {
                    await deferredInstallPrompt!.prompt();
                    const { outcome } = await deferredInstallPrompt!.userChoice;
                    if (outcome === 'accepted') deferredInstallPrompt = null;
                    setInstallPromptVisible(false);
                    localStorage.setItem('yyc-install-dismissed', '1');
                  }}
                >
                  Install
                </button>
                <button
                  className="textbtn"
                  onClick={() => {
                    setInstallPromptVisible(false);
                    localStorage.setItem('yyc-install-dismissed', '1');
                  }}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
          <div className="sidebottom">
            <b>{user.name}</b>
            <p>{user.role === 'admin' ? 'Broker' : user.role}</p>
            <button className="textbtn" disabled={busy} onClick={() => void logout()}>
              Log out
            </button>
          </div>
        </aside>
        <main className="main">
          <header className="top">
            <div className="workspace-brand">
              <span className="workspace-kicker">
                OPERATIONS / {user.role === 'admin' ? 'BROKER' : user.role.toUpperCase()}
              </span>
              <b>YYC delivery workspace</b>
            </div>
            <div className="row">
              <span>{user.name}</span>
              <button
                className="btn light small"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await refresh();
                    setMessage('Workspace refreshed.');
                  })
                }
              >
                Refresh
              </button>
            </div>
          </header>
          {assignmentAlert && (
            <section className="notice" role="alert">
              <p>{assignmentAlert}</p>
              <button
                className="btn light"
                onClick={() => useAppStore.setState({ assignmentAlert: '' })}
              >
                Acknowledge assignment change
              </button>
            </section>
          )}
          {syncError && (
            <p className="notice" role="status">
              {syncError}
            </p>
          )}
          <div className="driver-status-area">
            <DriverTracking user={user} shipments={shipments} />
            <OfflinePanel user={user} />
          </div>
          {needsRefresh && (
            <p className="notice" role="status">
              {refreshReason === 'saved'
                ? 'Your change was saved. '
                : 'The delivery changed. '}
              Refresh the workspace before making another change.
            </p>
          )}
          <div className="workspace" inert={needsRefresh}>
          <ErrorBoundary>
            <div className="pagetitle">
              <span className="section-eyebrow">YYC BROKERS · DELIVERY OPERATIONS</span>
              <h1>{pages.find(([id]) => id === page)?.[1]}</h1>
              <p className="muted">
                Requests, quotations and driver-confirmed delivery milestones.
              </p>
            </div>
            {user.role === 'driver' && (!user.approved || !user.truck?.approved) && (
              <div className="notice">
                Your driver and truck registration is pending broker approval.
              </div>
            )}
            {['notifications', 'billing', 'reports'].includes(page) ? (
              <OperationsPage
                page={page}
                billingShipmentId={billingShipmentId}
                user={user}
                shipments={shipments}
                accounts={accounts}
                busy={busy}
                save={save}
                revision={refreshVersion}
              />
            ) : page === 'booking' ? (
              <Booking
                key={user.id}
                saveWork={save}
                user={user}
                busy={busy}
                save={(data) => {
                  let createdId: string | null = null;
                  return save(
                    async () => {
                      const result = await createBooking(user.id, data);
                      createdId = result.id;
                    },
                    'Delivery request saved.',
                    () => {
                      setPage('shipments');
                      if (createdId) select(createdId);
                    },
                  );
                }}
              />
            ) : page === 'profile' ? (
              <section className="card wizard">
                <h2>{user.name}</h2>
                <p>{user.email}</p>
                {user.role === 'store' ? (
                  <>
                    <Form
                      busy={busy}
                      label="Save profile"
                      onSave={(data) =>
                        save(() => api('/api/profile', 'PATCH', data), 'Profile saved.')
                      }
                    >
                      <Field
                        name="name"
                        label="Store / business name"
                        value={user.name}
                      />
                      <Field
                        name="address"
                        label="Store delivery address"
                        value={user.profile.address}
                      />
                      <Field
                        name="contact"
                        label="Receiving contact"
                        value={user.profile.contact}
                      />
                      <Field
                        name="phone"
                        label="Contact phone"
                        type="tel"
                        value={user.profile.phone}
                      />
                    </Form>
                    <SavedAddressesForm
                      addresses={user.profile.savedAddresses ?? []}
                      busy={busy}
                      save={save}
                    />
                  </>
                ) : (
                  <>
                    <Badge
                      status={
                        user.approved && user.truck?.approved
                          ? 'Approved'
                          : 'Pending review'
                      }
                    />
                    <p>{user.profile.phone}</p>
                    <p>
                      {user.truck?.truck} · {user.truck?.plate}
                    </p>
                    <p>
                      {user.truck?.type} · {user.truck?.kg} kg · {user.truck?.pallets}{' '}
                      pallets
                    </p>
                    <p>
                      {user.truck?.area} · Liftgate: {user.truck?.liftgate ? 'Yes' : 'No'}
                    </p>
                    {user.role === 'driver' && (
                      <DriverProfile user={user} busy={busy} save={save} />
                    )}
                    {user.role === 'driver' && (
                      <AvailabilityForm
                        dates={
                          (user.truck as { unavailableDates?: string[] } | null)
                            ?.unavailableDates ?? []
                        }
                        busy={busy}
                        save={save}
                      />
                    )}
                  </>
                )}
              </section>
            ) : page === 'accounts' ? (
              <Accounts accounts={accounts} currentId={user.id} busy={busy} save={save} />
            ) : page === 'approvals' ? (
              <div className="grid2">
                {drivers.length ? (
                  drivers.map((d) => (
                    <section className="card" key={d.id}>
                      <h2>{d.name}</h2>
                      <Badge
                        status={
                          d.approved && d.truck?.approved ? 'Approved' : 'Pending review'
                        }
                      />
                      <p>
                        {d.email} · {d.profile.phone}
                      </p>
                      <p>
                        {d.truck?.truck} · {d.truck?.plate}
                        <br />
                        {d.truck?.type} · {d.truck?.kg} kg · {d.truck?.pallets} pallets
                        <br />
                        {d.truck?.area} · Liftgate: {d.truck?.liftgate ? 'Yes' : 'No'}
                      </p>
                      <div className="notice">
                        Review identity, licence and insurance evidence outside this
                        starter before recording approval.
                      </div>
                      <button
                        className="btn"
                        disabled={
                          busy || d.disabled || (d.approved && !!d.truck?.approved)
                        }
                        onClick={() =>
                          void save(
                            () =>
                              api(
                                `/api/drivers/${encodeURIComponent(d.id)}/approve`,
                                'POST',
                                {},
                              ),
                            'Driver and truck approval recorded.',
                          )
                        }
                      >
                        Record manual approval
                      </button>
                      <DriverReview driver={d} busy={busy} save={save} />
                    </section>
                  ))
                ) : (
                  <section className="card">No driver registrations yet.</section>
                )}
              </div>
            ) : (
              <>
                {page === 'dashboard' && (
                  <>
                    <section className="overview-hero">
                      <div>
                        <span className="section-eyebrow">
                          YOUR OPERATIONS AT A GLANCE
                        </span>
                        <h2>
                          {user.role === 'driver'
                            ? 'Your next move starts here.'
                            : user.role === 'store'
                              ? 'From your door to theirs.'
                              : 'Keep every delivery moving.'}
                        </h2>
                        <p>
                          {user.role === 'driver'
                            ? 'Review your assignments, record each stop, and keep your deliveries on track.'
                            : user.role === 'store'
                              ? 'Request a delivery, review your quotes, and follow every step along the way.'
                              : 'Turn requests into quotes, connect available drivers, and stay ahead of exceptions.'}
                        </p>
                      </div>
                      <div className="hero-summary">
                        <span className="hero-summary-number">
                          {
                            shipments.filter((s) =>
                              ['Assigned', 'In transit', 'Returning'].includes(s.status),
                            ).length
                          }
                        </span>
                        <span>deliveries moving</span>
                        <span className="hero-status">
                          <span className="status-dot" /> Assigned &amp; in transit
                        </span>
                      </div>
                    </section>
                    <AttentionQueue
                      shipments={shipments}
                      user={user}
                      open={select}
                      openBilling={openBilling}
                    />
                    <div className="stats">
                      {[
                        [
                          'Active deliveries',
                          shipments.filter(
                            (s) =>
                              !['Delivered', 'Returned', 'Cancelled'].includes(s.status),
                          ).length,
                        ],
                        [
                          'Awaiting quote',
                          shipments.filter((s) => s.status === 'Awaiting quote').length,
                        ],
                        [
                          'Quotes ready',
                          shipments.filter((s) => s.status === 'Quote ready').length,
                        ],
                        [
                          'Delivered',
                          shipments.filter((s) => s.status === 'Delivered').length,
                        ],
                      ].map(([label, count]) => (
                        <div className="card" key={label}>
                          <span className="muted">{label}</span>
                          <h1>{count}</h1>
                        </div>
                      ))}
                    </div>
                    {user.role === 'store' && (
                      <button
                        className="btn requestbutton"
                        onClick={() => setPage('booking')}
                      >
                        ＋ Request delivery
                      </button>
                    )}
                  </>
                )}
                {page === 'alerts' && state?.user.role === 'admin' && aiFlags.filter((f) => !f.acknowledged).length > 0 && (
                  <section className="card">
                    <h2>AI anomaly flags</h2>
                    {aiFlags.filter((f) => !f.acknowledged).map((f) => (
                      <div key={f.id} className="ai-flag-item">
                        <span className={`ai-flag-severity severity-${f.severity}`}>{f.severity}</span>
                        <span>{f.message} <small>({f.shipment_id})</small></span>
                        <button
                          type="button"
                          className="btn light small"
                          onClick={() =>
                            void api(`/api/ai/flags/${f.id}/acknowledge`, 'POST')
                              .then(() => setAiFlags((prev) => prev.map((x) => x.id === f.id ? { ...x, acknowledged: 1 } : x)))
                              .catch(() => {})
                          }
                        >
                          Acknowledge
                        </button>
                      </div>
                    ))}
                  </section>
                )}
                <div className="delivery-list-heading">
                  <div>
                    <span className="section-eyebrow">DELIVERY WORKSPACE</span>
                    <h2>
                      {page === 'offers'
                        ? 'Available offers'
                        : page === 'alerts'
                          ? 'Needs your attention'
                          : page === 'dashboard'
                            ? 'Your deliveries'
                            : 'Delivery overview'}
                    </h2>
                  </div>
                  <span className="count-pill">
                    {displayed.length}{' '}
                    {displayed.length === 1 ? 'delivery' : 'deliveries'}
                  </span>
                </div>
                <div className="filters">
                  <label>
                    Search deliveries
                    <input
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Reference, address, cargo…"
                    />
                  </label>
                  <label>
                    Status
                    <select value={status} onChange={(e) => setStatus(e.target.value)}>
                      <option value="">All statuses</option>
                      {[
                        'Awaiting quote',
                        'Quote ready',
                        'Ready to assign',
                        'Offered',
                        'Assigned',
                        'In transit',
                        'Delivery failed',
                        'Returning',
                        'Returned',
                        'Delivered',
                        'Cancelled',
                      ].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {page === 'schedule' ? (
                  <div className="workboard">
                    {[
                      'Awaiting quote',
                      'Quote ready',
                      'Ready to assign',
                      'Offered',
                      'Assigned',
                      'In transit',
                      'Delivered',
                      'Cancelled',
                    ].map((s) => (
                      <section key={s}>
                        <h2>{s}</h2>
                        {cards(filtered.filter((item) => item.status === s))}
                      </section>
                    ))}
                  </div>
                ) : (
                  <>
                    {cards(pageSlice)}
                    {pageCount > 1 && (
                      <div className="pagination">
                        <button
                          className="btn light small"
                          disabled={deliveryPage === 0}
                          onClick={() => setDeliveryPage((p) => p - 1)}
                        >
                          Previous
                        </button>
                        <span>
                          Page {deliveryPage + 1} of {pageCount}
                        </span>
                        <button
                          className="btn light small"
                          disabled={deliveryPage >= pageCount - 1}
                          onClick={() => setDeliveryPage((p) => p + 1)}
                        >
                          Next
                        </button>
                      </div>
                    )}
                  </>
                )}
                {['dashboard', 'tracking'].includes(page) && (
                  <section className="card mapcard">
                    <LiveMap shipments={shipments} selectedId={selected} />
                  </section>
                )}
              </>
            )}
            <footer className="footnote">
              YYC Brokers · Data saved on this server · External online payments not
              connected
            </footer>
          </ErrorBoundary>
          </div>
        </main>
      </div>
      {current && (
        <ErrorBoundary>
          <Delivery
            shipments={shipments}
            s={current}
            user={user}
            drivers={drivers}
            busy={busy || needsRefresh}
            close={close}
            openBilling={openBilling}
            act={(action, data = {}) => act(current.id, current.version, action, data)}
          />
        </ErrorBoundary>
      )}
      {toast}
    </>
  );
}
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
let deferredInstallPrompt: BeforeInstallPromptEvent | null = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e as BeforeInstallPromptEvent;
});

const recipientToken = new URLSearchParams(location.hash.slice(1)).get('track');
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {recipientToken ? <RecipientTracking token={recipientToken} /> : <App />}
  </StrictMode>,
);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker
    .register('/react/sw.js', { scope: '/react/' })
    .catch(() => {});
}
