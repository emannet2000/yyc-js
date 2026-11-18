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
  const tracking = `/api/shipments/${first}/tracking`;
  assert.equal(
    (await f.driver(tracking, 'POST', { latitude: 51, longitude: -114, accuracy: 10 }))
      .status,
    200,
  );
  await action(f.admin, first, 'handover', {
    driverId: next.id,
    reason: 'Current load delivered; ready for transfer',
  });
  await action(next.client, first, 'acceptJob');
  for (const client of [f.store, next.client, f.admin]) {
    const response = await client(tracking);
    assert.equal(response.status, 200);
    assert.equal(response.value.latitude, undefined);
    assert.equal(response.value.recordedAt, undefined);
  }
  assert.equal(
    (await next.client(tracking, 'POST', { latitude: 52, longitude: -113, accuracy: 10 }))
      .status,
    200,
  );
  assert.equal((await f.store(tracking)).value.latitude, 52);
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

test('expired pickup dates require rescheduling before dispatch or collection', async (t) => {
  let now = Date.parse('2099-11-06T06:30:00Z');
  const f = await setup(t, { now: () => now });
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  async function quotedJob(window) {
    const { id } = (await f.store('/api/shipments', 'POST', booking(window))).value;
    await action(f.admin, id, 'quote', { price: 450, rate: 300 });
    return id;
  }
  const assigned = await quotedJob('09:00–12:00');
  await action(f.store, assigned, 'acceptQuote');
  await action(f.admin, assigned, 'offer', { driverId: f.driverId });
  await action(f.driver, assigned, 'acceptJob');
  await action(f.driver, assigned, 'pickup', {}, 409);
  await action(f.driver, assigned, 'arrival');

  const offered = await quotedJob('13:00–16:00');
  await action(f.store, offered, 'acceptQuote');
  await action(f.admin, offered, 'offer', { driverId: f.driverId });
  const ready = await quotedJob();
  await action(f.store, ready, 'acceptQuote');
  const awaitingAcceptance = await quotedJob();

  now += 45 * 60000; // Midnight in Edmonton passed, but the quote and offer are still valid.
  for (const [client, id, name, data] of [
    [f.store, awaitingAcceptance, 'acceptQuote', {}],
    [f.admin, ready, 'offer', { driverId: f.driverId }],
    [f.driver, offered, 'acceptJob', {}],
    [f.driver, assigned, 'pickup', {}],
  ]) {
    const result = await action(client, id, name, data, 409);
    assert.match(result.value.error, /pickup date has passed/i);
  }
  await action(f.admin, assigned, 'reschedule', {
    date: '2099-11-06',
    window: '09:00–12:00',
    reason: 'New pickup appointment',
  });
  await action(f.store, assigned, 'acceptQuote');
  await action(f.admin, assigned, 'offer', { driverId: f.driverId });
  await action(f.driver, assigned, 'acceptJob');
  await action(f.driver, assigned, 'pickup');
  const job = (await f.admin('/api/state')).value.shipments.find(
    (s) => s.id === assigned,
  );
  assert.equal(job.status, 'In transit');
  assert.ok(job.pickupArrivedAt);
});

test('pickup milestones saved on the scheduled date replay after midnight', async (t) => {
  let now = Date.parse('2099-11-06T06:30:00Z');
  const f = await setup(t, { now: () => now });
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  const id = await job(f, f.driver, f.driverId);
  const arrivalTime = new Date(now + 60000).toISOString();
  const pickupTime = new Date(now + 120000).toISOString();
  now += 45 * 60000;
  await action(f.driver, id, 'arrival', {
    requestKey: 'offline-arrival-midnight',
    queuedAt: arrivalTime,
  });
  const s = (await f.driver('/api/state')).value.shipments.find((item) => item.id === id);
  const payload = {
    action: 'pickup',
    version: s.version,
    requestKey: 'offline-pickup-midnight',
    queuedAt: pickupTime,
  };
  const path = `/api/shipments/${id}/actions`;
  assert.equal((await f.driver(path, 'POST', payload)).status, 200);
  assert.equal((await f.driver(path, 'POST', payload)).status, 200);
  assert.equal(
    (await f.driver(path, 'POST', { ...payload, queuedAt: arrivalTime })).status,
    409,
  );
  const pickedUp = (await f.admin('/api/state')).value.shipments.find(
    (item) => item.id === id,
  );
  assert.equal(pickedUp.status, 'In transit');
  assert.equal(pickedUp.pickupArrivedAt, arrivalTime);
  assert.equal(pickedUp.pickupAt, pickupTime);
  assert.equal(
    pickedUp.history.filter((event) => event.text === 'Pickup confirmed').length,
    1,
  );
});
