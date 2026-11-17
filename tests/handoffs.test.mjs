import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  start,
  booking,
  action,
  registration,
  secret,
  attachDeliveryEvidence,
} from './helpers/app.mjs';
async function assigned(t) {
  const f = await setup(t);
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  const id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  await action(f.admin, id, 'quote', { price: 450, rate: 300 });
  await action(f.store, id, 'acceptQuote');
  await action(f.admin, id, 'offer', { driverId: f.driverId });
  await action(f.driver, id, 'acceptJob');
  return { ...f, id };
}
const shipment = async (f) =>
  (await f.admin('/api/state')).value.shipments.find((s) => s.id === f.id);

test('removed drivers are notified when customer quotation changes', async (t) => {
  const f = await assigned(t);
  const before = (await f.driver('/api/notifications')).value.length;
  await action(f.admin, f.id, 'requote', {
    price: 500,
    rate: 325,
    reason: 'Customer approved changed service',
  });
  const notices = (await f.driver('/api/notifications')).value;
  assert.equal(notices.length, before + 1);
  assert.match(notices[0].message, /assignment reset/);
  assert.equal((await f.driver('/api/state')).value.shipments.length, 0);
});

test('driver-only rate corrections retain customer approval and assignment until driver accepts or declines', async (t) => {
  const f = await assigned(t),
    before = await shipment(f);
  await action(f.admin, f.id, 'requote', {
    price: 450,
    rate: 325,
    reason: 'Better driver compensation',
  });
  let s = await shipment(f);
  assert.equal(s.status, 'Assigned');
  assert.equal(s.quoteVersion, before.quoteVersion);
  assert.equal(s.driverId, f.driverId);
  assert.equal(s.rate, 300);
  assert.equal(s.rateChange.rate, 325);
  const owner = (await f.store('/api/state')).value.shipments[0];
  assert.equal(owner.rateChange, undefined);
  await action(f.store, f.id, 'acceptRate', {}, 403);
  await action(f.driver, f.id, 'acceptRate');
  s = await shipment(f);
  assert.equal(s.rate, 325);
  assert.equal(s.price, 450);
  assert.equal(s.driverId, f.driverId);
  assert.equal(s.status, 'Assigned');
  await action(f.admin, f.id, 'changeRate', { rate: 350, reason: 'Optional increase' });
  await action(f.driver, f.id, 'declineRate');
  assert.equal((await shipment(f)).rate, 325);
});

test('owner requests are isolated, versioned, actionable and applied only on broker approval', async (t) => {
  const f = await assigned(t);
  assert.equal(
    (
      await f.other(`/api/shipments/${f.id}/actions`, 'POST', {
        action: 'requestChange',
        version: 1,
        kind: 'cancellation',
        details: 'Wrong owner',
      })
    ).status,
    404,
  );
  await action(f.store, f.id, 'requestChange', {
    kind: 'shipment',
    details: 'Receiving location moved',
    destination: 'New receiving address',
    kg: 950,
    pallets: 4,
  });
  let s = await shipment(f);
  const requestId = s.customerRequests[0].id;
  assert.equal(s.destination, 'Store address');
  assert.equal(s.status, 'Assigned');
  await action(
    f.store,
    f.id,
    'requestChange',
    { kind: 'shipment', details: 'Duplicate request' },
    409,
  );
  await action(
    f.store,
    f.id,
    'respondRequest',
    { requestId, decision: 'approve', response: 'Wrong role' },
    403,
  );
  await action(f.admin, f.id, 'respondRequest', {
    requestId,
    decision: 'approve',
    response: 'New location confirmed',
  });
  s = await shipment(f);
  assert.equal(s.status, 'Awaiting quote');
  assert.equal(s.destination, 'New receiving address');
  assert.equal(s.driverId, null);
  assert.equal(s.customerRequests[0].status, 'approved');
  await action(
    f.admin,
    f.id,
    'respondRequest',
    { requestId, decision: 'approve', response: 'Replay' },
    409,
  );
  await action(f.store, f.id, 'requestChange', {
    kind: 'quotation',
    details: 'Please review the price',
  });
  s = await shipment(f);
  await action(f.admin, f.id, 'respondRequest', {
    requestId: s.customerRequests.at(-1).id,
    decision: 'approve',
    response: 'Revised customer quote',
    price: 420,
    rate: 300,
  });
  assert.equal((await shipment(f)).status, 'Quote ready');
});

test('approved cancellation after pickup requires a receipted cargo return', async (t) => {
  const f = await assigned(t);
  await action(f.driver, f.id, 'pickup');
  await action(f.store, f.id, 'requestChange', {
    kind: 'cancellation',
    details: 'Receiving location closed',
  });
  const s = await shipment(f);
  await action(f.admin, f.id, 'respondRequest', {
    requestId: s.customerRequests[0].id,
    decision: 'approve',
    response: 'Return cargo to pickup',
  });
  assert.equal((await shipment(f)).status, 'Returning');
  await action(f.driver, f.id, 'confirmReturn', {
    pod: 'RETURN-1',
    recipient: 'Warehouse staff',
  });
  assert.equal((await shipment(f)).status, 'Returned');
});

test('delivery requires final arrival and post-pickup evidence and persists the proof reference', async (t) => {
  const f = await assigned(t);
  await attachDeliveryEvidence(f.driver, f.id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await action(f.driver, f.id, 'pickup');
  await action(f.driver, f.id, 'deliver', { pod: 'POD', recipient: 'Staff' }, 409);
  await action(f.driver, f.id, 'arrival');
  await action(f.driver, f.id, 'deliver', { pod: 'POD', recipient: 'Staff' }, 409);
  await attachDeliveryEvidence(f.driver, f.id);
  let s = await shipment(f);
  assert.equal(
    (
      await f.driver(`/api/shipments/${f.id}/actions`, 'POST', {
        action: 'deliver',
        version: s.version,
        pod: 'POD',
        recipient: 'Staff',
      })
    ).status,
    200,
  );
  s = await shipment(f);
  assert.equal(s.status, 'Delivered');
  assert.equal(s.deliveryEvidence.policy, 'arrival-and-file');
  assert.match(s.deliveryEvidence.sha256, /^[a-f0-9]{64}$/);
  assert.ok(s.deliveryEvidence.arrivedAt && s.deliveryEvidence.confirmedAt);
});

test('first broker setup requires a valid expiring token and closes atomically after one account', async (t) => {
  let clock = Date.now();
  const f = await start(t, { now: () => clock });
  const guest = f.client();
  assert.equal((await guest('/api/setup')).value.required, true);
  const token = f.app.createSetupToken();
  const body = { ...registration('admin', 'first@example.com'), token };
  assert.equal(
    (await guest('/api/setup', 'POST', { ...body, token: '0'.repeat(64) })).status,
    403,
  );
  clock += 31 * 60000;
  assert.equal((await guest('/api/setup', 'POST', body)).status, 403);
  body.token = f.app.createSetupToken();
  const results = await Promise.all([
    guest('/api/setup', 'POST', body),
    guest('/api/setup', 'POST', { ...body, email: 'second@example.com' }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await guest('/api/setup')).value.required, false);
  assert.throws(() => f.app.createSetupToken());
  const email = results[0].status === 201 ? body.email : 'second@example.com';
  assert.equal(
    (await guest('/api/login', 'POST', { email, password: secret })).status,
    200,
  );
});

test('expired offers notify the former proposed driver after releasing the reservation', async (t) => {
  let clock = Date.now();
  const f = await setup(t, { now: () => clock });
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  const id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  await action(f.admin, id, 'quote', { price: 450, rate: 300 });
  await action(f.store, id, 'acceptQuote');
  await action(f.admin, id, 'offer', { driverId: f.driverId });
  const before = (await f.driver('/api/notifications')).value.length;
  clock += 61 * 60000;
  f.app.expire();
  const notices = (await f.driver('/api/notifications')).value;
  assert.equal(notices.length, before + 1);
  assert.match(notices[0].message, /offer expired/);
  assert.equal((await f.driver('/api/state')).value.shipments.length, 0);
});

test('declining owner cancellation preserves assignment and records a clear response', async (t) => {
  const f = await assigned(t);
  await action(f.store, f.id, 'requestChange', {
    kind: 'cancellation',
    details: 'Please cancel after acceptance',
  });
  const s = await shipment(f);
  await action(f.admin, f.id, 'respondRequest', {
    requestId: s.customerRequests[0].id,
    decision: 'decline',
    response: 'Delivery still required; continue to the confirmed destination.',
  });
  const after = await shipment(f);
  assert.equal(after.status, 'Assigned');
  assert.equal(after.driverId, f.driverId);
  assert.equal(after.customerRequests[0].status, 'declined');
  const notice = (await f.store('/api/notifications')).value;
  assert.ok(
    notice.some((n) => n.message.includes('continue to the confirmed destination')),
  );
});
