import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApplication } from '../server/app.js';
import { registration } from './helpers/app.mjs';

async function readUntil(reader, pattern, ms = 3000) {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 200)),
    ]);
    if (chunk.timeout) continue;
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
    if (pattern.test(text)) return text;
  }
  return text;
}

test('open browsers are told when a change is saved, and only signed-in users can subscribe', async (t) => {
  const app = createApplication({ databasePath: ':memory:' });
  t.after(async () => {
    app.closeStreams();
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    app.close();
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const register = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(registration('store', 'live@example.com')),
  });
  assert.equal(register.status, 201);
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'live@example.com',
      password: registration('store', 'x').password,
    }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrf } = await login.json();

  assert.equal((await fetch(`${base}/api/events`)).status, 401);

  const stream = await fetch(`${base}/api/events`, { headers: { cookie } });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const reader = stream.body.getReader();

  const save = await fetch(`${base}/api/profile`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      cookie,
      'x-csrf-token': csrf,
    },
    body: JSON.stringify({
      name: 'Live Store',
      phone: '403-555-0300',
      address: '1 Main St',
      contact: 'Receiving',
    }),
  });
  assert.equal(save.status, 200);

  const seen = await readUntil(reader, /event: changed/);
  assert.match(seen, /event: changed/);
  await reader.cancel();
});

test('failed writes do not trigger a change signal', async (t) => {
  const app = createApplication({ databasePath: ':memory:' });
  t.after(async () => {
    app.closeStreams();
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    app.close();
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const reg = registration('store', 'quiet@example.com');
  await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reg),
  });
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'quiet@example.com', password: reg.password }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrf } = await login.json();
  const reader = (
    await fetch(`${base}/api/events`, { headers: { cookie } })
  ).body.getReader();
  const rejected = await fetch(`${base}/api/profile`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', cookie, 'x-csrf-token': csrf },
    body: JSON.stringify({ name: '' }),
  });
  assert.ok(rejected.status >= 400);
  assert.doesNotMatch(await readUntil(reader, /event: changed/, 800), /event: changed/);
  await reader.cancel();
});

test('transports that cannot stream get a clear 501 and the browser falls back to polling', async () => {
  const { createLiveEvents } = await import('../server/live-events.js');
  const events = createLiveEvents();
  let status = 0;
  let body = '';
  const res = {
    writeHead(code) {
      status = code;
    },
    end(text) {
      body = text;
    },
  };
  const req = { on() {} };
  assert.equal(events.subscribe(req, res), true);
  assert.equal(status, 501);
  assert.match(body, /not available/);
  assert.equal(events.count(), 0);
});
