import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  booking,
  action,
  attachDeliveryEvidence,
  registration,
  login,
} from './helpers/app.mjs';
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

for (const status of ['Delivered', 'Returned']) {
  test(`broker can invoice a ${status.toLowerCase()} job from the work queue`, async (t) => {
    const f = await quoted(t);
    await action(f.store, f.id, 'acceptQuote');
    await action(f.admin, f.id, 'offer', { driverId: f.driverId });
    await action(f.driver, f.id, 'acceptJob');
    await action(f.driver, f.id, 'pickup');
    if (status === 'Delivered') {
      const driverUi = await renderApp(t, f.driver);
      await driverUi.drawer();
      assert.match(
        driverUi.doc.querySelector('[aria-label="Workflow guidance"]').textContent,
        /upload a delivery photo, signature image, or receipt document for this attempt in Evidence files/,
      );
      await action(f.driver, f.id, 'arrival');
      await attachDeliveryEvidence(f.driver, f.id);
      await action(f.driver, f.id, 'deliver', { pod: 'RECEIPT', recipient: 'Staff' });
    } else {
      await action(f.admin, f.id, 'return', { reason: 'Customer requested return' });
      await action(f.driver, f.id, 'confirmReturn', {
        pod: 'RETURN',
        recipient: 'Warehouse',
      });
    }

    const ui = await renderApp(t, f.admin);
    const label = `Issue invoice for ${f.id}`;
    const nav = (label) =>
      [...ui.doc.querySelectorAll('.sidebar nav button')].find((button) =>
        button.textContent.trim().endsWith(label),
      );
    await ui.wait(() => ui.button(label));
    if (status === 'Returned') {
      nav('Work queue').click();
      await ui.wait(() => ui.doc.querySelector('.shipment-card') && ui.button(label));
    }
    ui.button(label).click();
    await ui.wait(
      () => ui.doc.querySelector('select[name="shipmentId"]')?.value === f.id,
    );
    ui.button('Issue invoice').click();
    await ui.wait(() => ui.doc.body.textContent.includes('Invoice issued.'));
    const invoice = (await f.admin('/api/invoices')).value[0];
    assert.equal(invoice.shipmentId, f.id);
    nav('Operations').click();
    await ui.wait(() => ui.doc.querySelector('.attention-queue'));
    assert.equal(ui.button(label), undefined);
    nav('Work queue').click();
    await ui.wait(
      () => ui.doc.querySelector('.pagetitle h1')?.textContent === 'Work queue',
    );
    assert.equal(ui.button(label), undefined);
  });
}

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

test('broker withdraws a regular offer and can dispatch again without a new quote', async (t) => {
  const f = await quoted(t);
  await action(f.store, f.id, 'acceptQuote');
  await action(f.admin, f.id, 'offer', { driverId: f.driverId });
  await action(f.admin, f.id, 'changeRate', { rate: 325, reason: 'New proposed rate' });
  const before = (await f.admin('/api/state')).value.shipments[0];
  const ui = await renderApp(t, f.admin);
  await ui.drawer();
  ui.detail('Withdraw job offer');
  await ui.input('#withdraw-offer-reason', 'Wrong driver selected');
  ui.button('Withdraw offer').click();
  await ui.wait(() => ui.button('Send job offer'));
  const after = (await f.admin('/api/state')).value.shipments[0];
  assert.equal(after.status, 'Ready to assign');
  assert.equal(after.quoteVersion, before.quoteVersion);
  assert.equal(after.price, before.price);
  assert.equal(after.rate, before.rate);
  assert.equal(after.rateChange, undefined);
  assert.equal(after.offeredTo, null);
  assert.equal(after.offerExpiresAt, undefined);
  assert.match(after.history.at(-1).text, /Job offer withdrawn: Wrong driver selected/);
  assert.equal((await f.driver('/api/state')).value.shipments.length, 0);
  await action(f.admin, f.id, 'offer', { driverId: f.driverId });
  await action(f.driver, f.id, 'acceptJob');
});

test('a driver with revoked approval still sees the next action for live cargo', async (t) => {
  const f = await quoted(t);
  await action(f.store, f.id, 'acceptQuote');
  await action(f.admin, f.id, 'offer', { driverId: f.driverId });
  await action(f.driver, f.id, 'acceptJob');
  await action(f.driver, f.id, 'pickup');
  const { user } = (await f.driver('/api/state')).value;
  assert.equal(
    (
      await f.admin(`/api/drivers/${f.driverId}/review`, 'POST', {
        decision: 'revoke',
        version: user.version,
        reason: 'Documents expired',
      })
    ).status,
    200,
  );
  const ui = await renderApp(t, f.driver);
  await ui.wait(() => ui.button(`Review ${f.id}`));
  assert.match(
    ui.doc.querySelector('.attention-queue').textContent,
    /Complete final delivery/,
  );
});

test('billing reuses the payment retry key after the response is lost and the tab reloads', async (t) => {
  const f = await quoted(t);
  await action(f.store, f.id, 'acceptQuote');
  await action(f.admin, f.id, 'offer', { driverId: f.driverId });
  await action(f.driver, f.id, 'acceptJob');
  await action(f.driver, f.id, 'pickup');
  await action(f.driver, f.id, 'deliver', { pod: 'RECEIPT', recipient: 'Receiver' });
  const shipment = (await f.admin('/api/state')).value.shipments[0];
  const invoice = (
    await f.admin('/api/invoices', 'POST', {
      shipmentId: f.id,
      version: shipment.version,
    })
  ).value;
  async function submit(ui) {
    const billing = () =>
      [...ui.doc.querySelectorAll('.sidebar nav button')].find((b) =>
        b.textContent.trim().endsWith('Billing'),
      );
    await ui.wait(billing);
    billing().click();
    await ui.wait(() => ui.button('Record financial entry'));
    await ui.input('amount', '100');
    await ui.input('reference', 'BANK-EXTERNAL-100');
    await ui.input('reason', 'Verified customer transfer');
    ui.button('Record financial entry').click();
  }
  const ui = await renderApp(t, f.admin);
  const fetch = ui.window.fetch;
  ui.window.fetch = async (url, options) => {
    const result = await fetch(url, options);
    if (url === `/api/invoices/${invoice.id}/entries`) {
      throw new ui.window.TypeError('Connection lost after save');
    }
    return result;
  };
  await submit(ui);
  await ui.wait(() =>
    ui.doc.querySelector('.toast')?.textContent.includes('Connection lost'),
  );
  assert.equal((await f.admin('/api/invoices')).value[0].paidCents, 10000);
  const stored = Object.entries(ui.window.sessionStorage);
  assert.ok(stored.some(([key]) => key.startsWith('yyc.pending-ledger-entry:')));
  const reopened = await renderApp(t, f.admin, {
    beforeRender(window) {
      for (const [key, value] of stored) window.sessionStorage.setItem(key, value);
    },
  });
  await submit(reopened);
  await reopened.wait(() =>
    reopened.doc
      .querySelector('.toast')
      ?.textContent.includes('Financial entry recorded'),
  );
  const saved = (await f.admin('/api/invoices')).value[0];
  assert.equal(saved.paidCents, 10000);
  assert.equal(saved.entries.length, 1);
  assert.ok(
    !Object.keys(reopened.window.sessionStorage).some((key) =>
      key.startsWith('yyc.pending-ledger-entry:'),
    ),
  );
});

test('pending rescue shows handover guidance and withholds redelivery scheduling', async (t) => {
  const f = await quoted(t);
  await action(f.store, f.id, 'acceptQuote');
  await action(f.admin, f.id, 'offer', { driverId: f.driverId });
  await action(f.driver, f.id, 'acceptJob');
  await action(f.driver, f.id, 'pickup');
  await action(f.driver, f.id, 'failDelivery', {
    reason: 'Receiver absent',
    note: 'Retry',
  });
  const next = f.client();
  const email = 'redelivery-guide@example.com';
  const registered = await next('/api/register', 'POST', registration('driver', email));
  const driverId = registered.value.id;
  await f.admin(`/api/drivers/${driverId}/approve`, 'POST', {});
  await action(f.admin, f.id, 'handover', { driverId, reason: 'Rescue driver arranged' });
  const ui = await renderApp(t, f.admin);
  await ui.drawer();
  assert.match(
    ui.doc.querySelector('[aria-label="Workflow guidance"]').textContent,
    /Review pending rescue handover/,
  );
  assert.equal(ui.button('Schedule redelivery'), undefined);
  assert.ok(
    ui.doc.body.textContent.includes('Complete or withdraw the pending handover'),
  );
  await login(next, email);
  await action(next, f.id, 'acceptJob');
  ui.button('Refresh').click();
  await ui.wait(() => ui.doc.body.textContent.includes('Choose redelivery or return'));
  assert.ok(ui.button('Schedule redelivery'));
});
