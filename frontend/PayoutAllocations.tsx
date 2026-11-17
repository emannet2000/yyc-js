import type { FormEvent } from 'react';
import { api } from './api';
import type { Payload } from './types';
export interface DriverShare {
  driverId: string;
  name: string;
  rateCents: number;
  paidCents: number;
  dueCents: number;
  reason: string;
}
export interface CargoDriver {
  driverId: string;
  name: string;
}
export function allocationPayload(data: FormData, participants: CargoDriver[]) {
  return participants.map((p) => ({
    driverId: p.driverId,
    amount: Number(data.get(`share:${p.driverId}`)),
    reason: String(data.get(`shareReason:${p.driverId}`) || ''),
  }));
}
export function AllocationFields({
  participants,
  shares = [],
  scope = 'new-invoice',
}: {
  participants: CargoDriver[];
  shares?: DriverShare[];
  scope?: string;
}) {
  return (
    <fieldset>
      <legend>Driver payout allocation</legend>
      <p>
        Allocate the entire agreed driver rate across everyone who carried cargo. Enter
        zero explicitly when no share is owed and explain the decision. Recorded payments
        cannot be reduced without a reversal.
      </p>
      {participants.map((p) => {
        const share = shares.find((a) => a.driverId === p.driverId);
        return (
          <div key={p.driverId}>
            <label htmlFor={`share-${scope}-${p.driverId}`}>
              {p.name} — allocated amount (CAD)
            </label>
            <input
              id={`share-${scope}-${p.driverId}`}
              name={`share:${p.driverId}`}
              type="number"
              step="0.01"
              min="0"
              required
              defaultValue={share ? (share.rateCents / 100).toFixed(2) : ''}
            />
            <label htmlFor={`share-reason-${scope}-${p.driverId}`}>
              {p.name} — allocation reason
            </label>
            <input
              id={`share-reason-${scope}-${p.driverId}`}
              name={`shareReason:${p.driverId}`}
              required
              maxLength={2000}
              defaultValue={share?.reason || ''}
            />
          </div>
        );
      })}
    </fieldset>
  );
}
export function AllocationEditor({
  invoice,
  busy,
  save,
}: {
  invoice: {
    id: string;
    version: number;
    rateCents: number;
    allocations?: DriverShare[];
    participants?: CargoDriver[];
    allocationRequired?: boolean;
  };
  busy: boolean;
  save: (work: () => Promise<unknown>, message: string) => Promise<void>;
}) {
  const participants = invoice.participants || [];
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const allocations = allocationPayload(
      new FormData(event.currentTarget),
      participants,
    );
    await save(
      () =>
        api(`/api/invoices/${invoice.id}/allocations`, 'POST', {
          version: invoice.version,
          allocations,
        }),
      'Driver payout shares recorded.',
    );
  }
  return (
    <section>
      {invoice.allocations?.map((a) => (
        <p key={a.driverId}>
          {a.name}: allocated CAD {(a.rateCents / 100).toFixed(2)} · paid CAD{' '}
          {(a.paidCents / 100).toFixed(2)} · outstanding CAD{' '}
          {(a.dueCents / 100).toFixed(2)} · {a.reason}
        </p>
      ))}
      {invoice.allocationRequired && (
        <p role="alert">
          Review the handover allocation before recording further driver payouts. Verified
          payout reversals remain available during review.
        </p>
      )}
      <details open={invoice.allocationRequired || undefined}>
        <summary>Review driver payout shares</summary>
        <p>Total shares must equal CAD {(invoice.rateCents / 100).toFixed(2)}.</p>
        <form onSubmit={submit} key={invoice.version}>
          <AllocationFields
            participants={participants}
            shares={invoice.allocations}
            scope={invoice.id}
          />
          <button className="btn light" disabled={busy}>
            Save driver payout shares
          </button>
        </form>
      </details>
    </section>
  );
}
export function shareData(participants: CargoDriver[], payload: Payload) {
  return participants.map((p) => ({
    driverId: p.driverId,
    amount: Number(payload[`share:${p.driverId}`]),
    reason: String(payload[`shareReason:${p.driverId}`] || ''),
  }));
}
