import { useState, type FormEvent } from 'react';
import { api } from './api';
import { dataFrom } from './forms';
import { Field } from './Field';

function Logo() {
  return (
    <div className="logo brandlogo">
      <img src="/assets/yyc-brokers-logo.jpg" alt="YYC Brokers" width="88" height="88" />
      <span className="brandword">
        YYC BROKERS<small>TRUCKING & DELIVERY</small>
      </span>
    </div>
  );
}

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
      delete data.confirm;
      await api('/api/setup', 'POST', data);
      back(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Setup failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth">
      <section className="hero">
        <Logo />
        <div>
          <div className="eyebrow">YYC BROKERS</div>
          <h1>
            Your workspace.
            <br />
            Your team.
            <br />
            <span>One platform.</span>
          </h1>
          <p>
            Set up your broker account to start approving drivers, assigning deliveries,
            and tracking every shipment.
          </p>
        </div>
        <div className="herofoot">
          <span>Dispatch</span>
          <span>Track</span>
          <span>Deliver</span>
        </div>
      </section>
      <section className="authright">
        <header>
          <span>YYC WORKSPACE SETUP</span>
        </header>
        <div className="authbox">
          <h1>Create your broker account.</h1>
          <p className="muted">
            Enter your operator-issued setup token and your account details.
          </p>
          <form onSubmit={submit}>
            <Field name="token" label="Operator setup token" autoComplete="off" />
            <Field name="name" label="Full name" />
            <Field name="phone" label="Contact phone" type="tel" />
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
            <p className="error" role="alert">
              {error}
            </p>
            <button className="btn" disabled={busy}>
              {busy ? 'Creating…' : 'Create broker account'}
            </button>
          </form>
          <button className="textbtn" disabled={busy} onClick={() => back()}>
            Back to login
          </button>
          <div className="notice">
            The setup token is issued by the server operator and expires in 30 minutes.
            Only one broker account can be created this way.
          </div>
        </div>
      </section>
    </div>
  );
}
