import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, booking, action, registration, login } from './helpers/app.mjs';
import { renderApp } from './helpers/dom.mjs';

test('live map uses authorized GPS data and shows the same position in delivery details', async (t) => {
  const time = Date.now();
  const f = await setup(t, {
    now: () => time,
    calculateRoute: async (points) => ({
      distanceMeters: 10000,
      durationSeconds: 900,
      legs: points.slice(1).map(() => ({ distanceMeters: 5000, durationSeconds: 450 })),
      geometry: {
        type: 'LineString',
        coordinates: [
          [-114.07, 51.05],
          [-114.08, 51.06],
        ],
      },
    }),
  });
  const id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  await action(f.admin, id, 'quote', { price: 450, rate: 300 });
  await action(f.store, id, 'acceptQuote');
  await action(f.admin, id, 'offer', { driverId: f.driverId });
  await action(f.driver, id, 'acceptJob');
  assert.equal(
    (
      await f.driver(`/api/shipments/${id}/tracking`, 'POST', {
        latitude: 51.05,
        longitude: -114.07,
        accuracy: 10,
      })
    ).status,
    200,
  );
  let poll;
  let clock = time;
  const freshnessTicks = [];
  const ui = await renderApp(t, f.store, {
    beforeRender(window) {
      window.SVGSVGElement.prototype.createSVGRect = () => ({});
      window.Date.now = () => clock;
      const interval = window.setInterval.bind(window);
      window.setInterval = (callback, delay, ...args) => {
        if (delay === 15000) freshnessTicks.push(callback);
        return interval(callback, delay, ...args);
      };
      window.HTMLCanvasElement.prototype.getContext = () => {
        throw new Error('Canvas and WebGL are unavailable');
      };
      const schedule = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => {
        if (delay === 30000) poll = callback;
        return schedule(callback, delay, ...args);
      };
    },
  });
  await ui.wait(() =>
    ui.doc.querySelector('[aria-label="Driver location map"] .driver-map-pin'),
  );
  const map = ui.doc.querySelector('[aria-label="Driver location map"]');
  assert.ok(map.querySelector('.leaflet-control-zoom-in'));
  assert.ok(
    map
      .querySelector('img.leaflet-tile')
      .src.startsWith('https://tile.openstreetmap.org/'),
  );
  assert.equal(ui.doc.querySelector('iframe'), null);
  assert.ok(ui.doc.querySelector('a[href*="mlat=51.05&mlon=-114.07"]'));
  assert.ok(ui.doc.body.textContent.includes('Recent driver location'));
  await ui.wait(() => ui.doc.querySelector('.delivery-road-line'));
  assert.ok(ui.button('Fit road route'));
  assert.ok(ui.doc.body.textContent.includes('Store delivery map'));
  assert.equal(ui.button('Update mapped road route'), undefined);
  assert.equal(ui.button('Share phone GPS'), undefined);
  const summary = ui.doc.querySelector('.map-delivery-summary');
  assert.ok(summary.textContent.includes('Pickup'));
  assert.ok(summary.textContent.includes(booking().pickup));
  assert.ok(summary.textContent.includes(booking().destination));
  assert.ok(summary.textContent.includes('Next stop'));
  assert.ok(summary.textContent.includes('Assigned'));
  ui.button('Enlarge map').click();
  await ui.wait(() => map.classList.contains('is-expanded'));
  assert.equal(ui.button('Reduce map').getAttribute('aria-expanded'), 'true');
  ui.window.dispatchEvent(
    new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  await ui.wait(() => !map.classList.contains('is-expanded'));
  assert.equal(ui.doc.activeElement, ui.button('Enlarge map'));
  ui.button('Open mapped delivery').click();
  await ui.wait(() => ui.doc.querySelector('[role="dialog"]'));
  assert.ok(ui.doc.querySelector('[role="dialog"]').textContent.includes(id));
  await ui.wait(() => ui.doc.querySelector('[role="dialog"] .driver-map-pin'));
  assert.equal((await f.other(`/api/shipments/${id}/tracking`)).status, 404);
  assert.equal(
    (
      await f.driver(`/api/shipments/${id}/tracking`, 'POST', {
        latitude: 51.06,
        longitude: -114.08,
        accuracy: 150,
      })
    ).status,
    200,
  );
  assert.equal(typeof poll, 'function');
  poll();
  await ui.wait(() => ui.doc.querySelector('a[href*="mlat=51.06&mlon=-114.08"]'));
  assert.equal(map.querySelectorAll('.driver-map-pin').length, 1);
  assert.ok(ui.doc.body.textContent.includes('Low GPS accuracy'));
  clock += 6 * 60000;
  freshnessTicks.forEach((tick) => tick());
  await ui.wait(() => map.querySelector('.driver-map-pin.is-stale'));
  assert.ok(ui.doc.body.textContent.includes('Stale location'));
});

test('broker fleet map displays multiple drivers and opens the selected delivery', async (t) => {
  const time = Date.now();
  const f = await setup(t, { now: () => time });
  const otherDriver = f.client();
  await otherDriver('/api/register', 'POST', registration('driver', 'fleet@example.com'));
  await login(otherDriver, 'fleet@example.com');
  const otherId = (await otherDriver('/api/state')).value.user.id;
  const missingDriver = f.client();
  await missingDriver(
    '/api/register',
    'POST',
    registration('driver', 'missing-gps@example.com'),
  );
  await login(missingDriver, 'missing-gps@example.com');
  const missingId = (await missingDriver('/api/state')).value.user.id;
  const ids = [];
  for (const [driver, driverId, latitude] of [
    [f.driver, f.driverId, 51.05],
    [otherDriver, otherId, 51.09],
    [missingDriver, missingId, undefined],
  ]) {
    await f.admin(`/api/drivers/${driverId}/approve`, 'POST', {});
    const id = (await f.store('/api/shipments', 'POST', booking())).value.id;
    ids.push(id);
    await action(f.admin, id, 'quote', { price: 450, rate: 300 });
    await action(f.store, id, 'acceptQuote');
    await action(f.admin, id, 'offer', { driverId });
    await action(driver, id, 'acceptJob');
    if (latitude !== undefined)
      await driver(`/api/shipments/${id}/tracking`, 'POST', {
        latitude,
        longitude: -114.07,
        accuracy: 8,
        recordedAt: new Date(time - (driverId === otherId ? 4 * 60000 : 0)).toISOString(),
      });
  }
  const ui = await renderApp(t, f.admin, {
    beforeRender(window) {
      window.Date.now = () => time + 2 * 60000;
    },
  });
  await ui.wait(() => ui.button('Fleet view'));
  ui.button('Fleet view').click();
  await ui.wait(
    () =>
      ui.doc.querySelectorAll('[aria-label="Fleet location map"] .driver-map-pin')
        .length === 2,
  );
  assert.ok(ui.doc.body.textContent.includes('2 drivers located'));
  assert.ok(ui.doc.body.textContent.includes('1 without GPS'));
  await ui.input('fleetFreshness', 'missing');
  await ui.wait(() => ui.doc.querySelectorAll('.fleet-driver-list li').length === 1);
  assert.ok(ui.doc.querySelector('.fleet-driver-list').textContent.includes(ids[2]));
  assert.equal(
    ui.doc.querySelectorAll('[aria-label="Fleet location map"] .driver-map-pin').length,
    0,
  );
  assert.equal(ui.button('Fit all drivers').disabled, true);
  await ui.input('fleetFreshness', 'stale');
  await ui.wait(() => ui.doc.querySelectorAll('.driver-map-pin.is-stale').length === 1);
  assert.ok(ui.doc.querySelector('.fleet-driver-list').textContent.includes(ids[1]));
  await ui.input('fleetFreshness', 'recent');
  await ui.wait(() =>
    ui.doc.querySelector('.fleet-driver-list').textContent.includes(ids[0]),
  );
  assert.ok(!ui.doc.querySelector('.fleet-driver-list').textContent.includes(ids[1]));
  ui.button('Clear fleet filters').click();
  await ui.input('fleetSearch', ids[0].toLowerCase());
  await ui.wait(() => ui.doc.querySelectorAll('.fleet-driver-list li').length === 1);
  assert.ok(ui.doc.querySelector('.fleet-driver-list').textContent.includes(ids[0]));
  await ui.input('fleetSearch', 'no-matching-driver');
  await ui.wait(() =>
    ui.doc.body.textContent.includes('No drivers match these filters.'),
  );
  ui.button('Clear fleet filters').click();
  await ui.wait(
    () =>
      ui.doc.querySelectorAll('[aria-label="Fleet location map"] .driver-map-pin')
        .length === 2,
  );
  assert.ok(ui.button('Fit all drivers'));
  const pins = ui.doc.querySelectorAll(
    '[aria-label="Fleet location map"] .driver-map-pin',
  );
  const target = [...pins].find((pin) => pin.title.includes(ids[1]));
  assert.ok(target);
  target.click();
  await ui.wait(() => ui.doc.querySelector('[role="dialog"]'));
  assert.ok(ui.doc.querySelector('[role="dialog"]').textContent.includes(ids[1]));
});

test('map never invents a position when no active deliveries exist', async (t) => {
  const f = await setup(t);
  const ui = await renderApp(t, f.store);
  await ui.wait(() => ui.doc.body.textContent.includes('No active deliveries to track.'));
  const map = ui.doc.querySelector('[aria-label="Delivery area map"]');
  assert.ok(map);
  assert.equal(map.querySelector('.driver-map-pin'), null);
  assert.equal(ui.doc.querySelector('.map-delivery-summary'), null);
  assert.equal(ui.button('Open mapped delivery'), undefined);
  assert.equal(ui.button('Fleet view'), undefined);
});
test('store owner map explains progress before driver assignment without GPS sharing controls', async (t) => {
  const f = await setup(t);
  const id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  const ui = await renderApp(t, f.store);
  await ui.wait(() => ui.doc.querySelector('.map-progress'));
  assert.ok(ui.doc.body.textContent.includes('Store delivery map'));
  assert.ok(
    ui.doc.querySelector('.map-delivery-summary').textContent.includes('Awaiting quote'),
  );
  assert.equal(ui.doc.querySelectorAll('.map-progress [data-complete="true"]').length, 1);
  assert.equal(ui.button('Share phone GPS'), undefined);
  assert.equal(ui.button('Fleet view'), undefined);
  assert.equal(ui.button('Update mapped road route'), undefined);
  ui.button('Open mapped delivery').click();
  await ui.wait(() => ui.doc.querySelector('[role="dialog"]'));
  assert.ok(ui.doc.querySelector('[role="dialog"]').textContent.includes(id));
});

test('failed tracking requests show an error without embedding a location', async (t) => {
  const f = await setup(t);
  const id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  await action(f.admin, id, 'quote', { price: 450, rate: 300 });
  await action(f.store, id, 'acceptQuote');
  await action(f.admin, id, 'offer', { driverId: f.driverId });
  await action(f.driver, id, 'acceptJob');
  await f.driver(`/api/shipments/${id}/tracking`, 'POST', {
    latitude: 51.05,
    longitude: -114.07,
    accuracy: 10,
  });
  let unavailable = true;
  const client = (path, ...args) =>
    unavailable && path.endsWith('/tracking')
      ? Promise.resolve({ status: 503, value: { error: 'Unavailable' } })
      : f.store(path, ...args);
  const ui = await renderApp(t, client);
  await ui.wait(() => ui.doc.body.textContent.includes('Cannot load driver location.'));
  const map = ui.doc.querySelector('[aria-label="Delivery area map"]');
  assert.ok(map);
  assert.equal(map.querySelector('.driver-map-pin'), null);
  unavailable = false;
  ui.button('Refresh location').click();
  await ui.wait(() =>
    ui.doc.querySelector('[aria-label="Driver location map"] .driver-map-pin'),
  );
  assert.ok(ui.doc.body.textContent.includes('Last checked:'));
  Object.defineProperty(ui.window.navigator, 'onLine', {
    configurable: true,
    value: false,
  });
  ui.window.dispatchEvent(new ui.window.Event('offline'));
  await ui.wait(() =>
    ui.doc.body.textContent.includes('Offline — showing the last received data'),
  );
  assert.equal(ui.button('Refresh location').disabled, true);
  await f.driver(`/api/shipments/${id}/tracking`, 'POST', {
    latitude: 51.06,
    longitude: -114.08,
    accuracy: 10,
  });
  Object.defineProperty(ui.window.navigator, 'onLine', {
    configurable: true,
    value: true,
  });
  ui.window.dispatchEvent(new ui.window.Event('online'));
  await ui.wait(() => ui.doc.querySelector('a[href*="mlat=51.06&mlon=-114.08"]'));
  assert.ok(
    !ui.doc.body.textContent.includes('Offline — showing the last received data'),
  );
});
