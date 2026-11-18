import { useState } from 'react';
import type { FormEvent } from 'react';
import { api } from './api';
import { Field } from './Field';
import type { User } from './types';

type Save = (work: () => Promise<unknown>, message: string) => Promise<void>;

function AddBroker({ busy, save }: { busy: boolean; save: Save }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(0);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const payload: Record<string, unknown> = Object.fromEntries(data.entries());
    if (payload.password !== payload.confirm)
      return alert('Passwords must match.');
    delete payload.confirm;
    void save(async () => {
      await api('/api/accounts', 'POST', payload);
      setOpen(false);
      setKey((k) => k + 1);
    }, 'Broker account created.');
  }
  if (!open)
    return (
      <section className="card accountcard">
        <h2>Add broker account</h2>
        <p>Create an additional broker who can manage deliveries and approve drivers.</p>
        <button className="btn" disabled={busy} onClick={() => setOpen(true)}>
          + Add broker
        </button>
      </section>
    );
  return (
    <section className="card accountcard">
      <h2>New broker account</h2>
      <form key={key} onSubmit={submit}>
        <Field name="name" label="Full name" />
        <Field name="phone" label="Contact phone" type="tel" />
        <Field name="email" label="Email address" type="email" />
        <Field name="password" label="Password" type="password" autoComplete="new-password" />
        <Field name="confirm" label="Confirm password" type="password" autoComplete="new-password" />
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button className="btn" disabled={busy}>Create broker account</button>
          <button className="btn light" type="button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
        </div>
      </form>
    </section>
  );
}

export function Accounts({
  accounts,
  currentId,
  busy,
  save,
}: {
  accounts: User[];
  currentId: string;
  busy: boolean;
  save: Save;
}) {
  return (
    <div className="grid2">
      <AddBroker busy={busy} save={save} />
      {accounts.map((account) => (
        <Account
          key={account.id}
          account={account}
          currentId={currentId}
          busy={busy}
          save={save}
        />
      ))}
    </div>
  );
}
function Account({
  account,
  currentId,
  busy,
  save,
}: {
  account: User;
  currentId: string;
  busy: boolean;
  save: Save;
}) {
  const [recovery, setRecovery] = useState<{
    resetUrl: string;
    expiresAt: number;
  } | null>(null);
  function submit(event: FormEvent<HTMLFormElement>, kind: 'status' | 'password-reset') {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void save(
      async () => {
        const result = await api<{ resetUrl: string; expiresAt: number }>(
          `/api/accounts/${encodeURIComponent(account.id)}/${kind}`,
          'POST',
          {
            reason: data.get('reason'),
            ...(kind === 'status' ? { disabled: !account.disabled } : {}),
          },
        );
        setRecovery(kind === 'password-reset' ? result : null);
      },
      kind === 'status' ? 'Account status updated.' : 'Recovery link created.',
    );
  }
  return (
    <section className="card accountcard">
      <h2>{account.name}</h2>
      <p>{account.email}</p>
      <p>
        {account.role} · {account.disabled ? 'Disabled' : 'Active'}
      </p>
      <p>
        Disabling ends sessions and withdraws unaccepted offers. Accepted jobs remain
        assigned for broker review.
      </p>
      <form onSubmit={(event) => submit(event, 'status')}>
        <Field
          id={`${account.id}-status-reason`}
          name="reason"
          label={`Reason for ${account.disabled ? 'enabling' : 'disabling'} ${account.email}`}
        />
        <button className="btn light" disabled={busy || account.id === currentId}>
          {account.disabled ? 'Enable account' : 'Disable account'}
        </button>
      </form>
      {account.id === currentId && <p>You cannot disable your own account.</p>}
      <form onSubmit={(event) => submit(event, 'password-reset')}>
        <Field
          id={`${account.id}-recovery-reason`}
          name="reason"
          label={`Recovery verification for ${account.email}`}
        />
        <p>Verify the account holder before sharing a recovery link.</p>
        <button className="btn" disabled={busy || account.disabled}>
          Create password reset link
        </button>
      </form>
      {recovery && (
        <div className="notice">
          <label>
            One-time recovery link
            <input
              aria-label={`Recovery link for ${account.email}`}
              readOnly
              value={recovery.resetUrl}
            />
          </label>
          <p>
            Expires {new Date(recovery.expiresAt).toLocaleString()}. Share through a
            verified private channel.
          </p>
        </div>
      )}
    </section>
  );
}
