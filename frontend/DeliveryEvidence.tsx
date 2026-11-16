import type { FormEvent } from 'react';
import type { EvidenceDraft } from './types';

export function DeliveryEvidence({
  draft,
  onChange,
  onSave,
  busy,
}: {
  draft: EvidenceDraft;
  onChange: (draft: EvidenceDraft) => void;
  onSave: (draft: EvidenceDraft) => Promise<void>;
  busy: boolean;
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
