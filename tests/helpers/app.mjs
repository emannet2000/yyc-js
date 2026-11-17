import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../../server/app.js';
export const secret = 'Test-password-123456';
export async function start(t, options = {}) {
  const app = createApplication({ databasePath: ':memory:', ...options });
  const live = process.env.YYC_LIVE_TESTS === 'true';
  if (live) {
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
  }
  const url = live
    ? `http://127.0.0.1:${app.server.address().port}`
    : 'http://127.0.0.1:3000';
  let closed = false;
  const stop = async () => {
    if (closed) return;
    closed = true;
    if (live) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
    app.close();
  };
  t.after(stop);
  // Exercise the actual HTTP request handler without binding a socket in restricted environments.
  const request = live
    ? (input, options = {}) =>
        fetch(input, {
          ...options,
          ...(options.body && typeof options.body !== 'string' ? { duplex: 'half' } : {}),
        })
    : async (input, options = {}) =>
        new Promise((resolve) => {
          const url = new URL(input),
            req = Readable.from(
              typeof options.body === 'string'
                ? [Buffer.from(options.body)]
                : options.body || [],
            );
          req.url = url.pathname + url.search;
          req.method = options.method || 'GET';
          req.socket = { remoteAddress: '127.0.0.1' };
          req.headers = {
            host: url.host,
            ...Object.fromEntries(
              Object.entries(options.headers || {}).map(([key, value]) => [
                key.toLowerCase(),
                value,
              ]),
            ),
          };
          let status = 200;
          const headers = new Headers();
          const res = {
            headersSent: false,
            setHeader(key, value) {
              headers.set(key, value);
            },
            writeHead(code, values) {
              status = code;
              this.headersSent = true;
              for (const [key, value] of Object.entries(values)) headers.set(key, value);
            },
            end(body) {
              resolve(new Response(body, { status, headers }));
            },
          };
          app.server.emit('request', req, res);
        });
  function client() {
    let cookie = '',
      csrf = '';
    return async (path, method = 'GET', body, overrides = {}) => {
      const response = await request(url + path, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(path === '/api/shipments' && method === 'POST'
            ? { 'Idempotency-Key': randomUUID() }
            : {}),
          Cookie: cookie,
          'X-CSRF-Token': csrf,
          ...overrides,
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
      if (response.headers.has('set-cookie'))
        cookie = response.headers.get('set-cookie').split(';')[0];
      const value = (response.headers.get('content-type') || '').includes(
        'application/json',
      )
        ? await response.json()
        : await response.text();
      if (path === '/api/login' && response.ok) csrf = value.csrf;
      return { status: response.status, value, headers: response.headers };
    };
  }
  return { app, client, url, request, stop };
}
export const registration = (role, email) => ({
  role,
  name: role + ' Account',
  email,
  password: secret,
  phone: '555-0100',
  address: 'Store address',
  contact: 'Receiver',
  truck: 'Truck model',
  plate: email,
  type: 'Box truck',
  kg: 3500,
  pallets: 8,
  area: 'Calgary',
  liftgate: true,
});
export const booking = (window = '09:00–12:00') => ({
  pickup: 'Warehouse address',
  destination: 'Store address',
  date: '2099-11-05',
  window,
  goods: 'Dry goods',
  kg: 900,
  pallets: 4,
  type: 'Box truck',
  unloading: 'Liftgate required',
  pickupContact: 'Warehouse team',
  receivingContact: 'Store team',
  hours: '09:00–17:00',
});
export async function login(client, email) {
  const response = await client('/api/login', 'POST', { email, password: secret });
  assert.equal(response.status, 200);
  return response;
}
export async function setup(t, options) {
  const server = await start(t, options);
  const admin = server.client(),
    store = server.client(),
    driver = server.client(),
    other = server.client();
  await server.app.createAdmin({ ...registration('admin', 'admin@example.com') });
  for (const [client, role, email] of [
    [store, 'store', 'store@example.com'],
    [driver, 'driver', 'driver@example.com'],
    [other, 'store', 'other@example.com'],
  ]) {
    assert.equal(
      (await client('/api/register', 'POST', registration(role, email))).status,
      201,
    );
    await login(client, email);
  }
  await login(admin, 'admin@example.com');
  const driverId = (await driver('/api/state')).value.user.id;
  return { ...server, admin, store, driver, other, driverId };
}
export const proofFile = {
  name: 'delivery-receipt.pdf',
  mime: 'application/pdf',
  content: Buffer.from('%PDF-1.4\nDelivery receipt fixture').toString('base64'),
};
export async function attachDeliveryEvidence(client, id) {
  const s = (await client('/api/state')).value.shipments.find((s) => s.id === id);
  assert.equal(
    (
      await client(`/api/shipments/${id}/evidence`, 'POST', {
        ...proofFile,
        version: s.version,
      })
    ).status,
    201,
  );
}
// Successful delivery scenarios include the required evidence milestones.
// Guard/rollback tests use raw requests or an explicit non-success expectation.
export async function action(client, id, actionName, data = {}, expected = 200) {
  if (actionName === 'deliver' && expected === 200) {
    const current = (await client('/api/state')).value.shipments.find((s) => s.id === id);
    if (!current.arrivedAt) await action(client, id, 'arrival');
    if (!current.evidenceCount) await attachDeliveryEvidence(client, id);
  }
  const s = (await client('/api/state')).value.shipments.find((s) => s.id === id);
  const response = await client(`/api/shipments/${id}/actions`, 'POST', {
    version: s.version,
    action: actionName,
    ...data,
  });
  assert.equal(response.status, expected, JSON.stringify(response.value));
  return response;
}
