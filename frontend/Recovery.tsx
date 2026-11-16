import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, setCsrf } from './api';
import { Field } from './Field';

export function RecoveryRequest({ back }: { back: () => void }) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setMessage('');
    try {
      const result = await api<{ message: string }>(
        '/api/password-reset/request',
        'POST',
        { email: data.get('email') },
      );
      setMessage(result.message);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Recovery is unavailable. Contact YYC.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="recovery card">
      <h1>Recover your account</h1>
      <p>Request recovery instructions, or contact YYC for a verified recovery link.</p>
      <form onSubmit={submit}>
        <Field name="email" label="Email address" type="email" />
        <button className="btn" disabled={busy}>
          Request recovery
        </button>
      </form>
      <p role="status">{message}</p>
      <button className="textbtn" disabled={busy} onClick={back}>
        Back to log in
      </button>
    </main>
  );
}

export function ResetPassword({ token }: { token: string }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [done, setDone] = useState(false);
  useEffect(() => {
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search,
    );
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError('');
    if (data.get('password') !== data.get('confirm')) {
      setError('Passwords must match.');
      return;
    }
    setBusy(true);
    try {
      await api('/api/password-reset/complete', 'POST', {
        token,
        password: data.get('password'),
      });
      setCsrf(null);
      setDone(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Cannot change password.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="recovery card">
      <h1>Set a new password</h1>
      {done ? (
        <p role="status">Password updated. All previous sessions have ended.</p>
      ) : token ? (
        <form onSubmit={submit}>
          <Field
            name="password"
            label="New password"
            type="password"
            autoComplete="new-password"
          />
          <Field
            name="confirm"
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
          />
          <p className="error" role="alert">
            {error}
          </p>
          <button className="btn" disabled={busy}>
            Change password
          </button>
        </form>
      ) : (
        <p role="alert">This recovery link is missing its token. Request a new link.</p>
      )}
      <a className="textbtn" href="/react/">
        Back to log in
      </a>
    </main>
  );
}
