import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, booking, action } from './helpers/app.mjs';
import { renderApp } from './helpers/dom.mjs';
async function quoted(t, kg = 900) {
  const f = await setup(t);
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  const id = (await f.store('/api/shipments', 'POST', { ...booking(), kg })).value.id;
  await action(f.admin, id, 'quote', { price: 450, rate: 300 });
  return { ...f, id };
}
test('customer action queue opens quote review and updates after acceptance', async (t) => {
  const f = await quoted(t),
    ui = await renderApp(t, f.store);
  await ui.wait(() => ui.button(`Review ${f.id}`));
  ui.button(`Review ${f.id}`).click();
  await ui.wait(() => ui.doc.querySelector('[aria-label="Workflow guidance"]'));
  assert.ok(
    ui.doc
      .querySelector('[aria-label="Workflow guidance"]')
      .textContent.includes('Review and accept your quotation'),
  );
  ui.button('Accept quotation').click();
  await ui.wait(() =>
    ui.doc
      .querySelector('[aria-label="Workflow guidance"]')
      .textContent.includes('Your delivery is being dispatched'),
  );
  assert.equal(
    (await f.admin('/api/state')).value.shipments[0].status,
    'Ready to assign',
  );
  assert.ok(
    !ui.doc.querySelector('.attention-queue').textContent.includes(`Review ${f.id}`),
  );
});
test('broker queue includes failed deliveries and opens the redelivery handoff', async (t) => {
  const f = await quoted(t);
  await action(f.store, f.id, 'acceptQuote');
  await action(f.admin, f.id, 'offer', { driverId: f.driverId });
  await action(f.driver, f.id, 'acceptJob');
  await action(f.driver, f.id, 'pickup');
  await action(f.driver, f.id, 'failDelivery', {
    reason: 'Recipient absent',
    note: 'Door locked',
  });
  const ui = await renderApp(t, f.admin);
  await ui.wait(() => ui.button(`Review ${f.id}`));
  ui.button(`Review ${f.id}`).click();
  await ui.wait(() => ui.doc.querySelector('[aria-label="Workflow guidance"]'));
  assert.ok(
    ui.doc
      .querySelector('[aria-label="Workflow guidance"]')
      .textContent.includes('Choose redelivery or return'),
  );
});
test('dispatch explains why an approved truck cannot carry the load', async (t) => {
  const f = await quoted(t, 5000);
  await action(f.store, f.id, 'acceptQuote');
  const ui = await renderApp(t, f.admin);
  await ui.wait(() => ui.button(`Review ${f.id}`));
  ui.button(`Review ${f.id}`).click();
  await ui.wait(() => ui.doc.querySelector('.dispatch-readiness'));
  assert.ok(
    ui.doc
      .querySelector('.dispatch-readiness')
      .textContent.includes('No driver currently meets every requirement'),
  );
  ui.detail('Review driver availability');
  assert.ok(
    ui.doc
      .querySelector('.dispatch-readiness')
      .textContent.includes('Weight capacity too low'),
  );
  assert.equal(ui.doc.querySelector('select[name="driverId"]').options.length, 1);
});
test('notification links open their delivery in the current account', async (t) => {
  const f = await quoted(t),
    ui = await renderApp(t, f.store);
  await ui.wait(() => ui.doc.querySelector('.sidebar nav'));
  const notifications = [...ui.doc.querySelectorAll('.sidebar nav button')].find(
    (button) => button.textContent.trim().endsWith('Notifications'),
  );
  notifications.click();
  await ui.wait(() => ui.button(`Open delivery ${f.id}`));
  ui.button(`Open delivery ${f.id}`).click();
  await ui.wait(() => ui.doc.querySelector('[role="dialog"]'));
  assert.equal(ui.doc.querySelector('#delivery-title').textContent, f.id);
});

test('successful booking opens the confirmed delivery and explains the broker handoff', async (t) => {
  const f = await setup(t),
    ui = await renderApp(t, f.store);
  await ui.wait(() => ui.button('＋ Request delivery'));
  ui.button('＋ Request delivery').click();
  await ui.wait(() => ui.doc.querySelector('input[name="pickup"]'));
  for (const [name, value] of Object.entries(booking()).filter(
    ([name]) => !['window', 'type', 'unloading'].includes(name),
  ))
    await ui.input(name, String(value));
  ui.button('Submit delivery request').click();
  await ui.wait(() => ui.doc.querySelector('[role="dialog"]'));
  const actual = (await f.store('/api/state')).value.shipments;
  assert.equal(actual.length, 1);
  assert.equal(ui.doc.querySelector('#delivery-title').textContent, actual[0].id);
  assert.ok(
    ui.doc
      .querySelector('[aria-label="Workflow guidance"]')
      .textContent.includes('Waiting for a quotation'),
  );
});
