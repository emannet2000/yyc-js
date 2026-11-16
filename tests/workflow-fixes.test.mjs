import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, booking, action, registration, login } from './helpers/app.mjs';

async function replacement(fixture, email = 'replacement@example.com') {
  const client = fixture.client();
  assert.equal(
    (await client('/api/register', 'POST', registration('driver', email))).status,
    201,
  );
  await login(client, email);
  const id = (await client('/api/state')).value.user.id;
  await fixture.admin(`/api/drivers/${id}/approve`, 'POST', {});
  return { client, id };
}
async function prepare(fixture, status = 'In transit') {
  const { admin, store, driver, driverId } = fixture;
  await admin(`/api/drivers/${driverId}/approve`, 'POST', {});
  const id = (await store('/api/shipments', 'POST', booking())).value.id;
  await action(admin, id, 'quote', { price: 450, rate: 300 });
  if (status === 'Quote ready') return id;
  await action(store, id, 'acceptQuote');
  if (status === 'Ready to assign') return id;
  await action(admin, id, 'offer', { driverId });
  if (status === 'Offered') return id;
  await action(driver, id, 'acceptJob');
  if (status === 'Assigned') return id;
  await action(driver, id, 'arrival');
  await action(driver, id, 'pickup');
  return id;
}
async function current(admin, id) {
  return (await admin('/api/state')).value.shipments.find((s) => s.id === id);
}

test('disabled driver handover preserves the trip and quote, requires consent, and permits completion', async (t) => {
  const f = await setup(t),
    next = await replacement(f),
    id = await prepare(f);
  const before = await current(f.admin, id);
  await f.admin(`/api/accounts/${f.driverId}/status`, 'POST', {
    disabled: true,
    reason: 'Driver cannot continue',
  });
  await action(f.admin, id, 'handover', {
    driverId: next.id,
    reason: 'Physical cargo handover arranged',
  });
  const offered = await current(f.admin, id);
  assert.equal(offered.status, 'In transit');
  assert.equal(offered.driverId, f.driverId);
  assert.equal(offered.offeredTo, next.id);
  assert.equal((await f.driver('/api/state')).status, 401);
  await action(next.client, id, 'deliver', { pod: 'Too early', recipient: 'Staff' }, 403);
  assert.equal(
    (
      await next.client(`/api/shipments/${id}/actions`, 'POST', {
        action: 'acceptJob',
        version: offered.version - 1,
      })
    ).status,
    409,
  );
  await action(next.client, id, 'acceptJob');
  const accepted = await current(f.admin, id);
  assert.equal(accepted.driverId, next.id);
  assert.equal(accepted.status, 'In transit');
  assert.equal(accepted.offeredTo, null);
  assert.equal(accepted.handover, undefined);
  for (const key of [
    'price',
    'rate',
    'quoteVersion',
    'pickup',
    'destination',
    'kg',
    'pallets',
    'pickupArrivedAt',
  ])
    assert.equal(accepted[key], before[key], key);
  assert.equal(accepted.handoverHistory[0].fromDriverId, f.driverId);
  assert.equal(accepted.handoverHistory[0].toDriverId, next.id);
  assert.ok(
    accepted.history.some((h) => h.text.includes('Physical cargo handover arranged')),
  );
  await action(next.client, id, 'deliver', {
    pod: 'HANDOVER-POD',
    recipient: 'Receiving team',
  });
  assert.equal((await current(f.admin, id)).status, 'Delivered');
  await action(
    f.admin,
    id,
    'handover',
    { driverId: next.id, reason: 'Cannot reopen a delivered trip' },
    403,
  );
  assert.ok(
    (await f.admin('/api/state')).value.accounts.find((a) => a.id === f.driverId)
      .disabled,
  );
});

test('handover offers reserve availability, can be declined or withdrawn, and preserve the original assignment', async (t) => {
  const f = await setup(t),
    next = await replacement(f),
    id = await prepare(f, 'Assigned');
  await action(
    f.store,
    id,
    'handover',
    { driverId: next.id, reason: 'Not authorized' },
    403,
  );
  await action(
    f.admin,
    id,
    'handover',
    { driverId: f.driverId, reason: 'Same driver' },
    400,
  );
  await action(f.admin, id, 'handover', { driverId: next.id }, 400);
  await action(f.admin, id, 'handover', { driverId: next.id, reason: 'Driver change' });
  await action(
    f.admin,
    id,
    'handover',
    { driverId: next.id, reason: 'Duplicate pending offer' },
    409,
  );
  const other = (await f.store('/api/shipments', 'POST', booking())).value.id;
  await action(f.admin, other, 'quote', { price: 450, rate: 300 });
  await action(f.store, other, 'acceptQuote');
  await action(f.admin, other, 'offer', { driverId: next.id }, 409);
  await action(next.client, id, 'decline');
  let state = await current(f.admin, id);
  assert.equal(state.driverId, f.driverId);
  assert.equal(state.status, 'Assigned');
  assert.equal(state.offeredTo, null);
  await action(f.admin, id, 'handover', { driverId: next.id, reason: 'Try again' });
  await action(f.admin, id, 'withdrawHandover', {}, 400);
  await action(f.admin, id, 'withdrawHandover', {
    reason: 'Original driver can continue',
  });
  state = await current(f.admin, id);
  assert.equal(state.driverId, f.driverId);
  assert.equal(state.handover, undefined);
  assert.equal((await next.client('/api/state')).value.shipments.length, 0);
  await action(f.admin, other, 'offer', { driverId: next.id });
});

test('replacement disabling and original-driver completion clear pending handovers safely', async (t) => {
  const f = await setup(t),
    next = await replacement(f),
    id = await prepare(f);
  await action(f.admin, id, 'handover', {
    driverId: next.id,
    reason: 'Pending replacement',
  });
  await f.admin(`/api/accounts/${next.id}/status`, 'POST', {
    disabled: true,
    reason: 'Replacement unavailable',
  });
  let state = await current(f.admin, id);
  assert.equal(state.status, 'In transit');
  assert.equal(state.driverId, f.driverId);
  assert.equal(state.offeredTo, null);
  assert.equal(state.handover, undefined);
  await f.admin(`/api/accounts/${next.id}/status`, 'POST', {
    disabled: false,
    reason: 'Available again',
  });
  await login(next.client, 'replacement@example.com');
  await action(f.admin, id, 'handover', {
    driverId: next.id,
    reason: 'Replacement offered again',
  });
  await action(f.driver, id, 'deliver', { pod: 'ORIGINAL-POD', recipient: 'Staff' });
  state = await current(f.admin, id);
  assert.equal(state.status, 'Delivered');
  assert.equal(state.offeredTo, null);
  assert.equal(state.handover, undefined);
  assert.equal((await next.client('/api/state')).value.shipments.length, 0);
});

test('quote-only corrections preserve cargo, archive prices, and require fresh acceptance in every pre-pickup state', async (t) => {
  const f = await setup(t);
  for (const status of ['Quote ready', 'Ready to assign', 'Offered', 'Assigned']) {
    const id = await prepare(f, status),
      before = await current(f.admin, id);
    await action(
      f.store,
      id,
      'requote',
      { price: 500, rate: 350, reason: 'Not authorized' },
      403,
    );
    await action(f.admin, id, 'requote', { price: 500, rate: 350 }, 400);
    await action(
      f.admin,
      id,
      'requote',
      { price: 450, rate: 300, reason: 'No change' },
      400,
    );
    await action(f.admin, id, 'requote', {
      price: 500,
      rate: 350,
      reason: 'Correct a pricing mistake',
    });
    const corrected = await current(f.admin, id);
    assert.equal(corrected.status, 'Quote ready');
    assert.equal(corrected.quoteVersion, 2);
    assert.equal(corrected.price, 500);
    assert.equal(corrected.rate, 350);
    assert.equal(corrected.driverId, null);
    assert.equal(corrected.offeredTo, null);
    for (const key of [
      'pickup',
      'destination',
      'date',
      'window',
      'kg',
      'pallets',
      'type',
      'goods',
    ])
      assert.equal(corrected[key], before[key]);
    assert.equal(corrected.quoteArchive[0].price, 450);
    assert.equal(corrected.quoteArchive[0].rate, 300);
    assert.equal(corrected.quoteArchive[0].reason, 'Correct a pricing mistake');
    await action(f.admin, id, 'offer', { driverId: f.driverId }, 403);
    assert.equal(
      (await f.driver('/api/state')).value.shipments.some((s) => s.id === id),
      false,
    );
    await action(f.store, id, 'acceptQuote');
    assert.equal((await current(f.admin, id)).status, 'Ready to assign');
  }
});

test('invalid corrections are atomic and prices cannot be changed after pickup or completion', async (t) => {
  const f = await setup(t),
    id = await prepare(f, 'Assigned');
  const before = await current(f.admin, id);
  for (const data of [
    { price: 0.001, rate: 0.01 },
    { price: 500, rate: 501 },
  ]) {
    await action(f.admin, id, 'requote', { ...data, reason: 'Invalid price' }, 400);
    assert.deepEqual(await current(f.admin, id), before);
  }
  await action(f.driver, id, 'pickup');
  await action(
    f.admin,
    id,
    'requote',
    { price: 500, rate: 350, reason: 'Too late' },
    403,
  );
  await action(f.driver, id, 'deliver', { pod: 'DONE', recipient: 'Staff' });
  await action(
    f.admin,
    id,
    'requote',
    { price: 500, rate: 350, reason: 'Too late' },
    403,
  );
});
