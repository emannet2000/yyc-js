/**
 * Seed sample accounts for development / demo.
 *
 * Usage:  node scripts/seed.js
 *
 * Sample credentials:
 *   Broker  broker@yyc.dev   Demo-Broker-2026
 *   Store   store@yyc.dev    Demo-Store-2026
 *   Driver  driver@yyc.dev   Demo-Driver-2026
 */
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server/app.js';

const PATH = process.env.DATABASE_PATH || 'data/yyc.sqlite';

const ACCOUNTS = [
  {
    role: 'broker',
    name: 'YYC Demo Broker',
    email: 'broker@yyc.dev',
    password: 'Demo-Broker-2026',
    phone: '403-555-0100',
  },
  {
    role: 'store',
    name: 'Demo Store',
    email: 'store@yyc.dev',
    password: 'Demo-Store-2026',
    phone: '403-555-0200',
    address: '100 Demo St NE, Calgary AB',
    contact: 'Store Receiver',
  },
  {
    role: 'driver',
    name: 'Demo Driver',
    email: 'driver@yyc.dev',
    password: 'Demo-Driver-2026',
    phone: '403-555-0300',
    truck: 'Freightliner M2 106',
    plate: 'YYC-DEMO',
    type: 'Box truck',
    kg: 5000,
    pallets: 10,
    area: 'Calgary Metro',
    liftgate: true,
  },
];

const app = createApplication({ databasePath: PATH });

function call(path, method, body, cookie = '', csrf = '') {
  return new Promise((resolve) => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    req.url = path;
    req.method = method;
    req.socket = { remoteAddress: '127.0.0.1' };
    req.headers = {
      host: '127.0.0.1:3000',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...(path === '/api/shipments' && method === 'POST'
        ? { 'idempotency-key': randomUUID() }
        : {}),
    };
    let status = 200, respCookie = '', respBody = '';
    const res = {
      headersSent: false,
      setHeader(key, value) {
        if (key.toLowerCase() === 'set-cookie') respCookie = value;
      },
      writeHead(code, hdrs = {}) {
        status = code;
        this.headersSent = true;
        for (const [k, v] of Object.entries(hdrs))
          if (k.toLowerCase() === 'set-cookie') respCookie = v;
      },
      end(b) {
        respBody = b || '';
        resolve({
          status,
          cookie: (respCookie || '').split(';')[0],
          body: respBody ? JSON.parse(respBody) : {},
        });
      },
    };
    app.server.emit('request', req, res);
  });
}

async function login(email, password) {
  const r = await call('/api/login', 'POST', { email, password });
  if (r.status !== 200) throw new Error(`Login failed for ${email}: ${JSON.stringify(r.body)}`);
  return { cookie: r.cookie, csrf: r.body.csrf };
}

try {
  // Broker — created via internal helper (bypasses /api/setup one-time lock)
  const broker = ACCOUNTS.find((a) => a.role === 'broker');
  await app.createAdmin({
    name: broker.name,
    email: broker.email,
    password: broker.password,
    phone: broker.phone,
  });
  console.log(`✔  Broker  ${broker.email}  /  ${broker.password}`);

  // Store and Driver — registered through the public endpoint
  for (const acc of ACCOUNTS.filter((a) => a.role !== 'broker')) {
    const r = await call('/api/register', 'POST', { ...acc, role: acc.role });
    if (r.status === 201) {
      console.log(`✔  ${acc.role.padEnd(6)}  ${acc.email}  /  ${acc.password}`);
    } else {
      console.log(`⚠  ${acc.role} ${acc.email}: ${JSON.stringify(r.body)}`);
    }
  }

  // Approve the demo driver as the broker
  const { cookie, csrf } = await login(broker.email, broker.password);
  const state = await call('/api/state', 'GET', null, cookie, csrf);
  const driver = state.body.accounts?.find(
    (a) => a.role === 'driver' && a.email === 'driver@yyc.dev',
  );
  if (driver) {
    const ap = await call(`/api/drivers/${driver.id}/approve`, 'POST', {}, cookie, csrf);
    if (ap.status === 200) console.log(`✔  Driver approved`);
  }

  console.log('\nLog in at  http://127.0.0.1:3000/react/');
  console.log(`  Broker  broker@yyc.dev    Demo-Broker-2026`);
  console.log(`  Store   store@yyc.dev     Demo-Store-2026`);
  console.log(`  Driver  driver@yyc.dev    Demo-Driver-2026`);
} catch (e) {
  console.error('Seed failed:', e.message);
  process.exitCode = 1;
} finally {
  app.close();
}
