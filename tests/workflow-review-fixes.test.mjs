import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setup, booking, action } from './helpers/app.mjs';
import { createWorkflow } from '../server/workflow.js';

async function job(f, driver, driverId, input = {}) {
  const id = (
    await f.store('/api/shipments', 'POST', { ...booking(), kg: 3000, ...input })
  ).value.id;
  await action(f.admin, id, 'quote', { price: 450, rate: 300 });
  await action(f.store, id, 'acceptQuote');
  await action(f.admin, id, 'offer', { driverId });
  await action(driver, id, 'acceptJob');
  return id;
}

const shipment = async (client, id) =>
  (await client('/api/state')).value.shipments.find((s) => s.id === id);

test('a broker can withdraw a pending driver rate proposal and the driver is no longer asked to respond', async (t) => {
  const f = await setup(t);
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  const id = await job(f, f.driver, f.driverId);
  await action(f.admin, id, 'changeRate', { rate: 280, reason: 'Market rate' });
  assert.ok((await shipment(f.admin, id)).rateChange);

  await action(f.store, id, 'withdrawRateChange', { reason: 'Owner' }, 403);
  await action(f.driver, id, 'withdrawRateChange', { reason: 'Driver' }, 403);
  await action(f.admin, id, 'withdrawRateChange', { reason: 'Entered in error' });

  const s = await shipment(f.admin, id);
  assert.equal(s.rateChange, undefined);
  assert.equal(s.rate, 300);
  assert.equal(s.driverId, f.driverId);
  await action(f.driver, id, 'acceptRate', {}, 403);
  await action(f.admin, id, 'withdrawRateChange', { reason: 'Again' }, 409);
});

test('a driver whose approvals are not current cannot accept a proposed rate, but can still keep the agreed rate', async () => {
  const workflow = createWorkflow({
    now: Date.now,
    requireThat(condition, status, message) {
      if (!condition) throw Object.assign(new Error(message), { status });
    },
    text: (data, key) => data[key],
    positive: (data, key) => data[key],
    money: (data, key) => data[key],
  });
  const shipment = () => ({
    id: 'SH-1',
    status: 'Assigned',
    price: 450,
    rate: 300,
    driverId: 'drv',
    offeredTo: null,
    rateVersion: 1,
    rateChange: { driverId: 'drv', rate: 280, reason: 'Market', requestedAt: '' },
  });
  const user = { id: 'drv', role: 'driver', approved: false, truck: { approved: true } };
  assert.throws(() => workflow.apply(shipment(), user, { action: 'acceptRate' }), {
    status: 403,
  });
  const s = shipment();
  workflow.apply(s, user, { action: 'declineRate' });
  assert.equal(s.rate, 300);
  assert.equal(s.rateChange, undefined);
});

test('a cancellation approved after a return started keeps the broker return instructions', async (t) => {
  const f = await setup(t);
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  const id = await job(f, f.driver, f.driverId);
  await action(f.driver, id, 'pickup');
  await action(f.store, id, 'requestChange', {
    kind: 'cancellation',
    details: 'Stop the load',
  });
  await action(f.admin, id, 'return', { reason: 'Return to pickup' });
  const requestId = (await shipment(f.admin, id)).customerRequests.find(
    (r) => r.status === 'pending',
  ).id;

  await action(f.admin, id, 'respondRequest', {
    requestId,
    decision: 'approve',
    response: 'Owner approved',
  });

  const s = await shipment(f.admin, id);
  assert.equal(s.status, 'Returning');
  assert.equal(s.returnReason, 'Return to pickup');
  assert.equal(s.customerRequests.find((r) => r.id === requestId).status, 'approved');
});

test('arrival during a return is recorded as return pickup, not delivery', async (t) => {
  const f = await setup(t);
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  const id = await job(f, f.driver, f.driverId);
  await action(f.driver, id, 'pickup');
  await action(f.admin, id, 'return', { reason: 'Return to pickup' });
  await action(f.driver, id, 'arrival');
  const history = JSON.stringify((await shipment(f.admin, id)).history);
  assert.match(history, /Arrival recorded at return pickup/);
  assert.doesNotMatch(history, /Arrival recorded at delivery/);
});

test('an expired quotation and an expired driver offer are both cleared in one sweep', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'yyc-expiry-'));
  const path = join(dir, 'expiry.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = await setup(t, { databasePath: path });
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  const id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  await action(f.admin, id, 'quote', { price: 450, rate: 300 });

  // Simulate the state a quotation and a driver offer can reach together: both timers lapsed.
  const past = Date.now() - 60000;
  const db = new DatabaseSync(path);
  db.prepare(
    "UPDATE shipments SET offered_to=?, data=json_set(data,'$.offeredTo',?,'$.offerExpiresAt',?,'$.quoteExpiresAt',?) WHERE id=?",
  ).run(f.driverId, f.driverId, past, past, id);
  db.close();

  // Any write triggers the expiry sweep before the action runs; this one is rejected on purpose.
  await action(f.admin, id, 'offer', { driverId: f.driverId }, 403);

  const s = await shipment(f.admin, id);
  assert.equal(s.status, 'Awaiting quote');
  assert.equal(s.offeredTo, null);
  assert.equal(s.offerExpiresAt, undefined);
  assert.equal(s.quoteExpiresAt, undefined);
});
