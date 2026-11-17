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
test('PWA buffers offline GPS, resumes on reconnect, reports visibility and releases optional wake lock', async (t) => {
  const f = await assigned(t);
  let point,
    clears = 0,
    requests = 0,
    releases = 0;
  const ui = await renderApp(t, f.driver, {
    beforeRender(window) {
      Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        value: false,
      });
      Object.defineProperty(window.navigator, 'geolocation', {
        value: {
          watchPosition(callback) {
            point = callback;
            return 4;
          },
          clearWatch() {
            clears++;
          },
        },
      });
      Object.defineProperty(window.navigator, 'wakeLock', {
        value: {
          async request() {
            requests++;
            return {
              async release() {
                releases++;
              },
              addEventListener() {},
            };
          },
        },
      });
    },
  });
  await ui.wait(() => ui.button('Share phone GPS'));
  ui.button('Share phone GPS').click();
  await ui.wait(() => typeof point === 'function');
  point({
    coords: { latitude: 51.05, longitude: -114.07, accuracy: 8 },
    timestamp: Date.now(),
  });
  assert.ok(ui.window.localStorage.getItem(`yyc-location:${f.driverId}`));
  assert.equal(
    (await f.store(`/api/shipments/${f.id}/tracking`)).value.latitude,
    undefined,
  );
  Object.defineProperty(ui.window.navigator, 'onLine', {
    configurable: true,
    value: true,
  });
  ui.window.dispatchEvent(new ui.window.Event('online'));
  await ui.wait(() => ui.doc.querySelector('a[href*="mlat=51.05&mlon=-114.07"]'));
  assert.equal(ui.window.localStorage.getItem(`yyc-location:${f.driverId}`), null);
  assert.ok(ui.doc.body.textContent.includes('Last successful GPS upload:'));
  ui.button('Keep screen awake while sharing').click();
  await ui.wait(() => requests === 1);
  Object.defineProperty(ui.doc, 'visibilityState', {
    configurable: true,
    value: 'hidden',
  });
  ui.doc.dispatchEvent(new ui.window.Event('visibilitychange'));
  await ui.wait(() => releases === 1);
  assert.ok(ui.doc.body.textContent.includes('PWA is hidden. GPS may pause'));
  Object.defineProperty(ui.doc, 'visibilityState', {
    configurable: true,
    value: 'visible',
  });
  ui.doc.dispatchEvent(new ui.window.Event('visibilitychange'));
  await ui.wait(() => requests === 2);
  ui.button('Stop sharing phone GPS').click();
  await ui.wait(() => clears === 1 && releases === 2);
});
test('revoked PWA location uploads stop the watch and remove buffered GPS', async (t) => {
  const f = await assigned(t);
  let point,
    clears = 0;
  const client = (path, method, ...args) =>
    path.endsWith('/tracking') && method === 'POST'
      ? Promise.resolve({ status: 403, value: { error: 'Assignment revoked' } })
      : f.driver(path, method, ...args);
  const ui = await renderApp(t, client, {
    beforeRender(window) {
      Object.defineProperty(window.navigator, 'geolocation', {
        value: {
          watchPosition(callback) {
            point = callback;
            return 1;
          },
          clearWatch() {
            clears++;
          },
        },
      });
    },
  });
  await ui.wait(() => ui.button('Share phone GPS'));
  ui.button('Share phone GPS').click();
  await ui.wait(() => typeof point === 'function');
  point({
    coords: { latitude: 51, longitude: -114, accuracy: 10 },
    timestamp: Date.now(),
  });
  await ui.wait(() => clears === 1);
  assert.equal(ui.window.localStorage.getItem(`yyc-location:${f.driverId}`), null);
  assert.ok(!ui.doc.body.textContent.includes('Location sharing active'));
});
test('broker can acknowledge a delivery alert without resolving the issue', async (t) => {
  const f = await assigned(t);
  await action(f.driver, f.id, 'issue', {
    reason: 'Vehicle issue',
    note: 'Need assistance',
  });
  const ui = await renderApp(t, f.admin);
  await ui.wait(() => ui.button('Acknowledge alert'));
  ui.button('Acknowledge alert').click();
  await ui.wait(() => ui.button('Acknowledged'));
  assert.equal(ui.button('Acknowledged').disabled, true);
  const alerts = (await f.admin('/api/broker-alerts')).value.alerts;
  assert.ok(alerts.find((alert) => alert.kind === 'open_issue').acknowledgedAt);
  assert.equal(
    (await f.admin('/api/state')).value.shipments.find((s) => s.id === f.id).issue
      .resolved,
    false,
  );
});
