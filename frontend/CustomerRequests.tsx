import { useState } from 'react';
import { useUiStore } from './stores/useUiStore';
import { actionDraftKey } from './actionDrafts';
import { ActionForm } from './ActionForm';
import { Field } from './Field';
import type { Shipment, User, Action, Payload } from './types';
export function CustomerRequests({
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
  const [kind, setKind] = useState(() => {
    const ui = useUiStore.getState();
    return ui.draftOwner === user.id
      ? ui.actionDrafts[actionDraftKey(s.id, 'requestChange')]?.kind || 'quotation'
      : 'quotation';
  });
  const closed = ['Delivered', 'Returned', 'Cancelled'].includes(s.status);
  const prePickup = [
    'Awaiting quote',
    'Quote ready',
    'Ready to assign',
    'Offered',
    'Assigned',
  ].includes(s.status);
  const pending = s.customerRequests?.find((r) => r.status === 'pending');
  return (
    <section className="card">
      <h2>Owner requests</h2>
      {s.customerRequests?.map((r) => (
        <article key={r.id}>
          <p>
            <strong>
              {r.kind} · {r.status}
            </strong>
          </p>
          <p>{r.details}</p>
          {r.proposal && (
            <p>
              Proposed destination: {r.proposal.destination} · {r.proposal.kg} kg ·{' '}
              {r.proposal.pallets} pallets
            </p>
          )}
          {r.response && (
            <p>
              {r.status === 'withdrawn'
                ? 'Owner explanation'
                : r.status === 'superseded'
                  ? 'Request update'
                  : 'Broker response'}
              : {r.response}
            </p>
          )}
          {r.status === 'pending' && user.role === 'admin' && !closed && (
            <ActionForm
              owner={user.id}
              shipmentId={s.id}
              action="respondRequest"
              draftScope={r.id}
              busy={busy}
              label="Send broker decision"
              onSave={(data) => act('respondRequest', { ...data, requestId: r.id })}
            >
              <label htmlFor="request-decision">Decision</label>
              <select id="request-decision" name="decision" required defaultValue="">
                <option value="">Choose a decision</option>
                <option value="decline">Decline with explanation</option>
                <option value="approve">Approve and apply change</option>
              </select>
              {r.kind === 'quotation' && (
                <>
                  <Field
                    id="request-price"
                    name="price"
                    label="Revised customer price (CAD)"
                    type="number"
                    required={false}
                  />
                  <Field
                    id="request-rate"
                    name="rate"
                    label="Driver rate (CAD)"
                    type="number"
                    required={false}
                  />
                </>
              )}
              <Field name="response" label="Broker explanation and instructions" />
              {r.kind === 'cancellation' && (
                <p>
                  Approval cancels uncollected loads. Cargo already collected must be
                  returned and receipted by the driver.
                </p>
              )}
            </ActionForm>
          )}
        </article>
      ))}
      {pending && (
        <p role="status">
          Awaiting broker review. Current delivery instructions remain in effect until the
          broker approves a change.
        </p>
      )}
      {user.role === 'store' && !closed && pending && (
        <ActionForm
          owner={user.id}
          shipmentId={s.id}
          action="withdrawRequest"
          draftScope={pending.id}
          busy={busy}
          label="Withdraw pending request"
          onSave={(data) => act('withdrawRequest', { ...data, requestId: pending.id })}
        >
          <Field
            id="withdraw-request-reason"
            name="reason"
            label="Reason for withdrawing request"
          />
        </ActionForm>
      )}
      {user.role === 'store' &&
        !closed &&
        (!pending || pending.kind !== 'cancellation') &&
        s.status !== 'Returning' && (
          <ActionForm
            owner={user.id}
            shipmentId={s.id}
            action="requestChange"
            busy={busy}
            label="Send request to broker"
            onSave={(data) =>
              act('requestChange', {
                ...data,
                kind: prePickup && !pending ? kind : 'cancellation',
              })
            }
          >
            {prePickup && !pending ? (
              <>
                <label htmlFor="request-kind">Request type</label>
                <select
                  id="request-kind"
                  name="kind"
                  value={kind}
                  onChange={(event) => setKind(event.target.value)}
                >
                  <option value="quotation">Review quotation</option>
                  <option value="shipment">Change destination or cargo</option>
                  <option value="cancellation">Cancel delivery</option>
                </select>
              </>
            ) : (
              <p>
                {pending
                  ? 'This cancellation request will supersede your earlier pending request.'
                  : 'Request cancellation and return of collected cargo.'}
              </p>
            )}
            {prePickup && !pending && kind === 'shipment' && (
              <>
                <Field
                  id="request-destination"
                  name="destination"
                  label="Proposed destination"
                  value={s.destination}
                />
                <Field
                  id="request-kg"
                  name="kg"
                  label="Proposed weight (kg)"
                  type="number"
                  value={s.kg}
                />
                <Field
                  id="request-pallets"
                  name="pallets"
                  label="Proposed pallet count"
                  type="number"
                  value={s.pallets}
                />
              </>
            )}
            <Field name="details" label="Request details and reason" />
          </ActionForm>
        )}
      {!s.customerRequests?.length && user.role !== 'store' && <p>No owner requests.</p>}
    </section>
  );
}
