import type { FormEvent } from 'react';
import type { EvidenceDraft } from './types';

export function DeliveryEvidence({
  draft,
  onChange,
  onSave,
  busy,
  arrived,
  evidenceCount,
}: {
  draft: EvidenceDraft;
  onChange: (draft: EvidenceDraft) => void;
  onSave: (draft: EvidenceDraft) => Promise<void>;
  busy: boolean;
  arrived: boolean;
  evidenceCount: number;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!busy) void onSave(draft);
  }
  return (
    <form onSubmit={submit}>
      <div className="field">
        <label htmlFor="pod">Delivery receipt reference</label>
        <input
          id="pod"
          name="pod"
          required
          disabled={busy}
          value={draft.pod}
          onChange={(event) => onChange({ ...draft, pod: event.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor="recipient">Received by</label>
        <input
          id="recipient"
          name="recipient"
          required
          disabled={busy}
          value={draft.recipient}
          onChange={(event) => onChange({ ...draft, recipient: event.target.value })}
        />
      </div>
      <p role="status">
        Delivery policy: record arrival at the final destination and attach a delivery
        photo, signature image, or receipt for this delivery attempt in Evidence files
        before confirming. {arrived ? 'Arrival recorded.' : 'Arrival still required.'}{' '}
        {evidenceCount ? 'Evidence attached.' : 'Evidence file still required.'}
      </p>
      <p className="muted">
        If another update changes this delivery, review the latest details before
        resubmitting. Your entered evidence is kept during refreshes and while this
        workspace stays open.
      </p>
      <button className="btn" disabled={busy}>
        {busy ? 'Saving…' : 'Confirm delivery'}
      </button>
    </form>
  );
}
