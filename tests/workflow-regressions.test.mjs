import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, booking, action, registration, login } from './helpers/app.mjs';
async function replacement(f) {
  const client = f.client();
  await client('/api/register', 'POST', registration('driver', 'live-cargo@example.com'));
  await login(client, 'live-cargo@example.com');
  const id = (await client('/api/state')).value.user.id;
  await f.admin(`/api/drivers/${id}/approve`, 'POST', {});
  return { client, id };
}
async function job(f, driver, driverId, input) {
  const id = (
    await f.store('/api/shipments', 'POST', { ...booking(), kg: 3000, ...input })
  ).value.id;
  await action(f.admin, id, 'quote', { price: 450, rate: 300 });
  await action(f.store, id, 'acceptQuote');
  await action(f.admin, id, 'offer', { driverId });
  await action(driver, id, 'acceptJob');
  return id;
}

test('a handover cannot put two live loads on a replacement truck just because pickup windows differ', async (t) => {
  const f = await setup(t),
    next = await replacement(f);
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  const first = await job(f, f.driver, f.driverId, { window: '09:00–12:00' });
  await action(f.driver, first, 'pickup');
  const second = await job(f, next.client, next.id, { window: '13:00–16:00' });
  await action(next.client, second, 'pickup');
  const before = (await f.admin('/api/state')).value.shipments;
  await action(
    f.admin,
    first,
    'handover',
    { driverId: next.id, reason: 'Replace the original driver' },
    409,
  );
  assert.deepEqual((await f.admin('/api/state')).value.shipments, before);
  await action(next.client, second, 'deliver', {
    pod: 'OWN-LOAD',
    recipient: 'Receiving team',
  });
  await action(f.admin, first, 'handover', {
    driverId: next.id,
    reason: 'Current load delivered; ready for transfer',
  });
  await action(next.client, first, 'acceptJob');
  assert.equal(
    (await next.client('/api/state')).value.shipments.filter(
      (s) => s.status === 'In transit' && s.driverId === next.id,
    ).length,
    1,
  );
});

test('future reservations remain allowed, but pickup cannot start another load while one is in transit', async (t) => {
  const f = await setup(t);
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  const first = await job(f, f.driver, f.driverId, { date: '2099-11-05' });
  await action(f.driver, first, 'pickup');
  const second = await job(f, f.driver, f.driverId, { date: '2099-11-06' });
  await action(f.driver, second, 'pickup', {}, 409);
  assert.equal(
    (await f.admin('/api/state')).value.shipments.find((s) => s.id === second).status,
    'Assigned',
  );
  await action(f.driver, first, 'deliver', { pod: 'FIRST', recipient: 'Staff' });
  await action(f.driver, second, 'pickup');
});

test('a pending live handover reserves the replacement cargo slot until withdrawn', async (t) => {
  const f = await setup(t),
    next = await replacement(f);
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  const first = await job(f, f.driver, f.driverId, { window: '09:00–12:00' });
  await action(f.driver, first, 'pickup');
  const second = await job(f, next.client, next.id, { window: '13:00–16:00' });
  await action(f.admin, first, 'handover', {
    driverId: next.id,
    reason: 'Transfer the cargo',
  });
  await action(next.client, second, 'pickup', {}, 409);
  await action(f.admin, first, 'withdrawHandover', {
    reason: 'Original driver will finish',
  });
  await action(next.client, second, 'pickup');
});

test('handover acceptance rechecks cargo committed after a pre-pickup offer', async (t) => {
  const f = await setup(t),
    next = await replacement(f);
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  const first = await job(f, f.driver, f.driverId, { window: '09:00–12:00' });
  const second = await job(f, next.client, next.id, { window: '13:00–16:00' });
  await action(f.admin, first, 'handover', {
    driverId: next.id,
    reason: 'Replace before pickup',
  });
  await action(next.client, second, 'pickup');
  await action(f.driver, first, 'pickup');
  const before = (await f.admin('/api/state')).value.shipments;
  await action(next.client, first, 'acceptJob', {}, 409);
  assert.deepEqual((await f.admin('/api/state')).value.shipments, before);
  await action(next.client, second, 'deliver', { pod: 'SECOND', recipient: 'Staff' });
  await action(next.client, first, 'acceptJob');
});

test('an unresolved pickup exception blocks loading until the broker resolves it', async (t) => {
  const f = await setup(t);
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  const id = await job(f, f.driver, f.driverId, {});
  await action(f.driver, id, 'issue', {
    reason: 'Unsafe cargo',
    note: 'Pallet wrap has failed; do not load',
  });
  const before = (await f.admin('/api/state')).value.shipments;
  await action(f.driver, id, 'pickup', {}, 409);
  assert.deepEqual((await f.admin('/api/state')).value.shipments, before);
  await action(f.admin, id, 'resolve', {
    resolution: 'Warehouse rewrapped and inspected cargo',
  });
  await action(f.driver, id, 'pickup');
  assert.equal(
    (await f.admin('/api/state')).value.shipments.find((s) => s.id === id).status,
    'In transit',
  );
});

test('repeated arrival cannot overwrite the first milestone or add duplicate history', async (t) => {
  const f = await setup(t);
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  const id = await job(f, f.driver, f.driverId, {});
  for (const phase of ['Assigned', 'In transit']) {
    await action(f.driver, id, 'arrival');
    const before = (await f.admin('/api/state')).value.shipments;
    await action(f.driver, id, 'arrival', {}, 409);
    assert.deepEqual((await f.admin('/api/state')).value.shipments, before);
    if (phase === 'Assigned') {
      const arrivedAt = before.find((s) => s.id === id).arrivedAt;
      await action(f.driver, id, 'pickup');
      const pickedUp = (await f.admin('/api/state')).value.shipments.find(
        (s) => s.id === id,
      );
      assert.equal(pickedUp.pickupArrivedAt, arrivedAt);
      assert.equal(pickedUp.arrivedAt, undefined);
    }
  }
});
