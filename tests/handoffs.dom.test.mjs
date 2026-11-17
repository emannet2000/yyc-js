import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, start, booking, action } from './helpers/app.mjs';
import { renderApp } from './helpers/dom.mjs';
async function request(t) {
  const f = await setup(t);
  const id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  return { ...f, id };
}
test('owner sees external quotations on focus and submits a broker-reviewed change request', async (t) => {
  const f = await request(t),
    ui = await renderApp(t, f.store);
  await ui.drawer();
  await action(f.admin, f.id, 'quote', { price: 450, rate: 300 });
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await ui.wait(() => ui.button('Accept quotation'));
  await ui.input('details', 'Please review this quotation');
  ui.button('Send request to broker').click();
  await ui.wait(() => ui.doc.body.textContent.includes('Awaiting broker review'));
  const s = (await f.admin('/api/state')).value.shipments[0];
  assert.equal(s.customerRequests[0].details, 'Please review this quotation');
  assert.equal(s.status, 'Quote ready');
});
test('driver background refresh removes cancelled instructions and displays persistent assignment alert', async (t) => {
  const f = await request(t);
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  await action(f.admin, f.id, 'quote', { price: 450, rate: 300 });
  await action(f.store, f.id, 'acceptQuote');
  await action(f.admin, f.id, 'offer', { driverId: f.driverId });
  await action(f.driver, f.id, 'acceptJob');
  const ui = await renderApp(t, f.driver);
  await ui.drawer();
  await action(f.admin, f.id, 'cancel');
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await ui.wait(() => ui.button('Acknowledge assignment change'));
  assert.match(ui.doc.body.textContent, /Stop following the previous instructions/);
  assert.equal(ui.doc.querySelector('[role="dialog"]'), null);
  assert.equal(ui.button('Confirm pickup'), undefined);
});
test('broker reviews and applies an owner proposal through the actual form', async (t) => {
  const f = await request(t);
  await action(f.store, f.id, 'requestChange', {
    kind: 'shipment',
    details: 'Receiving dock moved',
    destination: 'New dock',
    kg: 500,
    pallets: 2,
  });
  const ui = await renderApp(t, f.admin);
  await ui.drawer();
  assert.match(ui.doc.body.textContent, /Review the owner request/);
  await ui.input('#request-decision', 'approve');
  await ui.input('response', 'Confirmed the revised receiving dock');
  ui.button('Send broker decision').click();
  await ui.wait(() => ui.doc.body.textContent.includes('shipment · approved'));
  const s = (await f.store('/api/state')).value.shipments[0];
  assert.equal(s.destination, 'New dock');
  assert.equal(s.status, 'Awaiting quote');
});
test('first broker setup appears in an empty workspace and consumes operator token', async (t) => {
  const f = await start(t),
    token = f.app.createSetupToken();
  const ui = await renderApp(t, f.client());
  await ui.wait(() => ui.button('Set up broker account'));
  ui.button('Set up broker account').click();
  await ui.wait(() => ui.doc.querySelector('input[name="token"]'));
  for (const [name, value] of Object.entries({
    token,
    name: 'Operations Broker',
    phone: '4035550100',
    email: 'operator@example.com',
    password: 'Private-password-2026',
    confirm: 'Private-password-2026',
  }))
    await ui.input(name, value);
  ui.button('Create broker account').click();
  await ui.wait(() => ui.button('Log in'));
  await ui.wait(() => !ui.button('Set up broker account'));
  assert.equal((await f.client()('/api/setup')).value.required, false);
});
