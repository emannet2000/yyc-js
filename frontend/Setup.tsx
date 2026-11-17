import { useState, type FormEvent } from 'react';
import { api } from './api';
import { dataFrom } from './forms';
import { Field } from './Field';
export function Setup({ back }: { back: (created?: boolean) => void }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = dataFrom(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      if (data.password !== data.confirm) throw new Error('Passwords must match.');
      await api('/api/setup', 'POST', data);
      back(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Setup failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="authloading">
      <section className="card">
        <h1>Set up your broker account</h1>
        <p>
          Your operator must run <code>npm run setup</code> on the server to issue a
          one-time setup token. It expires in 30 minutes. Existing workspaces cannot be
          claimed again.
        </p>
        <form onSubmit={submit}>
          <Field name="token" label="Operator setup token" autoComplete="off" />
          <Field name="name" label="Broker name" />
          <Field name="phone" label="Contact phone" />
          <Field name="email" label="Email address" type="email" />
          <Field
            name="password"
            label="Password"
            type="password"
            autoComplete="new-password"
          />
          <Field
            name="confirm"
            label="Confirm password"
            type="password"
            autoComplete="new-password"
          />
          {error && <p role="alert">{error}</p>}
          <button className="btn" disabled={busy}>
            {busy ? 'Creating…' : 'Create broker account'}
          </button>
        </form>
        <button className="textbtn" disabled={busy} onClick={() => back()}>
          Back to login
        </button>
      </section>
    </main>
  );
}
