import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, booking, action, registration, login } from './helpers/app.mjs';
import { renderApp } from './helpers/dom.mjs';
async function assigned(t, inTransit = false) {
  const f = await setup(t);
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  const id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  await action(f.admin, id, 'quote', { price: 450, rate: 300 });
  await action(f.store, id, 'acceptQuote');
  await action(f.admin, id, 'offer', { driverId: f.driverId });
  await action(f.driver, id, 'acceptJob');
  if (inTransit) await action(f.driver, id, 'pickup');
  return { ...f, id };
}
async function conflict(ui, fixture, field, buttonLabel) {
  const before = ui.doc.querySelector(field);
  await action(fixture.driver, fixture.id, 'arrival');
  ui.button(buttonLabel).click();
  await ui.wait(() =>
    ui.doc.querySelector('.toast')?.textContent.includes('Delivery changed'),
  );
  await ui.wait(() => ui.doc.querySelector(field) !== before);
}

test('quotation correction amounts and reason survive a conflicting arrival update', async (t) => {
  const f = await assigned(t),
    ui = await renderApp(t, f.admin);
  await ui.drawer();
  ui.detail('Correct quotation');
  await ui.input('price', '500');
  await ui.input('rate', '350');
  await ui.input('reason', 'Pricing approved by customer contact');
  await conflict(ui, f, '#requote-price', 'Issue corrected quotation');
  ui.detail('Correct quotation');
  assert.equal(ui.doc.querySelector('#requote-price').value, '500');
  assert.equal(ui.doc.querySelector('#requote-rate').value, '350');
  assert.equal(
    ui.doc.querySelector('#requote-reason').value,
    'Pricing approved by customer contact',
  );
  ui.button('Issue corrected quotation').click();
  await ui.wait(
    () => ui.doc.querySelector('.toast')?.textContent === 'Delivery updated.',
  );
  const state = (await f.admin('/api/state')).value.shipments[0];
  assert.equal(state.price, 500);
  assert.equal(state.status, 'Quote ready');
});

test('a handover driver selection and reason survive a version conflict', async (t) => {
  const f = await assigned(t),
    replacement = f.client();
  await replacement(
    '/api/register',
    'POST',
    registration('driver', 'draft-replacement@example.com'),
  );
  await login(replacement, 'draft-replacement@example.com');
  const replacementId = (await replacement('/api/state')).value.user.id;
  await f.admin(`/api/drivers/${replacementId}/approve`, 'POST', {});
  const ui = await renderApp(t, f.admin);
  await ui.drawer();
  ui.detail('Arrange driver handover');
  await ui.input('driverId', replacementId);
  await ui.input('#handover-reason', 'Driver transfer agreed at depot');
  await conflict(ui, f, '#handover-driver', 'Offer handover');
  ui.detail('Arrange driver handover');
  assert.equal(ui.doc.querySelector('#handover-driver').value, replacementId);
  assert.equal(
    ui.doc.querySelector('#handover-reason').value,
    'Driver transfer agreed at depot',
  );
  ui.button('Offer handover').click();
  await ui.wait(
    () => ui.doc.querySelector('.toast')?.textContent === 'Delivery updated.',
  );
  assert.equal((await f.admin('/api/state')).value.shipments[0].offeredTo, replacementId);
});

test('exception details survive a conflict and remain editable for a reviewed retry', async (t) => {
  const f = await assigned(t, true),
    ui = await renderApp(t, f.driver);
  await ui.drawer();
  ui.detail('Report an issue');
  await ui.input('reason', 'Receiving contact unavailable');
  await ui.input('note', 'Wait at receiving entrance; do not unload');
  await conflict(ui, f, 'input[name="note"]', 'Report issue');
  ui.detail('Report an issue');
  assert.equal(
    ui.doc.querySelector('input[name="reason"]').value,
    'Receiving contact unavailable',
  );
  assert.equal(
    ui.doc.querySelector('input[name="note"]').value,
    'Wait at receiving entrance; do not unload',
  );
  ui.button('Report issue').click();
  await ui.wait(
    () => ui.doc.querySelector('.toast')?.textContent === 'Delivery updated.',
  );
  assert.equal(
    (await f.admin('/api/state')).value.shipments[0].issue.note,
    'Wait at receiving entrance; do not unload',
  );
});

test('driver controls enforce the exception hold and allow a fresh arrival only after pickup', async (t) => {
  const f = await assigned(t);
  await action(f.driver, f.id, 'issue', {
    reason: 'Unsafe cargo',
    note: 'Awaiting warehouse inspection',
  });
  const ui = await renderApp(t, f.driver);
  await ui.drawer();
  assert.equal(ui.button('Confirm pickup').disabled, true);
  ui.button('Record arrival').click();
  await ui.wait(() => !ui.button('Record arrival'));
  const pickupArrival = (await f.admin('/api/state')).value.shipments[0].arrivedAt;
  assert.ok(pickupArrival);
  await action(f.admin, f.id, 'resolve', { resolution: 'Cargo inspected and released' });
  await ui.wait(() => !ui.button('Refresh').disabled);
  ui.button('Refresh').click();
  await ui.wait(
    () => ui.button('Confirm pickup') && !ui.button('Confirm pickup').disabled,
  );
  ui.button('Confirm pickup').click();
  await ui.wait(() => ui.button('Record arrival'));
  assert.equal(
    (await f.admin('/api/state')).value.shipments[0].pickupArrivedAt,
    pickupArrival,
  );
  ui.button('Record arrival').click();
  await ui.wait(() => !ui.button('Record arrival'));
  assert.equal((await f.admin('/api/state')).value.shipments[0].status, 'In transit');
});

test('refresh recovers saves after another tab replaces the same-account session', async (t) => {
  const f = await setup(t);
  const id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  await action(f.admin, id, 'quote', { price: 450, rate: 300 });
  const ui = await renderApp(t, f.store);
  await ui.drawer();
  await login(f.store, 'store@example.com');
  ui.button('Refresh').click();
  await ui.wait(
    () => ui.doc.querySelector('.toast')?.textContent === 'Workspace refreshed.',
  );
  ui.button('Accept quotation').click();
  await ui.wait(
    () => ui.doc.querySelector('.toast')?.textContent === 'Delivery updated.',
  );
  assert.equal(
    (await f.store('/api/state')).value.shipments.find((s) => s.id === id).status,
    'Ready to assign',
  );
});

test('refresh after an account switch closes the old delivery and writes only to the new account', async (t) => {
  const f = await setup(t);
  const first = (await f.store('/api/shipments', 'POST', booking())).value.id;
  const second = (await f.other('/api/shipments', 'POST', booking())).value.id;
  for (const id of [first, second])
    await action(f.admin, id, 'quote', { price: 450, rate: 300 });
  const ui = await renderApp(t, f.store);
  await ui.drawer();
  assert.ok(ui.doc.querySelector('[role="dialog"]').textContent.includes(first));
  await login(f.store, 'other@example.com');
  ui.button('Refresh').click();
  await ui.wait(
    () => ui.doc.querySelector('.toast')?.textContent === 'Workspace refreshed.',
  );
  assert.equal(ui.doc.querySelector('[role="dialog"]'), null);
  await ui.drawer();
  assert.ok(ui.doc.querySelector('[role="dialog"]').textContent.includes(second));
  ui.button('Accept quotation').click();
  await ui.wait(
    () => ui.doc.querySelector('.toast')?.textContent === 'Delivery updated.',
  );
  const shipments = (await f.admin('/api/state')).value.shipments;
  assert.equal(shipments.find((s) => s.id === first).status, 'Quote ready');
  assert.equal(shipments.find((s) => s.id === second).status, 'Ready to assign');
});
