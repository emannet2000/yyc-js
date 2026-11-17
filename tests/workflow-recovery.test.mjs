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
  proofFile,
  registration,
  login,
} from './helpers/app.mjs';

async function offered(t, options) {
  const f = await setup(t, options);
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  const id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  await action(f.admin, id, 'quote', { price: 450, rate: 300 });
  await action(f.store, id, 'acceptQuote');
  await action(f.admin, id, 'offer', { driverId: f.driverId });
  return {
    ...f,
    id,
    state: async () =>
      (await f.admin('/api/state')).value.shipments.find((s) => s.id === id),
  };
}

test('lost decline responses replay after access removal and restart, without duplicate audit events', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'yyc-decline-replay-'));
  const databasePath = join(directory, 'app.sqlite');
  const f = await offered(t, { databasePath });
  const s = await f.state(),
    body = { action: 'decline', version: s.version, requestKey: randomUUID() };
  const send = (client, data = body) =>
    client(`/api/shipments/${f.id}/actions`, 'POST', data);
  const first = await send(f.driver);
  assert.equal(first.status, 200);
  const after = await f.state();
  assert.deepEqual((await send(f.driver)).value, first.value);
  assert.equal((await send(f.driver, { ...body, action: 'acceptJob' })).status, 409);
  assert.equal((await send(f.other)).status, 404);
  assert.deepEqual(await f.state(), after);
  await f.stop();
  const reopened = await start(t, { databasePath });
  const driver = reopened.client();
  await login(driver, 'driver@example.com');
  assert.deepEqual((await send(driver)).value, first.value);
  await reopened.stop();
  rmSync(directory, { recursive: true, force: true });
});

test('proof from before pickup is rejected even with identical timestamps; post-pickup proof qualifies', async (t) => {
  const fixed = Date.now(),
    f = await offered(t, { now: () => fixed });
  await action(f.driver, f.id, 'acceptJob');
  await attachDeliveryEvidence(f.driver, f.id);
  await action(f.driver, f.id, 'pickup');
  await action(f.driver, f.id, 'arrival');
  let s = await f.state();
  assert.equal(s.evidenceCount, 0);
  const submit = (version) =>
    f.driver(`/api/shipments/${f.id}/actions`, 'POST', {
      action: 'deliver',
      version,
      pod: 'PROOF',
      recipient: 'Staff',
    });
  assert.equal((await submit(s.version)).status, 409);
  assert.deepEqual(await f.state(), s);
  await attachDeliveryEvidence(f.driver, f.id);
  s = await f.state();
  assert.equal(s.evidenceCount, 1);
  assert.equal((await submit(s.version)).status, 200);
});

test('a reserved post-pickup proof slot permits completion after ten earlier uploads', async (t) => {
  const f = await offered(t);
  await action(f.driver, f.id, 'acceptJob');
  for (let n = 0; n < 10; n++) await attachDeliveryEvidence(f.driver, f.id);
  let s = await f.state();
  assert.equal(
    (
      await f.driver(`/api/shipments/${f.id}/evidence`, 'POST', {
        ...proofFile,
        version: s.version,
      })
    ).status,
    409,
  );
  await action(f.driver, f.id, 'pickup');
  await action(f.driver, f.id, 'arrival');
  await attachDeliveryEvidence(f.driver, f.id);
  s = await f.state();
  assert.equal(
    (
      await f.driver(`/api/shipments/${f.id}/evidence`, 'POST', {
        ...proofFile,
        version: s.version,
      })
    ).status,
    409,
  );
  await action(f.driver, f.id, 'deliver', { pod: 'RESERVED', recipient: 'Staff' });
  assert.equal((await f.state()).status, 'Delivered');
});

test('expired and withdrawn offers clear orphaned rate proposals so brokers can change rates again', async (t) => {
  let clock = Date.now();
  const f = await offered(t, { now: () => clock });
  await action(f.admin, f.id, 'changeRate', {
    rate: 325,
    reason: 'Initial proposed rate',
  });
  clock += 61 * 60000;
  f.app.expire();
  assert.equal((await f.state()).rateChange, undefined);
  await action(f.admin, f.id, 'changeRate', {
    rate: 350,
    reason: 'Revised rate for next offer',
  });
  assert.equal((await f.state()).rate, 350);
  await action(f.admin, f.id, 'offer', { driverId: f.driverId });
  await action(f.admin, f.id, 'changeRate', { rate: 375, reason: 'Another proposal' });
  const driver = (await f.admin('/api/state')).value.drivers.find(
    (d) => d.id === f.driverId,
  );
  await f.admin(`/api/drivers/${f.driverId}/review`, 'POST', {
    version: driver.version,
    decision: 'revoke',
    reason: 'Approval withdrawn',
  });
  assert.equal((await f.state()).rateChange, undefined);
  await action(f.admin, f.id, 'changeRate', {
    rate: 380,
    reason: 'New proposed service',
  });
});

test('urgent cancellation supersedes old requests; owners can withdraw pending requests', async (t) => {
  const f = await offered(t);
  await action(f.driver, f.id, 'acceptJob');
  await action(f.store, f.id, 'requestChange', {
    kind: 'quotation',
    details: 'Review price',
  });
  const original = (await f.state()).customerRequests[0].id;
  await action(f.driver, f.id, 'pickup');
  await action(f.store, f.id, 'requestChange', {
    kind: 'cancellation',
    details: 'Receiving dock closed; return cargo',
  });
  let s = await f.state();
  assert.equal(s.customerRequests[0].status, 'superseded');
  assert.equal(s.customerRequests[1].status, 'pending');
  await action(
    f.admin,
    f.id,
    'respondRequest',
    { requestId: original, decision: 'decline', response: 'Stale review' },
    409,
  );
  await action(f.store, f.id, 'withdrawRequest', {
    requestId: s.customerRequests[1].id,
    reason: 'Dock reopened; continue delivery',
  });
  s = await f.state();
  assert.equal(s.customerRequests[1].status, 'withdrawn');
  assert.equal(s.status, 'In transit');
  await action(
    f.store,
    f.id,
    'withdrawRequest',
    { requestId: s.customerRequests[1].id, reason: 'Already withdrawn' },
    409,
  );
});

async function handover(t, options) {
  const f = await offered(t, options);
  await action(f.driver, f.id, 'acceptJob');
  await action(f.driver, f.id, 'pickup');
  const next = f.client();
  const email = 'replacement-settlement@example.com';
  const nextId = (await next('/api/register', 'POST', registration('driver', email)))
    .value.id;
  await login(next, email);
  await f.admin(`/api/drivers/${nextId}/approve`, 'POST', {});
  await action(f.admin, f.id, 'handover', {
    driverId: nextId,
    reason: 'Transfer remaining delivery leg',
  });
  await action(next, f.id, 'acceptJob');
  await action(next, f.id, 'deliver', { pod: 'HANDOVER', recipient: 'Staff' });
  return { ...f, next, nextId };
}
const shares = (f) => [
  { driverId: f.driverId, amount: 100, reason: 'Pickup and first leg' },
  { driverId: f.nextId, amount: 200, reason: 'Final delivery leg' },
];

test('handover allocations total the agreed rate, expose separate private balances, and constrain payouts and revisions', async (t) => {
  const f = await handover(t);
  const s = await f.state();
  const create = (allocations) =>
    f.admin('/api/invoices', 'POST', {
      shipmentId: f.id,
      version: s.version,
      taxCents: 0,
      ...(allocations ? { allocations } : {}),
    });
  assert.equal((await create()).status, 400);
  assert.equal(
    (await create([{ ...shares(f)[0], amount: 101 }, shares(f)[1]])).status,
    400,
  );
  assert.equal((await create([shares(f)[0], shares(f)[0]])).status, 400);
  let reply = await create(shares(f));
  assert.equal(reply.status, 201);
  let invoice = reply.value;
  assert.equal((await create(shares(f))).status, 201);
  assert.equal(
    (
      await create([
        { ...shares(f)[0], amount: 110 },
        { ...shares(f)[1], amount: 190 },
      ])
    ).status,
    409,
  );
  assert.equal((await f.driver('/api/settlements')).value[0].rateCents, 10000);
  assert.equal((await f.next('/api/settlements')).value[0].rateCents, 20000);
  const owner = (await f.store('/api/invoices')).value[0];
  assert.equal(owner.allocations, undefined);
  assert.equal(owner.rateCents, undefined);
  const body = {
    version: invoice.version,
    kind: 'payout',
    amount: 100,
    driverId: f.driverId,
    requestKey: randomUUID(),
    reference: 'BANK-1',
    reason: 'Verified first driver transfer',
  };
  reply = await f.admin(`/api/invoices/${invoice.id}/entries`, 'POST', body);
  assert.equal(reply.status, 200);
  invoice = reply.value;
  assert.equal(
    (await f.admin(`/api/invoices/${invoice.id}/entries`, 'POST', body)).status,
    200,
  );
  assert.equal(
    (
      await f.admin(`/api/invoices/${invoice.id}/entries`, 'POST', {
        ...body,
        driverId: f.nextId,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.admin(`/api/invoices/${invoice.id}/entries`, 'POST', {
        ...body,
        version: invoice.version,
        amount: 1,
        requestKey: randomUUID(),
      })
    ).status,
    409,
  );
  const first = (await f.driver('/api/settlements')).value[0],
    second = (await f.next('/api/settlements')).value[0];
  assert.equal(first.paidCents, 10000);
  assert.equal(first.dueCents, 0);
  assert.equal(second.paidCents, 0);
  assert.equal(second.entries.length, 0);
  assert.equal(first.totalCents, undefined);
  const reduce = [
    { ...shares(f)[0], amount: 50 },
    { ...shares(f)[1], amount: 250 },
  ];
  assert.equal(
    (
      await f.admin(`/api/invoices/${invoice.id}/allocations`, 'POST', {
        version: invoice.version,
        allocations: reduce,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.store(`/api/invoices/${invoice.id}/allocations`, 'POST', {
        version: invoice.version,
        allocations: shares(f),
      })
    ).status,
    403,
  );
  reply = await f.admin(`/api/invoices/${invoice.id}/entries`, 'POST', {
    ...body,
    kind: 'payoutRefund',
    version: invoice.version,
    requestKey: randomUUID(),
    reference: 'BANK-REVERSAL',
  });
  assert.equal(reply.status, 200);
  invoice = reply.value;
  reply = await f.admin(`/api/invoices/${invoice.id}/allocations`, 'POST', {
    version: invoice.version,
    allocations: reduce,
  });
  assert.equal(reply.status, 200);
  assert.equal((await f.driver('/api/settlements')).value[0].rateCents, 5000);
  assert.equal((await f.next('/api/settlements')).value[0].rateCents, 25000);
});

test('legacy evidence cannot masquerade as current proof and legacy handover invoices require allocation review', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'yyc-ledger-migration-'));
  const path = join(directory, 'app.sqlite');
  const f = await handover(t, { databasePath: path });
  const s = await f.state();
  let invoice = (
    await f.admin('/api/invoices', 'POST', {
      shipmentId: f.id,
      version: s.version,
      allocations: shares(f),
    })
  ).value;
  await f.stop();
  const db = new DatabaseSync(path);
  db.prepare(
    "INSERT INTO invoice_entries(id,invoice_id,request_key,kind,amount_cents,reference,reason,actor_id,created_at,driver_id) VALUES (?,?,?,'payout',20000,'LEGACY-BANK','Previously paid',?,?,?)",
  ).run(
    randomUUID(),
    invoice.id,
    randomUUID(),
    f.nextId,
    new Date().toISOString(),
    f.nextId,
  );
  db.exec(
    'DELETE FROM invoice_allocation_revisions; DELETE FROM invoice_allocations; ALTER TABLE invoice_entries DROP COLUMN driver_id; ALTER TABLE evidence DROP COLUMN pickup_version;',
  );
  db.close();
  const reopened = await start(t, { databasePath: path });
  const broker = reopened.client();
  await login(broker, 'admin@example.com');
  invoice = (await broker('/api/invoices')).value[0];
  assert.equal(invoice.allocationRequired, true);
  assert.equal(invoice.allocations[0].paidCents, 20000);
  assert.equal(
    (
      await broker(`/api/invoices/${invoice.id}/entries`, 'POST', {
        version: invoice.version,
        kind: 'payout',
        amount: 1,
        driverId: f.nextId,
        requestKey: randomUUID(),
        reference: 'BANK',
        reason: 'Needs review',
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await broker(`/api/invoices/${invoice.id}/allocations`, 'POST', {
        version: invoice.version,
        allocations: shares(f),
      })
    ).status,
    200,
  );
  const previous = reopened.client();
  await login(previous, 'driver@example.com');
  assert.equal((await previous('/api/settlements')).value[0].rateCents, 10000);
  await reopened.stop();
  rmSync(directory, { recursive: true, force: true });
});

test('lost evidence responses replay after handover without restoring access to shipment files', async (t) => {
  const f = await offered(t);
  await action(f.driver, f.id, 'acceptJob');
  await action(f.driver, f.id, 'pickup');
  const s = await f.state(),
    body = { ...proofFile, version: s.version, requestKey: randomUUID() };
  const first = await f.driver(`/api/shipments/${f.id}/evidence`, 'POST', body);
  assert.equal(first.status, 201);
  const next = f.client(),
    email = 'evidence-replay-replacement@example.com';
  const nextId = (await next('/api/register', 'POST', registration('driver', email)))
    .value.id;
  await login(next, email);
  await f.admin(`/api/drivers/${nextId}/approve`, 'POST', {});
  await action(f.admin, f.id, 'handover', {
    driverId: nextId,
    reason: 'New driver takes custody',
  });
  await action(next, f.id, 'acceptJob');
  assert.equal((await f.driver(`/api/shipments/${f.id}/evidence`)).status, 404);
  assert.deepEqual(
    (await f.driver(`/api/shipments/${f.id}/evidence`, 'POST', body)).value,
    first.value,
  );
  assert.equal(
    (
      await f.driver(`/api/shipments/${f.id}/evidence`, 'POST', {
        ...body,
        name: 'different.pdf',
      })
    ).status,
    409,
  );
});

test('legacy orphan rate proposals are repaired on refresh without requiring a hidden API action', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'yyc-orphan-rate-'));
  const path = join(directory, 'app.sqlite');
  const f = await offered(t, { databasePath: path });
  await action(f.admin, f.id, 'changeRate', {
    rate: 325,
    reason: 'Proposal predating upgrade',
  });
  const db = new DatabaseSync(path);
  db.prepare(
    "UPDATE shipments SET offered_to=NULL,status='Ready to assign',data=json_remove(data,'$.offerExpiresAt') WHERE id=?",
  ).run(f.id);
  db.close();
  const state = await f.state();
  assert.equal(state.rateChange, undefined);
  assert.equal(state.rate, 300);
  await action(f.admin, f.id, 'changeRate', {
    rate: 350,
    reason: 'New rate after automatic cleanup',
  });
  assert.equal((await f.state()).rate, 350);
  await f.stop();
  rmSync(directory, { recursive: true, force: true });
});
