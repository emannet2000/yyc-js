import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, booking, action, registration, login } from './helpers/app.mjs';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=',
  'base64',
);
const find = async (f, id) =>
  (await f.admin('/api/state')).value.shipments.find((s) => s.id === id);
async function job(
  f,
  { date = '2099-11-05', window = '09:00–12:00', stage = 'Assigned' } = {},
) {
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  const id = (await f.store('/api/shipments', 'POST', { ...booking(window), date })).value
    .id;
  await action(f.admin, id, 'quote', { price: 450, rate: 300 });
  if (stage === 'Quote ready') return id;
  await action(f.store, id, 'acceptQuote');
  if (stage === 'Ready to assign') return id;
  await action(f.admin, id, 'offer', { driverId: f.driverId });
  if (stage === 'Offered') return id;
  await action(f.driver, id, 'acceptJob');
  if (stage === 'Assigned') return id;
  await action(f.driver, id, 'pickup');
  if (stage === 'In transit') return id;
  await action(f.driver, id, 'deliver', { pod: 'POD', recipient: 'Staff' });
  return id;
}
const plan = {
  date: '2099-11-07',
  window: '13:00–16:00',
  estimatedMinutes: 240,
  travelBufferMinutes: 30,
  deliveryDeadline: '2099-11-07T18:00',
  reason: 'Customer requested a later appointment',
};

test('rescheduling validates the complete plan atomically and requires fresh consent', async (t) => {
  const f = await setup(t),
    id = await job(f),
    before = await find(f, id);
  await action(f.store, id, 'reschedule', plan, 403);
  await action(
    f.admin,
    id,
    'reschedule',
    { ...plan, deliveryDeadline: '2099-11-07T14:00' },
    400,
  );
  assert.deepEqual(await find(f, id), before);
  await action(f.admin, id, 'reschedule', plan);
  const next = await find(f, id);
  assert.equal(next.version, before.version + 1);
  assert.equal(next.quoteVersion, 2);
  assert.equal(next.status, 'Quote ready');
  assert.equal(next.driverId, null);
  assert.equal(next.price, 450);
  assert.equal(next.estimatedMinutes, 240);
  await action(f.admin, id, 'offer', { driverId: f.driverId }, 403);
  await action(f.store, id, 'acceptQuote');
  await action(f.admin, id, 'offer', { driverId: f.driverId });
  await action(f.driver, id, 'acceptJob');
  await action(f.driver, id, 'pickup');
  await action(f.admin, id, 'reschedule', plan, 403);
});

test('expired quotations reject acceptance and expired offers release their reservations', async (t) => {
  let time = Date.now();
  const f = await setup(t, { now: () => time });
  const quoted = await job(f, { stage: 'Quote ready' }),
    version = (await find(f, quoted)).version;
  time += 48 * 3600000 + 1;
  const expired = await find(f, quoted);
  assert.equal(expired.status, 'Awaiting quote');
  assert.equal(expired.price, null);
  assert.equal(expired.version, version + 1);
  assert.equal(
    (
      await f.store(`/api/shipments/${quoted}/actions`, 'POST', {
        action: 'acceptQuote',
        version,
      })
    ).status,
    409,
  );
  await action(f.admin, quoted, 'quote', { price: 500, rate: 300 });
  await action(f.store, quoted, 'acceptQuote');
  await action(f.admin, quoted, 'offer', { driverId: f.driverId });
  const other = await job(f, { stage: 'Ready to assign' });
  await action(f.admin, other, 'offer', { driverId: f.driverId }, 409);
  time += 3600001;
  assert.equal((await find(f, quoted)).status, 'Ready to assign');
  await action(f.admin, other, 'offer', { driverId: f.driverId });
});

test('failed attempts retain cargo through redelivery and return, and only return receipt releases it', async (t) => {
  const f = await setup(t),
    id = await job(f, { stage: 'In transit' }),
    other = await job(f, { date: '2099-11-06' });
  await action(f.driver, id, 'failDelivery', {
    reason: 'Receiving closed',
    note: 'No authorized recipient',
  });
  assert.equal((await find(f, id)).status, 'Delivery failed');
  await action(f.driver, other, 'pickup', {}, 409);
  await action(f.admin, id, 'cancel', {}, 403);
  await action(
    f.admin,
    id,
    'change',
    { destination: 'Elsewhere', kg: 900, pallets: 4, reason: 'Cannot erase custody' },
    403,
  );
  await action(f.admin, id, 'redeliver', plan);
  await action(f.driver, id, 'failDelivery', {
    reason: 'Recipient refused',
    note: 'Return requested',
  });
  await action(f.admin, id, 'return', { reason: 'Customer requested return' });
  await action(f.driver, other, 'pickup', {}, 409);
  await action(f.driver, id, 'issue', {
    reason: 'Return dock blocked',
    note: 'Awaiting clearance',
  });
  await action(
    f.driver,
    id,
    'confirmReturn',
    { pod: 'RETURN', recipient: 'Warehouse' },
    409,
  );
  await action(f.admin, id, 'resolve', { resolution: 'Dock cleared' });
  await action(f.driver, id, 'confirmReturn', { pod: 'RETURN', recipient: 'Warehouse' });
  const returned = await find(f, id);
  assert.equal(returned.status, 'Returned');
  assert.equal(returned.failedAttempts.length, 2);
  assert.equal(returned.returnDestination, returned.pickup);
  assert.equal(returned.price, 450);
  assert.equal(returned.returnPod, 'RETURN');
  await action(f.driver, other, 'pickup');
});

test('driver edits require reapproval, revoke offers, and protect live cargo from truck changes', async (t) => {
  const f = await setup(t),
    id = await job(f, { stage: 'Offered' });
  let user = (await f.driver('/api/state')).value.user;
  const edit = (user, extra = {}) => ({
    ...registration('driver', 'driver@example.com'),
    ...user.truck,
    name: user.name,
    phone: user.profile.phone,
    version: user.version,
    ...extra,
  });
  assert.equal(
    (await f.driver('/api/driver-profile', 'PATCH', edit(user, { plate: 'NEW-PLATE' })))
      .status,
    200,
  );
  assert.equal((await find(f, id)).status, 'Ready to assign');
  user = (await f.driver('/api/state')).value.user;
  assert.equal(user.approved, false);
  assert.equal(
    (
      await f.admin(`/api/drivers/${f.driverId}/review`, 'POST', {
        decision: 'approve',
        reason: 'Verified changed truck',
        version: user.version - 1,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.admin(`/api/drivers/${f.driverId}/review`, 'POST', {
        decision: 'approve',
        reason: 'Verified changed truck',
        version: user.version,
      })
    ).status,
    200,
  );
  await action(f.admin, id, 'offer', { driverId: f.driverId });
  await action(f.driver, id, 'acceptJob');
  await action(f.driver, id, 'pickup');
  user = (await f.driver('/api/state')).value.user;
  assert.equal(
    (
      await f.driver(
        '/api/driver-profile',
        'PATCH',
        edit(user, { plate: 'ANOTHER-TRUCK' }),
      )
    ).status,
    409,
  );
  assert.equal(
    (await f.driver('/api/driver-profile', 'PATCH', edit(user, { phone: '555-9999' })))
      .status,
    200,
  );
  user = (await f.driver('/api/state')).value.user;
  assert.equal(user.approved, true);
  await f.admin(`/api/drivers/${f.driverId}/review`, 'POST', {
    decision: 'revoke',
    reason: 'Documents expired',
    version: user.version,
  });
  await action(f.driver, id, 'deliver', { pod: 'FINISH', recipient: 'Staff' });
});

test('saved drafts are account scoped, versioned across deletion, and clear on matching booking', async (t) => {
  const f = await setup(t);
  assert.equal((await f.driver('/api/booking-draft')).status, 403);
  let response = await f.store('/api/booking-draft', 'PUT', {
    version: 0,
    data: { pickup: 'Partial draft' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await f.other('/api/booking-draft')).value.data, {});
  assert.equal(
    (
      await f.store('/api/booking-draft', 'PUT', {
        version: 0,
        data: { pickup: 'Overwrite' },
      })
    ).status,
    409,
  );
  response = await f.store('/api/booking-draft', 'DELETE', { version: 1 });
  assert.equal(response.value.version, 2);
  assert.equal(
    (
      await f.store('/api/booking-draft', 'PUT', {
        version: 1,
        data: { pickup: 'Stale' },
      })
    ).status,
    409,
  );
  await f.store('/api/booking-draft', 'PUT', { version: 2, data: booking() });
  await f.store('/api/shipments', 'POST', booking());
  const saved = (await f.store('/api/booking-draft')).value;
  assert.deepEqual(saved.data, {});
  assert.equal(saved.version, 4);
});

test('evidence validates file types, permissions and versions and downloads exact bytes', async (t) => {
  const f = await setup(t),
    id = await job(f),
    s = await find(f, id),
    input = {
      version: s.version,
      name: 'receipt.png',
      mime: 'image/png',
      content: png.toString('base64'),
    };
  assert.equal(
    (await f.store(`/api/shipments/${id}/evidence`, 'POST', input)).status,
    403,
  );
  assert.equal(
    (
      await f.driver(`/api/shipments/${id}/evidence`, 'POST', {
        ...input,
        content: Buffer.from('<script>bad</script>').toString('base64'),
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.driver(`/api/shipments/${id}/evidence`, 'POST', input)).status,
    201,
  );
  assert.equal(
    (await f.driver(`/api/shipments/${id}/evidence`, 'POST', input)).status,
    409,
  );
  const files = (await f.store(`/api/shipments/${id}/evidence`)).value;
  assert.equal(files.length, 1);
  assert.equal((await f.other(`/api/evidence/${files[0].id}`)).status, 404);
  const cookie = (await login(f.store, 'store@example.com')).headers
    .get('set-cookie')
    .split(';')[0];
  const response = await f.request(f.url + `/api/evidence/${files[0].id}`, {
    headers: { Cookie: cookie },
  });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.match(response.headers.get('content-disposition'), /attachment/);
});

test('financial entries enforce balance limits, idempotency and customer/driver separation', async (t) => {
  const f = await setup(t),
    id = await job(f, { stage: 'Delivered' }),
    s = await find(f, id);
  assert.equal(
    (await f.store('/api/invoices', 'POST', { shipmentId: id, version: s.version }))
      .status,
    403,
  );
  let invoice = (
    await f.admin('/api/invoices', 'POST', {
      shipmentId: id,
      version: s.version,
      taxCents: 500,
    })
  ).value;
  assert.equal(invoice.totalCents, 45500);
  const post = async (kind, amount, key) =>
    f.admin(`/api/invoices/${invoice.id}/entries`, 'POST', {
      version: invoice.version,
      kind,
      amount,
      requestKey: key,
      reference: 'Bank verified',
      reason: 'Verified ledger posting',
    });
  let response = await post('payment', 100, 'payment-request-key-001');
  assert.equal(response.status, 200);
  invoice = response.value;
  assert.equal((await post('payment', 100, 'payment-request-key-001')).status, 200);
  assert.equal((await post('payment', 101, 'payment-request-key-001')).status, 409);
  assert.equal((await post('payment', 500, 'payment-request-key-002')).status, 409);
  assert.equal((await post('adjustment', -400, 'adjustment-key-001')).status, 409);
  response = await post('adjustment', -5, 'adjustment-key-002');
  assert.equal(response.status, 200);
  invoice = response.value;
  response = await post('payout', 300, 'payout-request-key-001');
  assert.equal(response.status, 200);
  invoice = response.value;
  assert.equal(invoice.dueCents, 35000);
  assert.equal((await post('payout', 1, 'payout-request-key-002')).status, 409);
  const customer = (await f.store('/api/invoices')).value[0],
    driver = (await f.driver('/api/settlements')).value[0];
  assert.equal(customer.rateCents, undefined);
  assert.ok(customer.entries.every((e) => e.kind !== 'payout'));
  assert.equal(driver.totalCents, undefined);
  assert.equal(driver.paidCents, 30000);
  assert.deepEqual((await f.other('/api/invoices')).value, []);
});

test('notifications persist, restrict access and retry delivery without exposing provider errors', async (t) => {
  let time = Date.now(),
    fail = true;
  const delivered = [];
  const f = await setup(t, {
    now: () => time,
    sendNotification: async (message) => {
      if (fail) throw new Error('secret-provider-token');
      delivered.push(message);
    },
  });
  const id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  let notices = (await f.store('/api/notifications')).value;
  assert.ok(notices.some((n) => n.shipmentId === id));
  assert.equal(
    (await f.other(`/api/notifications/${notices[0].id}/read`, 'POST', {})).status,
    404,
  );
  await f.app.processNotifications();
  notices = (await f.store('/api/notifications')).value;
  assert.equal(notices[0].deliveryStatus, 'failed');
  assert.ok(!JSON.stringify(notices).includes('secret-provider-token'));
  fail = false;
  time += 60001;
  await f.app.processNotifications();
  notices = (await f.store('/api/notifications')).value;
  assert.equal(notices[0].deliveryStatus, 'sent');
  assert.ok(delivered.length > 0);
  await f.store(`/api/notifications/${notices[0].id}/read`, 'POST', {});
  assert.ok((await f.store('/api/notifications')).value[0].readAt);
});

test('tracking and ETA require an active assignment and are visible only to delivery participants', async (t) => {
  const f = await setup(t),
    id = await job(f, { stage: 'Offered' }),
    position = { latitude: 51.05, longitude: -114.07, accuracy: 10 };
  assert.equal(
    (await f.driver(`/api/shipments/${id}/tracking`, 'POST', position)).status,
    403,
  );
  await action(f.driver, id, 'acceptJob');
  assert.equal(
    (
      await f.driver(`/api/shipments/${id}/tracking`, 'POST', {
        ...position,
        latitude: 91,
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.driver(`/api/shipments/${id}/tracking`, 'POST', position)).status,
    200,
  );
  assert.equal(
    (
      await f.driver(`/api/shipments/${id}/tracking`, 'PATCH', {
        eta: '2000-01-01T00:00:00Z',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.driver(`/api/shipments/${id}/tracking`, 'PATCH', {
        eta: new Date(Date.now() + 3600000).toISOString(),
      })
    ).status,
    200,
  );
  const result = (await f.store(`/api/shipments/${id}/tracking`)).value;
  assert.equal(result.latitude, 51.05);
  assert.ok(result.recordedAt);
  assert.ok(result.eta);
  assert.equal((await f.other(`/api/shipments/${id}/tracking`)).status, 404);
});

test('reports filter dates and escape CSV formulas while excluding non-brokers', async (t) => {
  const f = await setup(t);
  await f.store('/api/profile', 'PATCH', {
    name: '=HYPERLINK("bad")',
    phone: '555',
    address: 'Store',
    contact: 'Staff',
  });
  await job(f);
  await job(f, { date: '2099-11-06' });
  assert.equal((await f.store('/api/reports')).status, 403);
  const report = (await f.admin('/api/reports?from=2099-11-06&to=2099-11-06')).value;
  assert.equal(report.summary.total, 1);
  const csv = await f.admin('/api/reports?format=csv');
  assert.equal(csv.status, 200);
  assert.ok(csv.value.includes("'="));
  assert.equal(csv.headers.get('cache-control'), 'no-store');
});
