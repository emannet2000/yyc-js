import { nextStep, attentionQueue, driverBlockers } from './workflow';
import type { Shipment, User } from './types';
import { fitNote, rankDrivers } from './driverRanking';

const ACTIVE_JOB_STATUSES = ['Assigned', 'In transit', 'Delivery failed', 'Returning'];
export function WorkflowGuide({
  s,
  user,
  shipments,
  openBilling,
}: {
  s: Shipment;
  user: User;
  shipments: Shipment[];
  openBilling: (id: string) => void;
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
      {next.action === 'invoice' && (
        <button className="btn light" onClick={() => openBilling(s.id)}>
          Open invoice form
        </button>
      )}
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
  openBilling,
}: {
  shipments: Shipment[];
  user: User;
  open: (id: string) => void;
  openBilling: (id: string) => void;
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
              <button
                className="btn light"
                onClick={() =>
                  next.action === 'invoice' ? openBilling(s.id) : open(s.id)
                }
              >
                {next.action === 'invoice' ? 'Issue invoice for' : 'Review'} {s.id}
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
  // Ranking uses only data the broker already sees: approval, truck capacity and job load.
  const candidates = reviewed.map(({ driver, reasons }) => ({
    id: driver.id,
    blocked: reasons.length > 0,
    spareKg: driver.truck ? driver.truck.kg - s.kg : null,
    activeJobs: shipments.filter(
      (j) => j.driverId === driver.id && ACTIVE_JOB_STATUSES.includes(j.status),
    ).length,
  }));
  const order = new Map(rankDrivers(candidates).map((c, i) => [c.id, i]));
  const ranked = [...reviewed].sort(
    (a, b) => (order.get(a.driver.id) ?? 0) - (order.get(b.driver.id) ?? 0),
  );
  const bestId = ranked.find((item) => !item.reasons.length)?.driver.id;
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
            {ranked.map(({ driver, reasons }) => {
              const candidate = candidates.find((c) => c.id === driver.id)!;
              return (
                <li key={driver.id}>
                  <strong>
                    {driver.name}
                    {driver.id === bestId && <span className="tag"> Best fit</span>}
                  </strong>
                  <span>
                    {reasons.length
                      ? reasons.join(' · ')
                      : `Available · ${fitNote(candidate)}`}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p>No drivers have registered yet.</p>
        )}
      </details>
    </div>
  );
}
