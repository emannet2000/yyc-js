import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, booking, action } from './helpers/app.mjs';
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
const state = async (f) => (await f.admin('/api/state')).value.shipments[0];
test('driver records pickup and delivery offline then reconnects and replays in order', async (t) => {
  const f = await assigned(t),
    ui = await renderApp(t, f.driver);
  await ui.drawer();
  Object.defineProperty(ui.window.navigator, 'onLine', {
    configurable: true,
    value: false,
  });
  ui.window.dispatchEvent(new ui.window.Event('offline'));
  ui.button('Confirm pickup').click();
  await ui.wait(() =>
    ui.doc.body.textContent.includes('1 action(s) awaiting server confirmation'),
  );
  await ui.wait(() => ui.doc.querySelector('input[name="pod"]'));
  await ui.input('pod', 'OFFLINE-POD');
  await ui.input('recipient', 'Receiver');
  ui.button('Record arrival').click();
  await ui.wait(() =>
    ui.doc.body.textContent.includes('2 action(s) awaiting server confirmation'),
  );
  const fileInput = ui.doc.querySelector('input[name="file"]');
  Object.defineProperty(fileInput, 'files', {
    configurable: true,
    value: [
      new ui.window.File(['%PDF-1.4\nOffline receipt'], 'offline-receipt.pdf', {
        type: 'application/pdf',
      }),
    ],
  });
  // jsdom FormData reads its own file slots; provide the selected File to this form.
  const OriginalFormData = ui.window.FormData;
  ui.window.FormData = class extends OriginalFormData {
    get(name) {
      return name === 'file' ? fileInput.files[0] : super.get(name);
    }
  };
  fileInput
    .closest('form')
    .dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
  await ui.wait(() =>
    ui.doc.body.textContent.includes('3 action(s) awaiting server confirmation'),
  );
  ui.button('Confirm delivery').click();
  await ui.wait(() =>
    ui.doc.body.textContent.includes('4 action(s) awaiting server confirmation'),
  );
  assert.equal((await state(f)).status, 'Assigned');
  const queued = JSON.parse(
    ui.window.localStorage.getItem(`yyc-offline-actions:${f.driverId}`),
  );
  assert.deepEqual(
    queued.map((e) => e.action),
    ['pickup', 'arrival', 'attachEvidence', 'deliver'],
  );
  assert.equal(queued[1].version, queued[0].version + 1);
  Object.defineProperty(ui.window.navigator, 'onLine', {
    configurable: true,
    value: true,
  });
  ui.window.dispatchEvent(new ui.window.Event('online'));
  await ui.wait(() =>
    ui.doc.body.textContent.includes('All saved driver actions synced.'),
  );
  const final = await state(f);
  assert.equal(final.status, 'Delivered');
  assert.equal(final.pod, 'OFFLINE-POD');
  assert.equal(final.history.filter((e) => e.text === 'Pickup confirmed').length, 1);
  assert.equal(final.history.filter((e) => e.text === 'Delivery confirmed').length, 1);
});
test('lost action response keeps retry key and replay does not duplicate pickup', async (t) => {
  const f = await assigned(t),
    ui = await renderApp(t, f.driver);
  await ui.drawer();
  const fetch = ui.window.fetch;
  let lost = false;
  ui.window.fetch = async (path, options) => {
    const response = await fetch(path, options);
    if (!lost && path.endsWith('/actions')) {
      lost = true;
      throw new ui.window.TypeError('Connection lost');
    }
    return response;
  };
  ui.button('Confirm pickup').click();
  await ui.wait(() =>
    ui.doc.body.textContent.includes('1 action(s) awaiting server confirmation'),
  );
  assert.equal((await state(f)).status, 'In transit');
  ui.button('Sync saved actions').click();
  await ui.wait(() =>
    ui.doc.body.textContent.includes('All saved driver actions synced.'),
  );
  assert.equal(
    (await state(f)).history.filter((e) => e.text === 'Pickup confirmed').length,
    1,
  );
});
test('driver location watch survives closing drawer and stops on completed delivery', async (t) => {
  const f = await assigned(t);
  let watches = 0,
    clears = 0;
  const ui = await renderApp(t, f.driver, {
    beforeRender(window) {
      Object.defineProperty(window.navigator, 'geolocation', {
        value: {
          watchPosition() {
            watches++;
            return 42;
          },
          clearWatch(id) {
            assert.equal(id, 42);
            clears++;
          },
        },
      });
    },
  });
  await ui.drawer();
  ui.button('Share current location').click();
  await ui.wait(() => watches === 1);
  ui.doc.querySelector('[aria-label="Close delivery"]').click();
  await ui.wait(() => !ui.doc.querySelector('[role="dialog"]'));
  assert.equal(clears, 0);
  assert.ok(ui.doc.body.textContent.includes('Location sharing active'));
  await action(f.driver, f.id, 'pickup');
  await action(f.driver, f.id, 'deliver', { pod: 'POD', recipient: 'Staff' });
  ui.button('Refresh').click();
  await ui.wait(() => clears === 1);
  assert.ok(!ui.doc.body.textContent.includes('Location sharing active'));
});
test('recipient view opens without login and removes bearer token from address bar', async (t) => {
  const f = await assigned(t),
    link = (await f.store(`/api/shipments/${f.id}/recipient-link`, 'POST', {})).value.url;
  const ui = await renderApp(t, f.client(), { url: link });
  await ui.wait(() => ui.doc.body.textContent.includes(f.id));
  assert.ok(ui.doc.body.textContent.includes('Assigned'));
  assert.equal(ui.window.location.hash, '');
  assert.ok(!ui.doc.body.textContent.includes('Driver rate'));
  assert.ok(!ui.doc.querySelector('input[type="password"]'));
});

test('offline sync stops on stale assignment instead of overwriting broker revisions', async (t) => {
  const f = await assigned(t),
    ui = await renderApp(t, f.driver);
  await ui.drawer();
  Object.defineProperty(ui.window.navigator, 'onLine', {
    configurable: true,
    value: false,
  });
  ui.window.dispatchEvent(new ui.window.Event('offline'));
  ui.button('Confirm pickup').click();
  await ui.wait(() =>
    ui.doc.body.textContent.includes('1 action(s) awaiting server confirmation'),
  );
  await action(f.admin, f.id, 'change', {
    destination: 'Revised delivery',
    kg: 1000,
    pallets: 4,
    reason: 'Customer changed destination',
  });
  const before = await state(f);
  Object.defineProperty(ui.window.navigator, 'onLine', {
    configurable: true,
    value: true,
  });
  ui.window.dispatchEvent(new ui.window.Event('online'));
  await ui.wait(() => ui.doc.body.textContent.includes('Sync stopped.'));
  assert.deepEqual(await state(f), before);
  assert.equal(
    JSON.parse(ui.window.localStorage.getItem(`yyc-offline-actions:${f.driverId}`))
      .length,
    1,
  );
});

test('assigned driver creates a native phone pairing code from the delivery drawer', async (t) => {
  const f = await assigned(t),
    ui = await renderApp(t, f.driver);
  await ui.drawer();
  ui.button('Pair Android phone').click();
  await ui.wait(() => ui.doc.querySelector('.native-pairing input'));
  const code = ui.doc.querySelector('.native-pairing input').value;
  assert.match(code, /^[a-f0-9]{6}(?:-[a-f0-9]{6}){3}$/);
  const guest = f.client();
  const pair = await guest('/api/mobile/pair', 'POST', { code, name: 'Driver Android' });
  assert.equal(pair.status, 201);
  const headers = { Authorization: `Bearer ${pair.value.token}` };
  assert.equal(
    (await guest('/api/mobile/status', 'GET', undefined, headers)).status,
    200,
  );
});
