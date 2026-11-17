import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  setup,
  start,
  booking,
  action,
  attachDeliveryEvidence,
  registration,
  login,
} from './helpers/app.mjs';
async function assigned(t, options) {
  const f = await setup(t, options);
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  const id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  await action(f.admin, id, 'quote', { price: 450, rate: 300 });
  await action(f.store, id, 'acceptQuote');
  await action(f.admin, id, 'offer', { driverId: f.driverId });
  await action(f.driver, id, 'acceptJob');
  return {
    ...f,
    id,
    state: async () =>
      (await f.admin('/api/state')).value.shipments.find((s) => s.id === id),
  };
}
const retryPlan = {
  date: '2099-11-06',
  window: '09:00–12:00',
  deliveryDeadline: '',
  estimatedMinutes: 60,
  travelBufferMinutes: 15,
  reason: 'Receiving team confirmed a new attempt',
};

test('failed delivery hides existing ETAs and routes and blocks publication until broker arranges the next action', async (t) => {
  let routes = 0;
  const f = await assigned(t, {
    calculateRoute: async (points) => {
      routes++;
      return {
        distanceMeters: 1000,
        durationSeconds: 600,
        legs: points.slice(1).map(() => ({ distanceMeters: 1000, durationSeconds: 600 })),
      };
    },
  });
  await action(f.driver, f.id, 'pickup');
  const eta = new Date(Date.now() + 3600000).toISOString();
  assert.equal(
    (await f.admin(`/api/shipments/${f.id}/tracking`, 'PATCH', { eta })).status,
    200,
  );
  const link = (await f.store(`/api/shipments/${f.id}/recipient-link`, 'POST', {})).value;
  const token = new URL(link.url).hash.slice('#track='.length);
  await action(f.driver, f.id, 'failDelivery', {
    reason: 'Dock closed',
    note: 'No unloading possible',
  });
  const view = await f.client()('/api/recipient-tracking', 'POST', { token });
  assert.equal(view.value.status, 'Delivery failed');
  assert.equal(view.value.eta, null);
  assert.equal((await f.driver(`/api/shipments/${f.id}/route`)).value, null);
  assert.equal((await f.driver(`/api/shipments/${f.id}/route`, 'POST', {})).status, 409);
  assert.equal(
    (await f.admin(`/api/shipments/${f.id}/tracking`, 'PATCH', { eta })).status,
    409,
  );
  const gps = await f.driver(`/api/shipments/${f.id}/tracking`, 'POST', {
    latitude: 51,
    longitude: -114,
    accuracy: 10,
  });
  assert.equal(gps.status, 200);
  assert.equal(routes, 0);
  assert.equal((await f.store(`/api/shipments/${f.id}/tracking`)).value.eta, null);
  await action(f.admin, f.id, 'redeliver', retryPlan);
  assert.equal(
    (await f.admin(`/api/shipments/${f.id}/tracking`, 'PATCH', { eta })).status,
    200,
  );
});

test('redelivery needs fresh current-attempt proof, including a reserved file slot after earlier attempts fill the allowance', async (t) => {
  const fixed = Date.now(),
    f = await assigned(t, { now: () => fixed });
  for (let n = 0; n < 10; n++) await attachDeliveryEvidence(f.driver, f.id);
  await action(f.driver, f.id, 'pickup');
  await attachDeliveryEvidence(f.driver, f.id);
  const first = await f.state();
  assert.equal(first.deliveryAttempt, 1);
  assert.equal(first.evidenceCount, 1);
  await action(f.driver, f.id, 'failDelivery', {
    reason: 'No receiver',
    note: 'Documented failed attempt',
  });
  // Uploads made during the hold also cannot qualify as successful delivery proof.
  await action(f.admin, f.id, 'redeliver', retryPlan);
  let s = await f.state();
  assert.equal(s.deliveryAttempt, 2);
  assert.equal(s.evidenceCount, 0);
  await action(f.driver, f.id, 'arrival');
  await action(
    f.driver,
    f.id,
    'deliver',
    { pod: 'NEW-RECEIPT', recipient: 'Receiving staff' },
    409,
  );
  await attachDeliveryEvidence(f.driver, f.id);
  s = await f.state();
  assert.equal(s.evidenceCount, 1);
  const files = (await f.driver(`/api/shipments/${f.id}/evidence`)).value;
  assert.equal(files.length, 12);
  const result = await f.driver(`/api/shipments/${f.id}/actions`, 'POST', {
    action: 'deliver',
    version: s.version,
    pod: 'NEW-RECEIPT',
    recipient: 'Receiving staff',
  });
  assert.equal(result.status, 200);
  assert.equal((await f.state()).deliveryEvidence.attempt, 2);
});

test('payout reversals remain available during legacy allocation review and unblock the correct split', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'yyc-reversal-review-')),
    path = join(directory, 'app.sqlite');
  const f = await assigned(t, { databasePath: path });
  await action(f.driver, f.id, 'pickup');
  const next = f.client(),
    email = 'reversal-next@example.com';
  const nextId = (await next('/api/register', 'POST', registration('driver', email)))
    .value.id;
  await login(next, email);
  await f.admin(`/api/drivers/${nextId}/approve`, 'POST', {});
  await action(f.admin, f.id, 'handover', { driverId: nextId, reason: 'Transfer cargo' });
  await action(next, f.id, 'acceptJob');
  await action(next, f.id, 'deliver', { pod: 'LEGACY', recipient: 'Staff' });
  const s = await f.state(),
    shares = [
      { driverId: f.driverId, amount: 100, reason: 'First leg' },
      { driverId: nextId, amount: 200, reason: 'Final leg' },
    ];
  let invoice = (
    await f.admin('/api/invoices', 'POST', {
      shipmentId: f.id,
      version: s.version,
      allocations: shares,
    })
  ).value;
  const db = new DatabaseSync(path);
  db.prepare('DELETE FROM invoice_allocations WHERE invoice_id=?').run(invoice.id);
  db.prepare('INSERT INTO invoice_allocations VALUES (?,?,?,?)').run(
    invoice.id,
    nextId,
    30000,
    'Legacy full payment',
  );
  db.prepare(
    "INSERT INTO invoice_entries(id,invoice_id,request_key,kind,amount_cents,reference,reason,actor_id,created_at,driver_id) VALUES (?,?,?,'payout',30000,'LEGACY','Verified previous transfer',?,?,?)",
  ).run(
    randomUUID(),
    invoice.id,
    randomUUID(),
    s.driverId,
    new Date().toISOString(),
    nextId,
  );
  db.close();
  invoice = (await f.admin('/api/invoices')).value[0];
  assert.equal(invoice.allocationRequired, true);
  const body = {
    version: invoice.version,
    kind: 'payoutRefund',
    amount: 100,
    driverId: nextId,
    requestKey: randomUUID(),
    reference: 'BANK-REVERSAL',
    reason: 'Reverse excess before applying correct shares',
  };
  assert.equal(
    (await f.store(`/api/invoices/${invoice.id}/entries`, 'POST', body)).status,
    403,
  );
  assert.equal(
    (
      await f.admin(`/api/invoices/${invoice.id}/entries`, 'POST', {
        ...body,
        amount: 301,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.admin(`/api/invoices/${invoice.id}/entries`, 'POST', {
        ...body,
        kind: 'payout',
        amount: 1,
        requestKey: randomUUID(),
      })
    ).status,
    409,
  );
  let reply = await f.admin(`/api/invoices/${invoice.id}/entries`, 'POST', body);
  assert.equal(reply.status, 200);
  invoice = reply.value;
  assert.equal(
    (await f.admin(`/api/invoices/${invoice.id}/entries`, 'POST', body)).status,
    200,
  );
  reply = await f.admin(`/api/invoices/${invoice.id}/allocations`, 'POST', {
    version: invoice.version,
    allocations: shares,
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.value.allocationRequired, false);
  assert.equal((await next('/api/settlements')).value[0].paidCents, 20000);
  assert.equal((await f.driver('/api/settlements')).value[0].dueCents, 10000);
  await f.stop();
  rmSync(directory, { recursive: true, force: true });
});

test('migration retains unambiguous first-attempt files but requires fresh proof for legacy retry files', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'yyc-attempt-migration-')),
    path = join(directory, 'app.sqlite');
  const f = await assigned(t, { databasePath: path });
  await action(f.driver, f.id, 'pickup');
  await attachDeliveryEvidence(f.driver, f.id);
  await f.stop();
  let db = new DatabaseSync(path);
  db.exec('ALTER TABLE evidence DROP COLUMN delivery_attempt;');
  db.close();
  const first = await start(t, { databasePath: path }),
    driver = first.client(),
    broker = first.client();
  await login(driver, 'driver@example.com');
  await login(broker, 'admin@example.com');
  assert.equal((await driver('/api/state')).value.shipments[0].evidenceCount, 1);
  await action(driver, f.id, 'failDelivery', {
    reason: 'Receiver absent',
    note: 'Try again',
  });
  await action(broker, f.id, 'redeliver', retryPlan);
  await attachDeliveryEvidence(driver, f.id);
  await first.stop();
  db = new DatabaseSync(path);
  db.exec('ALTER TABLE evidence DROP COLUMN delivery_attempt;');
  db.close();
  const retry = await start(t, { databasePath: path }),
    retryDriver = retry.client();
  await login(retryDriver, 'driver@example.com');
  assert.equal((await retryDriver('/api/state')).value.shipments[0].evidenceCount, 0);
  await attachDeliveryEvidence(retryDriver, f.id);
  assert.equal((await retryDriver('/api/state')).value.shipments[0].evidenceCount, 1);
  await retry.stop();
  rmSync(directory, { recursive: true, force: true });
});
