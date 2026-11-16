import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, booking, action } from './helpers/app.mjs';
async function job(t, options) {
  const f = await setup(t, options);
  const id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  await action(f.admin, id, 'quote', { price: 450, rate: 300 });
  await action(f.store, id, 'acceptQuote');
  await action(f.admin, id, 'offer', { driverId: f.driverId });
  await action(f.driver, id, 'acceptJob');
  return { ...f, id, endpoint: `/api/shipments/${id}/mobile-devices` };
}
async function paired(f) {
  const response = await f.driver(f.endpoint, 'POST', {});
  assert.equal(response.status, 201, JSON.stringify(response.value));
  const guest = f.client();
  const pair = await guest('/api/mobile/pair', 'POST', {
    code: response.value.code,
    name: 'Android test phone',
  });
  assert.equal(pair.status, 201, JSON.stringify(pair.value));
  const headers = { Authorization: `Bearer ${pair.value.token}` };
  return { guest, headers, value: pair.value, code: response.value.code };
}
test('Android pairing is one-time and credentials can only track the assigned delivery', async (t) => {
  const f = await job(t),
    p = await paired(f);
  assert.equal(
    (await p.guest('/api/mobile/pair', 'POST', { code: p.code, name: 'Second phone' }))
      .status,
    401,
  );
  assert.equal(
    (await p.guest('/api/mobile/status', 'GET', undefined, p.headers)).status,
    200,
  );
  assert.equal((await p.guest('/api/state', 'GET', undefined, p.headers)).status, 401);
  assert.equal((await p.guest('/api/mobile/status')).status, 401);
  const sample = { latitude: 51, longitude: -114, accuracy: 10 };
  assert.equal(
    (await p.guest('/api/mobile/location', 'POST', sample, p.headers)).status,
    200,
  );
  assert.equal((await f.driver(`/api/shipments/${f.id}/tracking`)).value.latitude, 51);
  assert.equal(
    (
      await p.guest(
        '/api/mobile/location',
        'POST',
        { ...sample, latitude: 95 },
        p.headers,
      )
    ).status,
    400,
  );
  const devices = await f.driver(f.endpoint);
  assert.equal(devices.value.length, 1);
  assert.ok(devices.value[0].lastSeenAt);
  assert.ok(!JSON.stringify(devices.value).includes(p.value.token));
  assert.equal((await f.store(f.endpoint)).status, 403);
  assert.equal((await f.admin(f.endpoint, 'POST', {})).status, 403);
});
test('rotating or revoking Android phones immediately invalidates the old token', async (t) => {
  const f = await job(t),
    first = await paired(f),
    second = await paired(f);
  assert.equal(
    (await first.guest('/api/mobile/status', 'GET', undefined, first.headers)).status,
    401,
  );
  assert.equal(
    (await second.guest('/api/mobile/status', 'GET', undefined, second.headers)).status,
    200,
  );
  assert.equal(
    (await f.admin(`${f.endpoint}/${second.value.deviceId}`, 'DELETE', {})).status,
    200,
  );
  assert.equal(
    (
      await second.guest(
        '/api/mobile/location',
        'POST',
        { latitude: 51, longitude: -114, accuracy: 10 },
        second.headers,
      )
    ).status,
    401,
  );
});
test('Android tracking stops after completion, account disabling, or assignment loss', async (t) => {
  const f = await job(t),
    p = await paired(f);
  await action(f.driver, f.id, 'pickup');
  await action(f.driver, f.id, 'deliver', { pod: 'POD', recipient: 'Staff' });
  assert.equal(
    (await p.guest('/api/mobile/status', 'GET', undefined, p.headers)).status,
    401,
  );
  assert.equal((await f.driver(f.endpoint, 'POST', {})).status, 403);
  const g = await job(t),
    q = await paired(g);
  await action(g.admin, g.id, 'change', {
    destination: 'Revised destination',
    kg: 900,
    pallets: 4,
    reason: 'Customer changed address',
  });
  assert.equal(
    (
      await q.guest(
        '/api/mobile/location',
        'POST',
        { latitude: 51, longitude: -114, accuracy: 10 },
        q.headers,
      )
    ).status,
    401,
  );
  const h = await job(t),
    r = await paired(h);
  assert.equal(
    (
      await h.admin(`/api/accounts/${h.driverId}/status`, 'POST', {
        disabled: true,
        reason: 'Account verification',
      })
    ).status,
    200,
  );
  assert.equal(
    (await r.guest('/api/mobile/status', 'GET', undefined, r.headers)).status,
    401,
  );
  await h.admin(`/api/accounts/${h.driverId}/status`, 'POST', {
    disabled: false,
    reason: 'Verified again',
  });
  assert.equal(
    (await r.guest('/api/mobile/status', 'GET', undefined, r.headers)).status,
    401,
  );
});
test('pairing expires in five minutes, phone authorization in seven days, and disconnect revokes it', async (t) => {
  let time = Date.now();
  const f = await job(t, { now: () => time });
  const code = (await f.driver(f.endpoint, 'POST', {})).value.code;
  time += 5 * 60000 + 1;
  assert.equal(
    (await f.client()('/api/mobile/pair', 'POST', { code, name: 'Phone' })).status,
    401,
  );
  const p = await paired(f);
  assert.equal(
    (await p.guest('/api/mobile/disconnect', 'POST', {}, p.headers)).status,
    200,
  );
  assert.equal(
    (await p.guest('/api/mobile/status', 'GET', undefined, p.headers)).status,
    401,
  );
  const q = await paired(f);
  time += 7 * 86400000 + 1;
  assert.equal(
    (await q.guest('/api/mobile/status', 'GET', undefined, q.headers)).status,
    401,
  );
});
test('native GPS triggers throttled server-side road ETA updates without browser requests', async (t) => {
  let time = Date.now(),
    calls = 0;
  const f = await job(t, {
      now: () => time,
      calculateRoute: async (points) => {
        calls++;
        return {
          durationSeconds: 900,
          distanceMeters: 12000,
          legs: points
            .slice(1)
            .map(() => ({ durationSeconds: 450, distanceMeters: 6000 })),
        };
      },
    }),
    p = await paired(f);
  const sample = { latitude: 51, longitude: -114, accuracy: 10 };
  const location = () => p.guest('/api/mobile/location', 'POST', sample, p.headers);
  assert.equal((await location()).status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  const tracked = (await f.driver(`/api/shipments/${f.id}/tracking`)).value;
  assert.equal(tracked.etaSource, 'road-route');
  assert.equal(tracked.eta, new Date(time + 450000).toISOString());
  await location();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  time += 60001;
  await location();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
});

test('phone authorization survives restart, secrets are hashed, and restore revokes phone access', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { createHash } = await import('node:crypto');
  const { backupDatabase, restoreDatabase } = await import('../server/backup.js');
  const { start } = await import('./helpers/app.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'yyc-mobile-'));
  const source = join(directory, 'source.sqlite'),
    snapshot = join(directory, 'snapshot.sqlite'),
    recovered = join(directory, 'recovered.sqlite');
  const f = await job(t, { databasePath: source }),
    p = await paired(f);
  const pending = (await f.driver(f.endpoint, 'POST', {})).value;
  const check = new DatabaseSync(source, { readOnly: true });
  assert.equal(
    check.prepare('SELECT token_hash FROM mobile_devices').get().token_hash,
    createHash('sha256').update(p.value.token).digest('hex'),
  );
  assert.equal(
    check.prepare('SELECT code_hash FROM mobile_pairings').get().code_hash,
    createHash('sha256').update(pending.code.replaceAll('-', '')).digest('hex'),
  );
  check.close();
  backupDatabase(source, snapshot);
  await f.stop();
  const reopened = await start(t, { databasePath: source });
  assert.equal(
    (await reopened.client()('/api/mobile/status', 'GET', undefined, p.headers)).status,
    200,
  );
  await reopened.stop();
  restoreDatabase(snapshot, recovered);
  const restored = await start(t, { databasePath: recovered });
  assert.equal(
    (await restored.client()('/api/mobile/status', 'GET', undefined, p.headers)).status,
    401,
  );
  assert.equal(
    (
      await restored.client()('/api/mobile/pair', 'POST', {
        code: pending.code,
        name: 'Phone',
      })
    ).status,
    401,
  );
  await restored.stop();
  rmSync(directory, { recursive: true, force: true });
});
