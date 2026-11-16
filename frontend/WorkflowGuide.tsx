import { nextStep, attentionQueue, driverBlockers } from './workflow';
import type { Shipment, User } from './types';
export function WorkflowGuide({
  s,
  user,
  shipments,
}: {
  s: Shipment;
  user: User;
  shipments: Shipment[];
}) {
  const next = nextStep(s, user, shipments);
  return (
    <section
      className={`workflow-guide ${next.actionable ? 'requires-action' : ''}`}
      aria-label="Workflow guidance"
    >
      <span className="section-eyebrow">
        {next.actionable ? 'YOUR NEXT STEP' : 'CURRENT HANDOFF'}
      </span>
      <h2>{next.title}</h2>
      <p>{next.detail}</p>
      {s.quoteExpiresAt && s.status === 'Quote ready' && (
        <small>Quote valid until {new Date(s.quoteExpiresAt).toLocaleString()}</small>
      )}
      {s.offerExpiresAt && s.offeredTo && (
        <small>Offer valid until {new Date(s.offerExpiresAt).toLocaleString()}</small>
      )}
    </section>
  );
}
export function AttentionQueue({
  shipments,
  user,
  open,
}: {
  shipments: Shipment[];
  user: User;
  open: (id: string) => void;
}) {
  const queue = attentionQueue(shipments, user);
  return (
    <section className="attention-queue card">
      <div className="section-heading">
        <div>
          <span className="section-eyebrow">START HERE</span>
          <h2>Action required</h2>
        </div>
        <span className="count-pill">{queue.length} to review</span>
      </div>
      {queue.length ? (
        <ol>
          {queue.slice(0, 5).map(({ shipment: s, next }) => (
            <li key={s.id}>
              <div>
                <strong>{next.title}</strong>
                <span>
                  {s.id} · {s.customer}
                </span>
                <p>{next.detail}</p>
              </div>
              <button className="btn light" onClick={() => open(s.id)}>
                Review {s.id}
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">
          You’re up to date. Delivery updates and new work will appear here.
        </p>
      )}
      {queue.length > 5 && (
        <p className="muted">
          Showing the first five priorities. Open Action required in navigation to review
          all {queue.length}.
        </p>
      )}
    </section>
  );
}
export function DispatchReadiness({
  s,
  drivers,
  shipments,
}: {
  s: Shipment;
  drivers: User[];
  shipments: Shipment[];
}) {
  const reviewed = drivers.map((driver) => ({
    driver,
    reasons: driverBlockers(s, driver, shipments),
  }));
  const available = reviewed.filter((item) => !item.reasons.length);
  return (
    <div className="dispatch-readiness">
      <p>
        <strong>
          {available.length} suitable driver{available.length === 1 ? '' : 's'} available
        </strong>{' '}
        for this pickup window.
      </p>
      {!available.length && (
        <p className="notice">
          No driver currently meets every requirement. Review approvals, truck capacity or
          the pickup schedule before dispatching.
        </p>
      )}
      <details>
        <summary>Review driver availability</summary>
        {reviewed.length ? (
          <ul>
            {reviewed.map(({ driver, reasons }) => (
              <li key={driver.id}>
                <strong>{driver.name}</strong>
                <span>
                  {reasons.length
                    ? reasons.join(' · ')
                    : 'Available · meets truck and schedule requirements'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No drivers have registered yet.</p>
        )}
      </details>
    </div>
  );
}
