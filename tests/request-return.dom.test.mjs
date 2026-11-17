import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, booking, action, registration, login } from './helpers/app.mjs';
import { renderApp } from './helpers/dom.mjs';
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

test('same-request draft survives refresh but a new request requires a new decision and explanation', async (t) => {
  const f = await assigned(t);
  await action(f.store, f.id, 'requestChange', {
    kind: 'quotation',
    details: 'Review price',
  });
  const request = (await f.admin('/api/state')).value.shipments[0].customerRequests[0];
  const ui = await renderApp(t, f.admin);
  await ui.drawer();
  await ui.input('#request-decision', 'approve');
  await ui.input('#request-price', '420');
  await ui.input('#request-rate', '300');
  await ui.input('response', 'Approve reduced price only');
  await action(f.driver, f.id, 'arrival');
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await ui.wait(() => ui.doc.body.textContent.includes('Arrival recorded at pickup'));
  assert.equal(ui.doc.querySelector('#request-decision').value, 'approve');
  assert.equal(
    ui.doc.querySelector('input[name="response"]').value,
    'Approve reduced price only',
  );
  await action(f.store, f.id, 'withdrawRequest', {
    requestId: request.id,
    reason: 'No price change needed',
  });
  await action(f.store, f.id, 'requestChange', {
    kind: 'cancellation',
    details: 'Please cancel instead',
  });
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await ui.wait(() => ui.doc.body.textContent.includes('cancellation · pending'));
  assert.equal(ui.doc.querySelector('#request-decision').value, '');
  assert.equal(ui.doc.querySelector('input[name="response"]').value, '');
  ui.button('Send broker decision').click();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal((await f.admin('/api/state')).value.shipments[0].status, 'Assigned');
  await ui.input('#request-decision', 'decline');
  await ui.input('response', 'Keep original delivery instructions');
  ui.button('Send broker decision').click();
  await ui.wait(() => ui.doc.body.textContent.includes('cancellation · declined'));
  assert.equal((await f.admin('/api/state')).value.shipments[0].status, 'Assigned');
});

test('return navigation and itinerary omit unfinished customer stops and point to pickup', async (t) => {
  const f = await assigned(t);
  await action(f.admin, f.id, 'setStops', {
    stops: [{ kind: 'dropoff', address: 'Unfinished customer dock', contact: 'Staff' }],
    reason: 'Add stop',
  });
  await action(f.admin, f.id, 'quote', { price: 450, rate: 300 });
  await action(f.store, f.id, 'acceptQuote');
  await action(f.admin, f.id, 'offer', { driverId: f.driverId });
  await action(f.driver, f.id, 'acceptJob');
  await action(f.driver, f.id, 'pickup');
  await action(f.admin, f.id, 'return', {
    reason: 'Return cargo without remaining stops',
  });
  const ui = await renderApp(t, f.driver);
  await ui.drawer();
  const href = [...ui.doc.querySelectorAll('a')].find((a) =>
    a.textContent.includes('Open route in maps'),
  ).href;
  const url = new URL(href);
  assert.equal(url.searchParams.get('destination'), 'Warehouse address');
  assert.equal(url.searchParams.get('waypoints'), '');
  assert.equal(url.searchParams.has('origin'), false);
  assert.doesNotMatch(
    ui.doc.querySelector('.stop-timeline').textContent,
    /Unfinished customer dock/,
  );
  assert.match(
    ui.doc.querySelector('.stop-timeline').textContent,
    /RETURN · PICKUP LOCATION/,
  );
});

test('replacement can accept a rescue handover while exception still blocks cargo completion', async (t) => {
  const f = await assigned(t);
  await action(f.driver, f.id, 'pickup');
  await action(f.driver, f.id, 'issue', {
    reason: 'Truck broke down',
    note: 'Replacement needed to collect cargo',
  });
  const next = f.client(),
    email = 'rescue-ui-next@example.com';
  const id = (await next('/api/register', 'POST', registration('driver', email))).value
    .id;
  await login(next, email);
  await f.admin(`/api/drivers/${id}/approve`, 'POST', {});
  await action(f.admin, f.id, 'handover', {
    driverId: id,
    reason: 'Rescue broken truck',
  });
  const ui = await renderApp(t, next);
  const offers = () =>
    [...ui.doc.querySelectorAll('nav button')].find((b) =>
      b.textContent.endsWith('Job offers'),
    );
  await ui.wait(() => offers());
  offers().click();
  await ui.drawer();
  assert.equal(ui.button('Accept handover').disabled, false);
  assert.match(
    ui.doc.body.textContent,
    /Accepting responsibility does not resolve the open exception/,
  );
  ui.button('Accept handover').click();
  await ui.wait(() =>
    ui.doc.body.textContent.includes('Waiting for exception resolution'),
  );
  const s = (await f.admin('/api/state')).value.shipments[0];
  assert.equal(s.driverId, id);
  assert.equal(s.issue.resolved, false);
  assert.equal(ui.button('Confirm delivery'), undefined);
});

test('failed delivery immediately hides cached ETA and ETA controls while retaining location sharing', async (t) => {
  const f = await assigned(t),
    eta = new Date(Date.now() + 3600000).toISOString();
  await f.admin(`/api/shipments/${f.id}/tracking`, 'PATCH', { eta });
  const ui = await renderApp(t, f.driver);
  await ui.drawer();
  await ui.wait(() => ui.doc.body.textContent.includes('Estimated arrival:'));
  await action(f.driver, f.id, 'pickup');
  await action(f.driver, f.id, 'failDelivery', {
    reason: 'Dock closed',
    note: 'Await broker instructions',
  });
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await ui.wait(() =>
    ui.doc.body.textContent.includes(
      'ETA is unavailable until the broker arranges redelivery or return',
    ),
  );
  assert.doesNotMatch(ui.doc.body.textContent, /Estimated arrival:/);
  assert.equal(ui.button('Update ETA'), undefined);
  assert.equal(ui.button('Calculate road route and ETA'), undefined);
  assert.ok(ui.button('Share current location'));
});
