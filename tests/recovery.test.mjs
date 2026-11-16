import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, login, secret, booking, action } from './helpers/app.mjs';
const tokenOf = (response) =>
  new URLSearchParams(new URL(response.value.resetUrl).hash.slice(1)).get('token');
const issue = async (admin, id) =>
  admin(`/api/accounts/${id}/password-reset`, 'POST', {
    reason: 'Identity verified through registered contact',
  });

test('broker-issued recovery is single-use, revokes sessions and replaces the password', async (t) => {
  const { admin, store, other, client } = await setup(t);
  const id = (await store('/api/state')).value.user.id;
  assert.equal(
    (
      await other(`/api/accounts/${id}/password-reset`, 'POST', {
        reason: 'Not a broker',
      })
    ).status,
    403,
  );
  const response = await issue(admin, id);
  assert.equal(response.status, 200);
  assert.ok(new URL(response.value.resetUrl).hash.startsWith('#token='));
  const token = tokenOf(response),
    visitor = client();
  assert.equal(
    (await visitor('/api/password-reset/complete', 'POST', { token, password: 'short' }))
      .status,
    400,
  );
  const changed = await visitor('/api/password-reset/complete', 'POST', {
    token,
    password: 'Replacement-password-12345',
  });
  assert.equal(changed.status, 200);
  assert.equal((await store('/api/state')).status, 401);
  assert.equal(
    (
      await visitor('/api/login', 'POST', {
        email: 'store@example.com',
        password: secret,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await visitor('/api/login', 'POST', {
        email: 'store@example.com',
        password: 'Replacement-password-12345',
      })
    ).status,
    200,
  );
  assert.equal(
    (await visitor('/api/password-reset/complete', 'POST', { token, password: secret }))
      .status,
    400,
  );
});

test('expired and superseded reset links cannot change credentials', async (t) => {
  let time = Date.now();
  const { admin, store, client } = await setup(t, { now: () => time });
  const id = (await store('/api/state')).value.user.id;
  const first = tokenOf(await issue(admin, id));
  const second = tokenOf(await issue(admin, id));
  const visitor = client();
  assert.equal(
    (
      await visitor('/api/password-reset/complete', 'POST', {
        token: first,
        password: secret,
      })
    ).status,
    400,
  );
  time += 30 * 60000;
  assert.equal(
    (
      await visitor('/api/password-reset/complete', 'POST', {
        token: second,
        password: secret,
      })
    ).status,
    400,
  );
  await login(visitor, 'store@example.com');
});

test('email requests do not reveal eligibility and never return a token', async (t) => {
  const messages = [];
  const { client } = await setup(t, {
    sendResetLink: async (message) => messages.push(message),
    publicOrigin: 'https://workspace.example',
  });
  const visitor = client();
  const known = await visitor('/api/password-reset/request', 'POST', {
    email: 'store@example.com',
  });
  const unknown = await visitor('/api/password-reset/request', 'POST', {
    email: 'missing@example.com',
  });
  assert.equal(known.status, 200);
  assert.deepEqual(known.value, unknown.value);
  assert.equal(messages.length, 1);
  assert.equal(new URL(messages[0].resetUrl).origin, 'https://workspace.example');
  assert.ok(!JSON.stringify(known.value).includes('token'));
});

test('unconfigured recovery honestly directs both known and unknown users to YYC', async (t) => {
  const { client } = await setup(t);
  const visitor = client();
  const known = await visitor('/api/password-reset/request', 'POST', {
    email: 'store@example.com',
  });
  const unknown = await visitor('/api/password-reset/request', 'POST', {
    email: 'missing@example.com',
  });
  assert.equal(known.status, 503);
  assert.deepEqual(known.value, unknown.value);
});

test('disabled accounts lose access and offers; brokers can re-enable without reviving sessions', async (t) => {
  const { admin, store, driver, driverId, client } = await setup(t);
  await admin(`/api/drivers/${driverId}/approve`, 'POST', {});
  const id = (await store('/api/shipments', 'POST', booking())).value.id;
  await action(admin, id, 'quote', { price: 450, rate: 300 });
  await action(store, id, 'acceptQuote');
  await action(admin, id, 'offer', { driverId });
  const resetToken = tokenOf(await issue(admin, driverId));
  assert.equal(
    (
      await store(`/api/accounts/${driverId}/status`, 'POST', {
        disabled: true,
        reason: 'Unauthorized',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await admin(`/api/accounts/${driverId}/status`, 'POST', {
        disabled: true,
        reason: 'Driver requested suspension',
      })
    ).status,
    200,
  );
  assert.equal((await driver('/api/state')).status, 401);
  assert.equal(
    (
      await client()('/api/login', 'POST', {
        email: 'driver@example.com',
        password: secret,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await client()('/api/password-reset/complete', 'POST', {
        token: resetToken,
        password: secret,
      })
    ).status,
    400,
  );
  const state = (await admin('/api/state')).value;
  assert.equal(state.shipments[0].status, 'Ready to assign');
  assert.equal(state.shipments[0].offeredTo, null);
  assert.ok(state.accounts.find((a) => a.id === driverId).disabled);
  assert.equal((await issue(admin, driverId)).status, 409);
  assert.equal(
    (
      await admin(`/api/accounts/${driverId}/status`, 'POST', {
        disabled: false,
        reason: 'Suspension ended',
      })
    ).status,
    200,
  );
  assert.equal((await driver('/api/state')).status, 401);
  await login(driver, 'driver@example.com');
  const ownId = state.user.id;
  assert.equal(
    (
      await admin(`/api/accounts/${ownId}/status`, 'POST', {
        disabled: true,
        reason: 'Self',
      })
    ).status,
    400,
  );
  assert.equal((await store('/api/state')).value.accounts.length, 0);
});

test('concurrent reset completions permit exactly one credential change', async (t) => {
  const { admin, store, client } = await setup(t);
  const id = (await store('/api/state')).value.user.id;
  const token = tokenOf(await issue(admin, id));
  const replies = await Promise.all(
    ['New-password-one-123', 'New-password-two-123'].map((password) =>
      client()('/api/password-reset/complete', 'POST', { token, password }),
    ),
  );
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 400]);
});

test('disabled accounts cannot use configured email recovery', async (t) => {
  const messages = [];
  const { admin, store, client } = await setup(t, {
    sendResetLink: async (message) => messages.push(message),
  });
  const id = (await store('/api/state')).value.user.id;
  await admin(`/api/accounts/${id}/status`, 'POST', {
    disabled: true,
    reason: 'Suspended',
  });
  assert.equal(
    (
      await client()('/api/password-reset/request', 'POST', {
        email: 'store@example.com',
      })
    ).status,
    200,
  );
  assert.equal(messages.length, 0);
});

test('requests suspended while reading a body cannot mutate an account disabled in the meantime', async (t) => {
  const { admin, store, request, url } = await setup(t);
  const auth = await login(store, 'store@example.com');
  const id = (await store('/api/state')).value.user.id;
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const reading = new Promise((resolve) => {
    started = resolve;
  });
  const payload = JSON.stringify({
    name: 'Changed while disabled',
    phone: '555',
    address: 'Address',
    contact: 'Staff',
  });
  async function* body() {
    yield Buffer.from(payload.slice(0, 10));
    started();
    await gate;
    yield Buffer.from(payload.slice(10));
  }
  const pending = request(url + '/api/profile', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: auth.headers.get('set-cookie').split(';')[0],
      'X-CSRF-Token': auth.value.csrf,
    },
    body: body(),
  });
  await reading;
  await admin(`/api/accounts/${id}/status`, 'POST', {
    disabled: true,
    reason: 'Immediate suspension',
  });
  release();
  assert.equal((await pending).status, 401);
  const account = (await admin('/api/state')).value.accounts.find((a) => a.id === id);
  assert.equal(account.name, 'store Account');
});

test('failed email delivery revokes the token without exposing failure details or eligibility', async (t) => {
  let attempted;
  t.mock.method(console, 'error', () => {});
  const { client } = await setup(t, {
    sendResetLink: async (message) => {
      attempted = message;
      throw new Error('Provider secret must not be exposed');
    },
  });
  const visitor = client();
  const known = await visitor('/api/password-reset/request', 'POST', {
    email: 'store@example.com',
  });
  const unknown = await visitor('/api/password-reset/request', 'POST', {
    email: 'missing@example.com',
  });
  assert.equal(known.status, 200);
  assert.deepEqual(known.value, unknown.value);
  const token = new URLSearchParams(new URL(attempted.resetUrl).hash.slice(1)).get(
    'token',
  );
  assert.equal(
    (await visitor('/api/password-reset/complete', 'POST', { token, password: secret }))
      .status,
    400,
  );
});

test('credential verification cannot create a session after concurrent disable or password replacement', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { createHook } = await import('node:async_hooks');
  const directory = mkdtempSync(join(tmpdir(), 'yyc-login-race-'));
  const fixture = await setup(t, { databasePath: join(directory, 'race.sqlite') });
  const control = new DatabaseSync(join(directory, 'race.sqlite'));
  t.after(async () => {
    control.close();
    await fixture.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const target = control
    .prepare("SELECT id,password_hash FROM users WHERE email='store@example.com'")
    .get();
  for (const update of ['disabled=1', "password_hash='changed-during-verification'"]) {
    let changed = false;
    const before = control
      .prepare('SELECT count(*) AS total FROM sessions WHERE user_id=?')
      .get(target.id).total;
    const hook = createHook({
      init(_id, type) {
        if (type === 'SCRYPTREQUEST' && !changed) {
          changed = true;
          control.prepare(`UPDATE users SET ${update} WHERE id=?`).run(target.id);
        }
      },
    });
    hook.enable();
    let result;
    try {
      result = await fixture.client()('/api/login', 'POST', {
        email: 'store@example.com',
        password: secret,
      });
    } finally {
      hook.disable();
    }
    assert.ok(changed);
    assert.equal(result.status, 401);
    assert.equal(
      control
        .prepare('SELECT count(*) AS total FROM sessions WHERE user_id=?')
        .get(target.id).total,
      before,
    );
    control
      .prepare('UPDATE users SET disabled=0,password_hash=? WHERE id=?')
      .run(target.password_hash, target.id);
  }
});
