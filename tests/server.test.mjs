import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createLoginLimiter } from '../server/login-limiter.js';
import { createApplication } from '../server/app.js';
import { driverAvailable } from '../shared/scheduling.js';
import {
  start,
  setup,
  action,
  registration,
  booking,
  login,
  secret,
} from './helpers/app.mjs';
test('backend registration, sessions, CSRF, account isolation and static paths', async (t) => {
  const { client, admin, store, other, driver, driverId, url, request } = await setup(t);
  assert.equal((await client()('/api/state')).status, 401);
  assert.equal((await client()('/api/session')).value.user, null);
  assert.equal(
    (await client()('/api/register', 'POST', registration('admin', 'rogue@example.com')))
      .status,
    400,
  );
  assert.equal(
    (await client()('/api/register', 'POST', registration('store', 'STORE@EXAMPLE.COM')))
      .status,
    409,
  );
  assert.equal(
    (
      await store(
        '/api/profile',
        'PATCH',
        { name: 'New', phone: '555', address: 'New address', contact: 'Staff' },
        { 'X-CSRF-Token': '' },
      )
    ).status,
    403,
  );
  assert.equal(
    (await store('/api/profile', 'PATCH', {}, { Origin: 'https://evil.example' })).status,
    403,
  );
  assert.equal((await store(`/api/drivers/${driverId}/approve`, 'POST', {})).status, 403);
  assert.equal((await admin(`/api/drivers/${driverId}/approve`, 'POST', {})).status, 200);
  const id = (await store('/api/shipments', 'POST', booking())).value.id;
  assert.equal((await other('/api/state')).value.shipments.length, 0);
  assert.equal((await driver('/api/state')).value.shipments.length, 0);
  assert.equal(
    (
      await other(`/api/shipments/${id}/actions`, 'POST', {
        action: 'cancel',
        version: 1,
      })
    ).status,
    404,
  );
  assert.equal(
    (await store('/api/shipments', 'POST', { ...booking(), pallets: 1.5 })).status,
    400,
  );
  assert.equal(
    (await store('/api/shipments', 'POST', { ...booking(), date: '2099-02-30' })).status,
    400,
  );
  const staticResponse = await request(url + '/demo/');
  assert.equal(staticResponse.status, 200);
  assert.match(await staticResponse.text(), /YYC Brokers/);
  assert.equal((await request(url + '/assets/yyc-brokers-logo.jpg')).status, 200);
  assert.equal((await request(url + '/%2e%2e%2fpackage.json')).status, 404);
  const auth = await login(store, 'store@example.com');
  assert.match(auth.headers.get('set-cookie'), /HttpOnly/);
  assert.match(auth.headers.get('set-cookie'), /SameSite=Lax/);
  assert.equal((await store('/api/logout', 'POST', {})).status, 200);
  assert.equal((await store('/api/state')).status, 401);
});
test('backend enforces approvals, ownership, versions, scheduling and complete delivery lifecycle', async (t) => {
  const { admin, store, driver, driverId } = await setup(t);
  const id = (await store('/api/shipments', 'POST', booking())).value.id;
  await action(store, id, 'quote', { price: 450, rate: 300 }, 403);
  await action(admin, id, 'quote', { price: 450, rate: 500 }, 400);
  await action(admin, id, 'quote', { price: 450, rate: 300 });
  const customer = (await store('/api/state')).value.shipments[0];
  assert.equal(customer.rate, undefined);
  assert.equal(
    (
      await store(`/api/shipments/${id}/actions`, 'POST', {
        action: 'acceptQuote',
        version: 1,
      })
    ).status,
    409,
  );
  await action(store, id, 'acceptQuote');
  await action(admin, id, 'offer', { driverId }, 400);
  await admin(`/api/drivers/${driverId}/approve`, 'POST', {});
  await action(admin, id, 'offer', { driverId });
  assert.equal((await driver('/api/state')).value.shipments[0].price, undefined);
  const otherId = (await store('/api/shipments', 'POST', booking())).value.id;
  await action(admin, otherId, 'quote', { price: 450, rate: 300 });
  await action(store, otherId, 'acceptQuote');
  await action(admin, otherId, 'offer', { driverId }, 409);
  await action(driver, id, 'acceptJob');
  await action(driver, id, 'arrival');
  await action(driver, id, 'pickup');
  assert.equal(
    (await driver('/api/state')).value.shipments.find((s) => s.id === id).arrivedAt,
    undefined,
  );
  await action(driver, id, 'arrival');
  await action(driver, id, 'issue', { reason: 'Cargo damaged', note: 'Hold delivery' });
  await action(driver, id, 'deliver', { pod: 'POD-1', recipient: 'Receiver' }, 409);
  await action(store, id, 'resolve', { resolution: 'Wrong role' }, 403);
  await action(admin, id, 'resolve', { resolution: 'Receiving team approved handover' });
  await action(driver, id, 'deliver', { pod: 'POD-1', recipient: 'Receiver' });
  const shipment = (await store('/api/state')).value.shipments.find((s) => s.id === id);
  assert.equal(shipment.status, 'Delivered');
  assert.equal(shipment.pod, 'POD-1');
  assert.ok(
    shipment.history.some((event) =>
      event.text.includes('Receiving team approved handover'),
    ),
  );
  await action(driver, id, 'pickup', {}, 403);
  await action(admin, otherId, 'offer', { driverId });
});
test('backend revisions invalidate offers and archive quotations, decline and cancellation release reservations', async (t) => {
  const { admin, store, driver, driverId } = await setup(t);
  await admin(`/api/drivers/${driverId}/approve`, 'POST', {});
  const id = (await store('/api/shipments', 'POST', booking())).value.id;
  await action(admin, id, 'quote', { price: 450, rate: 300 });
  await action(store, id, 'acceptQuote');
  await action(admin, id, 'offer', { driverId });
  await action(driver, id, 'decline');
  await action(admin, id, 'offer', { driverId });
  await action(admin, id, 'change', {
    destination: 'New store address',
    kg: 950,
    pallets: 4,
    reason: 'Store changed',
  });
  const shipment = (await store('/api/state')).value.shipments[0];
  assert.equal(shipment.status, 'Awaiting quote');
  assert.equal(shipment.offeredTo, null);
  assert.equal(shipment.price, null);
  assert.equal(shipment.quoteVersion, 2);
  assert.equal(shipment.quoteArchive[0].price, 450);
  assert.equal(shipment.quoteArchive[0].rate, undefined);
  assert.equal((await driver('/api/state')).value.shipments.length, 0);
  await action(store, id, 'cancel');
  assert.equal((await store('/api/state')).value.shipments[0].status, 'Cancelled');
});
test('backend data survives restart without using the workspace database', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'yyc-server-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'test.sqlite');
  const app = createApplication({ databasePath: path });
  await app.createAdmin(registration('admin', 'persist@example.com'));
  app.close();
  const { client } = await start(t, { databasePath: path });
  const admin = client();
  await login(admin, 'persist@example.com');
  assert.equal((await admin('/api/state')).value.user.role, 'admin');
});
test('availability handles separate windows, flexible windows, offers, different dates and self', () => {
  const candidate = { id: 'a', date: '2099-01-01', window: '09:00–12:00' };
  const existing = {
    id: 'b',
    date: candidate.date,
    window: candidate.window,
    status: 'Assigned',
    driverId: 'driver',
  };
  assert.equal(driverAvailable(candidate, [existing], 'driver'), false);
  assert.equal(
    driverAvailable(candidate, [{ ...existing, window: 'Flexible' }], 'driver'),
    false,
  );
  assert.equal(
    driverAvailable(candidate, [{ ...existing, window: '13:00–16:00' }], 'driver'),
    true,
  );
  assert.equal(
    driverAvailable(candidate, [{ ...existing, date: '2099-01-02' }], 'driver'),
    true,
  );
  assert.equal(
    driverAvailable(
      candidate,
      [{ ...existing, status: 'Offered', driverId: null, offeredTo: 'driver' }],
      'driver',
    ),
    false,
  );
  assert.equal(
    driverAvailable(candidate, [{ ...existing, status: 'Delivered' }], 'driver'),
    true,
  );
  assert.equal(driverAvailable(candidate, [{ ...existing, id: 'a' }], 'driver'), true);
});

test('booking retries return the same record; changed payloads conflict and keys are account scoped', async (t) => {
  const { store, other } = await setup(t);
  const key = randomUUID(),
    headers = { 'Idempotency-Key': key };
  assert.equal(
    (await store('/api/shipments', 'POST', booking(), { 'Idempotency-Key': '' })).status,
    400,
  );
  const original = await store('/api/shipments', 'POST', booking(), headers);
  assert.equal(original.status, 201);
  const reordered = Object.fromEntries(Object.entries(booking()).reverse());
  const [retryA, retryB] = await Promise.all([
    store('/api/shipments', 'POST', reordered, headers),
    store('/api/shipments', 'POST', booking(), headers),
  ]);
  assert.deepEqual(retryA.value, original.value);
  assert.deepEqual(retryB.value, original.value);
  assert.equal(
    (await store('/api/shipments', 'POST', { ...booking(), kg: 1200 }, headers)).status,
    409,
  );
  const state = (await store('/api/state')).value;
  assert.equal(state.shipments.length, 1);
  assert.equal(state.shipments[0].history.length, 1);
  const separate = await other('/api/shipments', 'POST', booking(), headers);
  assert.equal(separate.status, 201);
  assert.notEqual(separate.value.id, original.value.id);
  assert.equal((await store('/api/shipments', 'POST', booking())).status, 201);
  assert.equal((await store('/api/state')).value.shipments.length, 2);
});

test('booking idempotency survives restart after the first response is lost', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'yyc-booking-retry-'));
  const databasePath = join(directory, 'test.sqlite');
  const first = await setup(t, { databasePath });
  const headers = { 'Idempotency-Key': randomUUID() };
  const committed = await first.store('/api/shipments', 'POST', booking(), headers);
  await first.stop();
  const second = await start(t, { databasePath });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = second.client();
  await login(store, 'store@example.com');
  const replayed = await store('/api/shipments', 'POST', booking(), headers);
  assert.equal(replayed.status, 201);
  assert.deepEqual(replayed.value, committed.value);
  assert.equal((await store('/api/state')).value.shipments.length, 1);
});

test('failed logins for one account do not block unrelated accounts behind the same proxy', async (t) => {
  const { client, other } = await setup(t);
  const attacker = client();
  for (let i = 0; i < 20; i++) {
    assert.equal(
      (
        await attacker('/api/login', 'POST', {
          email: 'STORE@EXAMPLE.COM',
          password: 'Wrong-password-12345',
        })
      ).status,
      401,
    );
  }
  assert.equal(
    (
      await attacker('/api/login', 'POST', {
        email: 'store@example.com',
        password: secret,
      })
    ).status,
    429,
  );
  await login(other, 'other@example.com');
  assert.equal(
    (
      await attacker('/api/login', 'POST', {
        email: 'store@example.com',
        password: secret,
      })
    ).status,
    429,
  );
});

test('login limits expire and successful attempts reset only their own account/address pair', () => {
  let time = 0;
  const limiter = createLoginLimiter({ now: () => time });
  let firstKey;
  for (let i = 0; i < 20; i++) {
    firstKey = limiter.reserve('proxy', 'first@example.com');
    assert.ok(firstKey);
  }
  assert.equal(limiter.reserve('proxy', 'first@example.com'), null);
  const otherKey = limiter.reserve('proxy', 'second@example.com');
  assert.ok(otherKey);
  limiter.succeed(otherKey);
  assert.equal(limiter.reserve('proxy', 'first@example.com'), null);
  assert.ok(limiter.reserve('other-proxy', 'first@example.com'));
  time = 15 * 60_000;
  assert.ok(limiter.reserve('proxy', 'first@example.com'));
  limiter.succeed(firstKey);
  assert.ok(limiter.reserve('proxy', 'first@example.com'));
});

test('state query count stays constant as shipments, histories and drivers increase', async (t) => {
  const { store, admin, client, other } = await setup(t);
  await store('/api/shipments', 'POST', booking());
  await other('/api/shipments', 'POST', booking());
  const queries = [],
    originalPrepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    queries.push(sql);
    return originalPrepare.call(this, sql);
  });
  await store('/api/state');
  const storeCount = queries.length;
  queries.length = 0;
  await admin('/api/state');
  const adminCount = queries.length;
  for (let i = 0; i < 20; i++)
    await store('/api/shipments', 'POST', { ...booking(), goods: `Cargo ${i}` });
  for (let i = 0; i < 2; i++)
    await client()(
      '/api/register',
      'POST',
      registration('driver', `extra${i}@example.com`),
    );
  queries.length = 0;
  const state = (await store('/api/state')).value;
  assert.equal(state.shipments.length, 21);
  assert.equal(queries.length, storeCount);
  assert.ok(state.shipments.every((s) => s.history.length === 1));
  assert.ok(queries.some((sql) => /WHERE s\.store_id=\?/.test(sql)));
  queries.length = 0;
  const adminState = (await admin('/api/state')).value;
  assert.equal(adminState.shipments.length, 22);
  assert.equal(adminState.drivers.length, 3);
  assert.equal(queries.length, adminCount);
});

test('duplicate registrations return conflicts without starting password hashing', async (t) => {
  const { client } = await setup(t);
  const { createHook } = await import('node:async_hooks');
  let hashes = 0;
  const hook = createHook({
    init(_id, type) {
      if (type === 'SCRYPTREQUEST') hashes++;
    },
  });
  hook.enable();
  try {
    const duplicateEmail = await client()(
      '/api/register',
      'POST',
      registration('store', 'STORE@EXAMPLE.COM'),
    );
    const duplicatePlate = await client()('/api/register', 'POST', {
      ...registration('driver', 'newdriver@example.com'),
      plate: 'driver@example.com',
    });
    assert.equal(duplicateEmail.status, 409);
    assert.equal(duplicatePlate.status, 409);
    assert.equal(hashes, 0);
  } finally {
    hook.disable();
  }
});

test('registration limits duplicate attempts without blocking login', async (t) => {
  const { app, client } = await start(t);
  await app.createAdmin(registration('admin', 'existing@example.com'));
  const visitor = client();
  for (let i = 0; i < 20; i++)
    assert.equal(
      (
        await visitor(
          '/api/register',
          'POST',
          registration('store', 'existing@example.com'),
        )
      ).status,
      409,
    );
  assert.equal(
    (await visitor('/api/register', 'POST', registration('store', 'fresh@example.com')))
      .status,
    429,
  );
  await login(visitor, 'existing@example.com');
});

test('concurrent registration hashes are bounded and slots are released after completion', async (t) => {
  const { client } = await start(t);
  const replies = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      client()(
        '/api/register',
        'POST',
        registration('store', `concurrent${index}@example.com`),
      ),
    ),
  );
  assert.equal(replies.filter((reply) => reply.status === 201).length, 4);
  assert.equal(replies.filter((reply) => reply.status === 429).length, 1);
  assert.equal(
    (
      await client()(
        '/api/register',
        'POST',
        registration('store', 'after-concurrent@example.com'),
      )
    ).status,
    201,
  );
});

test('concurrent registrations for the same email still create only one account', async (t) => {
  const { client } = await start(t);
  const replies = await Promise.all(
    Array.from({ length: 2 }, () =>
      client()('/api/register', 'POST', registration('store', 'racing@example.com')),
    ),
  );
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [201, 409]);
});

test('quotes reject fractional cents atomically and preserve exact valid cent amounts', async (t) => {
  const { store, admin } = await setup(t);
  const id = (await store('/api/shipments', 'POST', booking())).value.id;
  for (const data of [
    { price: 0.001, rate: 0.0005 },
    { price: 100, rate: 1.005 },
    { price: 1.005, rate: 1 },
    { price: 1e20, rate: 1 },
  ]) {
    await action(admin, id, 'quote', data, 400);
    const unchanged = (await admin('/api/state')).value.shipments[0];
    assert.equal(unchanged.version, 1);
    assert.equal(unchanged.price, null);
    assert.equal(unchanged.history.length, 1);
  }
  await action(admin, id, 'quote', { price: 0.29, rate: 0.01 });
  const quote = (await store('/api/state')).value.shipments[0];
  assert.equal(quote.price, 0.29);
  assert.equal(quote.status, 'Quote ready');
});

test('malformed encodings and invalid origins return controlled client errors', async (t) => {
  const { client } = await start(t);
  const visitor = client();
  for (const path of ['/api/%', '/api/%FF', '/demo/%E0%A4%A']) {
    const reply = await visitor(path);
    assert.equal(reply.status, 400);
    assert.equal(reply.value.error, 'Invalid request URL.');
  }
  for (const Origin of [
    'null',
    'not-a-url',
    'http://[',
    'file:///',
    'https://evil.example',
    'http://user@127.0.0.1:3000',
  ]) {
    const reply = await visitor(
      '/api/login',
      'POST',
      { email: 'test@example.com', password: secret },
      { Origin },
    );
    assert.equal(reply.status, 403, Origin);
  }
  const reply = await visitor('/api/session');
  assert.equal(reply.status, 200);
});
