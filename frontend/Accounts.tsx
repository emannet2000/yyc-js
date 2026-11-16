import { useState } from 'react';
import type { FormEvent } from 'react';
import { api } from './api';
import { Field } from './Field';
import type { User } from './types';

type Save = (work: () => Promise<unknown>, message: string) => Promise<void>;
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
