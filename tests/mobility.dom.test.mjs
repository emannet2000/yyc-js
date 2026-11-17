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
  ui.button('Confirm delivery').click();
  await ui.wait(() =>
    ui.doc.body.textContent.includes('2 action(s) awaiting server confirmation'),
  );
  assert.equal((await state(f)).status, 'Assigned');
  const queued = JSON.parse(
    ui.window.localStorage.getItem(`yyc-offline-actions:${f.driverId}`),
  );
  assert.deepEqual(
    queued.map((e) => e.action),
    ['pickup', 'deliver'],
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
test('driver shares phone GPS from map and new coordinates appear without waiting for polling', async (t) => {
  const f = await assigned(t);
  let position,
    failure,
    clears = 0;
  const ui = await renderApp(t, f.driver, {
    beforeRender(window) {
      Object.defineProperty(window.navigator, 'geolocation', {
        value: {
          watchPosition(success, error, options) {
            assert.equal(options.enableHighAccuracy, true);
            position = success;
            failure = error;
            return 7;
          },
          clearWatch(id) {
            assert.equal(id, 7);
            clears++;
          },
        },
      });
    },
  });
  await ui.wait(() => ui.button('Share phone GPS'));
  assert.ok(ui.doc.body.textContent.includes('Driver map'));
  const navigation = [...ui.doc.querySelectorAll('a')].find((link) =>
    link.textContent.includes('Navigate to next stop'),
  );
  assert.equal(
    new URL(navigation.href).searchParams.get('destination'),
    booking().pickup,
  );
  assert.ok(ui.button('Update mapped road route'));
  assert.equal(position, undefined);
  ui.button('Share phone GPS').click();
  await ui.wait(() => typeof position === 'function');
  position({
    coords: { latitude: 51.08, longitude: -114.09, accuracy: 8 },
    timestamp: Date.now(),
  });
  await ui.wait(() => ui.doc.querySelector('a[href*="mlat=51.08&mlon=-114.09"]'));
  const shared = (await f.store(`/api/shipments/${f.id}/tracking`)).value;
  assert.equal(shared.latitude, 51.08);
  assert.equal(shared.accuracy, 8);
  assert.ok(ui.button('Following driver · Recenter'));
  failure({ code: 1 });
  await ui.wait(() =>
    ui.doc.body.textContent.includes('Location permission or GPS is unavailable'),
  );
  ui.button('Stop sharing phone GPS').click();
  await ui.wait(() => clears === 1);
  position({ coords: { latitude: 1, longitude: 1, accuracy: 1 }, timestamp: Date.now() });
  assert.equal((await f.store(`/api/shipments/${f.id}/tracking`)).value.latitude, 51.08);
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

test('PWA delivery controls keep native Android pairing deferred', async (t) => {
  const f = await assigned(t),
    ui = await renderApp(t, f.driver);
  await ui.drawer();
  assert.equal(ui.button('Pair Android phone'), undefined);
  assert.ok(ui.button('Share current location'));
});
