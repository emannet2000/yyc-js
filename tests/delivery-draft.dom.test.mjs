import test from 'node:test';
import assert from 'node:assert/strict';
import { renderApp } from './helpers/dom.mjs';
import { setup, booking, action, attachDeliveryEvidence } from './helpers/app.mjs';

async function openDelivery(t) {
  const f = await setup(t);
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  const id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  await action(f.admin, id, 'quote', { price: 450, rate: 300 });
  await action(f.store, id, 'acceptQuote');
  await action(f.admin, id, 'offer', { driverId: f.driverId });
  await action(f.driver, id, 'acceptJob');
  await action(f.driver, id, 'pickup');
  const ui = await renderApp(t, f.driver);
  await ui.drawer('input[name="pod"]');
  await ui.input('pod', 'DRAFT-RECEIPT-123');
  await ui.input('recipient', 'Receiving team');
  return { ...f, id, ...ui };
}

test('delivery evidence survives a version conflict and submits only after a reviewed retry', async (t) => {
  const f = await openDelivery(t),
    original = f.doc.querySelector('input[name="pod"]');
  await action(f.driver, f.id, 'arrival');
  await attachDeliveryEvidence(f.driver, f.id);
  f.button('Confirm delivery').click();
  await f.wait(() =>
    f.doc.querySelector('.toast')?.textContent.includes('Delivery changed'),
  );
  await f.wait(() => f.doc.querySelector('input[name="pod"]') !== original);
  assert.equal(f.doc.querySelector('input[name="pod"]').value, 'DRAFT-RECEIPT-123');
  assert.equal(f.doc.querySelector('input[name="recipient"]').value, 'Receiving team');
  assert.equal((await f.admin('/api/state')).value.shipments[0].status, 'In transit');
  f.button('Confirm delivery').click();
  await f.wait(() =>
    f.doc
      .querySelector('[role="dialog"]')
      ?.textContent.includes('DRAFT-RECEIPT-123 · Received by Receiving team'),
  );
  assert.equal((await f.admin('/api/state')).value.shipments[0].status, 'Delivered');
});

test('evidence survives closing a conflicted drawer, manually refreshing and reopening it', async (t) => {
  const f = await openDelivery(t);
  await action(f.driver, f.id, 'arrival');
  f.failNextRefresh();
  f.button('Confirm delivery').click();
  await f.wait(() =>
    f.doc
      .querySelector('.toast')
      ?.textContent.includes('latest workspace could not be loaded'),
  );
  assert.ok(
    f.doc.querySelector('input[name="pod"]').closest('form').querySelector('button')
      .disabled,
  );
  f.doc.querySelector('button[aria-label="Close delivery"]').click();
  await f.wait(() => !f.doc.querySelector('[role="dialog"]'));
  f.button('Refresh').click();
  await f.wait(
    () => f.doc.querySelector('.toast')?.textContent === 'Workspace refreshed.',
  );
  await f.drawer();
  assert.equal(f.doc.querySelector('input[name="pod"]').value, 'DRAFT-RECEIPT-123');
  assert.equal(f.doc.querySelector('input[name="recipient"]').value, 'Receiving team');
});
