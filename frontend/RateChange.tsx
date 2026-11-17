import { ActionForm } from './ActionForm';
import { Field } from './Field';
import type { Shipment, User, Action, Payload } from './types';
export function RateChange({
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
  const beforePickup = [
    'Awaiting quote',
    'Quote ready',
    'Ready to assign',
    'Offered',
    'Assigned',
  ].includes(s.status);
  if (user.role === 'store' || !beforePickup || s.price === null || s.rate == null)
    return null;
  return (
    <section>
      {s.rateChange && (
        <p>
          Proposed driver rate: CAD {s.rateChange.rate.toFixed(2)}. {s.rateChange.reason}.
          The current rate remains agreed until the driver accepts.
        </p>
      )}
      {user.role === 'driver' && s.rateChange?.driverId === user.id && (
        <>
          <button
            className="btn light"
            disabled={busy}
            onClick={() => void act('acceptRate')}
          >
            Accept new driver rate
          </button>
          <button
            className="btn light"
            disabled={busy}
            onClick={() => void act('declineRate')}
          >
            Keep existing driver rate
          </button>
        </>
      )}
      {user.role === 'admin' && s.rateChange && (
        <details>
          <summary>Withdraw proposed driver rate</summary>
          <p>
            The current agreed rate stays in place. The driver is no longer asked to
            respond.
          </p>
          <ActionForm
            owner={user.id}
            shipmentId={s.id}
            action="withdrawRateChange"
            busy={busy}
            label="Withdraw proposed rate"
            onSave={(data) => act('withdrawRateChange', data)}
          >
            <Field
              id="withdraw-rate-reason"
              name="reason"
              label="Reason for withdrawing the proposal"
            />
          </ActionForm>
        </details>
      )}
      {user.role === 'admin' && s.price != null && !s.rateChange && (
        <details>
          <summary>Change driver rate</summary>
          <p>
            Customer approval and dispatch remain unchanged. An assigned or proposed
            driver must accept the new rate.
          </p>
          <ActionForm
            owner={user.id}
            shipmentId={s.id}
            action="changeRate"
            busy={busy}
            label="Submit driver rate change"
            onSave={(data) => act('changeRate', data)}
          >
            <Field
              id="driver-rate"
              name="rate"
              label="New driver rate (CAD)"
              type="number"
              value={s.rate}
            />
            <Field
              id="driver-rate-reason"
              name="reason"
              label="Reason for driver rate change"
            />
          </ActionForm>
        </details>
      )}
    </section>
  );
}
