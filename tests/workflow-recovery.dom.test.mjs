import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, booking, action, registration, login } from './helpers/app.mjs';
import { renderApp } from './helpers/dom.mjs';
async function assigned(t) {
  const f = await setup(t);
  const id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  await action(f.admin, id, 'quote', { price: 450, rate: 300 });
  await action(f.store, id, 'acceptQuote');
  await action(f.admin, id, 'offer', { driverId: f.driverId });
  await action(f.driver, id, 'acceptJob');
  return { ...f, id };
}
test('owner can replace an unanswered review with cancellation and withdraw it through the UI', async (t) => {
  const f = await assigned(t);
  await action(f.store, f.id, 'requestChange', {
    kind: 'quotation',
    details: 'Review price',
  });
  await action(f.driver, f.id, 'pickup');
  const ui = await renderApp(t, f.store);
  await ui.drawer();
  await ui.input('details', 'Receiving dock closed; arrange return');
  ui.button('Send request to broker').click();
  await ui.wait(() => ui.doc.body.textContent.includes('quotation · superseded'));
  assert.match(ui.doc.body.textContent, /cancellation · pending/);
  await ui.input('#withdraw-request-reason', 'Dock reopened; continue delivery');
  ui.button('Withdraw pending request').click();
  await ui.wait(() => ui.doc.body.textContent.includes('cancellation · withdrawn'));
  assert.equal((await f.admin('/api/state')).value.shipments[0].status, 'In transit');
});
test('broker assigns and pays separate handover driver shares through billing forms', async (t) => {
  const f = await assigned(t);
  await action(f.driver, f.id, 'pickup');
  const next = f.client(),
    email = 'billing-ui-replacement@example.com';
  const id = (
    await next('/api/register', 'POST', {
      ...registration('driver', email),
      name: 'Replacement Driver',
    })
  ).value.id;
  await login(next, email);
  await f.admin(`/api/drivers/${id}/approve`, 'POST', {});
  await action(f.admin, f.id, 'handover', {
    driverId: id,
    reason: 'Transfer remaining cargo',
  });
  await action(next, f.id, 'acceptJob');
  await action(next, f.id, 'deliver', { pod: 'BILLING-UI', recipient: 'Staff' });
  const ui = await renderApp(t, f.admin);
  const billing = () =>
    [...ui.doc.querySelectorAll('nav button')].find((button) =>
      button.textContent.endsWith('Billing'),
    );
  await ui.wait(() => billing());
  billing().click();
  await ui.wait(() => ui.doc.querySelector('select[name="shipmentId"]'));
  await ui.input('shipmentId', f.id);
  await ui.wait(() => ui.doc.querySelector(`input[name="share:${f.driverId}"]`));
  await ui.input(`share:${f.driverId}`, '100');
  await ui.input(`share:${id}`, '200');
  await ui.input(`shareReason:${f.driverId}`, 'Pickup and first leg');
  await ui.input(`shareReason:${id}`, 'Final delivery leg');
  ui.button('Issue invoice').click();
  await ui.wait(() => ui.doc.body.textContent.includes('Driver rate $300.00'));
  assert.match(ui.doc.body.textContent, /driver Account: allocated CAD 100.00/);
  assert.match(ui.doc.body.textContent, /Replacement Driver: allocated CAD 200.00/);
  await ui.input('kind', 'payout');
  await ui.input('driverId', f.driverId);
  await ui.input('amount', '100');
  await ui.input('reference', 'BANK-UI');
  await ui.input('reason', 'Verified bank transfer');
  ui.button('Record financial entry').click();
  await ui.wait(() => ui.doc.body.textContent.includes('Paid out $100.00'));
  assert.equal((await f.driver('/api/settlements')).value[0].paidCents, 10000);
  assert.equal((await next('/api/settlements')).value[0].paidCents, 0);
  const driverUi = await renderApp(t, f.driver);
  const payouts = () =>
    [...driverUi.doc.querySelectorAll('nav button')].find((button) =>
      button.textContent.endsWith('Payouts'),
    );
  await driverUi.wait(() => payouts());
  payouts().click();
  await driverUi.wait(() =>
    driverUi.doc.body.textContent.includes('Allocated driver share'),
  );
  assert.match(
    driverUi.doc.body.textContent,
    /Allocation explanation: Pickup and first leg/,
  );
  assert.doesNotMatch(driverUi.doc.body.textContent, /Invoice total/);
});
