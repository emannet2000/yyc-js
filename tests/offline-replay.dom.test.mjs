import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, booking, action } from './helpers/app.mjs';
import { renderApp } from './helpers/dom.mjs';

test('lost decline response syncs after access disappears instead of blocking the offline queue', async (t) => {
  const f = await setup(t);
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  const id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  await action(f.admin, id, 'quote', { price: 450, rate: 300 });
  await action(f.store, id, 'acceptQuote');
  await action(f.admin, id, 'offer', { driverId: f.driverId });
  const ui = await renderApp(t, f.driver);
  const offers = () =>
    [...ui.doc.querySelectorAll('nav button')].find((button) =>
      button.textContent.endsWith('Job offers'),
    );
  await ui.wait(() => offers());
  offers().click();
  await ui.drawer();
  const fetch = ui.window.fetch;
  let dropped = false;
  ui.window.fetch = async (path, options = {}) => {
    const reply = await fetch(path, options);
    if (
      !dropped &&
      path.endsWith('/actions') &&
      JSON.parse(options.body || '{}').action === 'decline'
    ) {
      dropped = true;
      throw new ui.window.TypeError('Lost response after commit');
    }
    return reply;
  };
  ui.button('Decline offer').click();
  await ui.wait(() =>
    ui.doc.body.textContent.includes('1 action(s) awaiting server confirmation'),
  );
  await ui.wait(
    () => ui.button('Sync saved actions') && !ui.button('Sync saved actions').disabled,
  );
  assert.equal((await f.driver('/api/state')).value.shipments.length, 0);
  ui.window.fetch = fetch;
  ui.button('Sync saved actions').click();
  await ui.wait(() =>
    ui.doc.body.textContent.includes('All saved driver actions synced.'),
  );
  assert.deepEqual(
    JSON.parse(ui.window.localStorage.getItem(`yyc-offline-actions:${f.driverId}`)),
    [],
  );
  const s = (await f.admin('/api/state')).value.shipments[0];
  assert.equal(
    s.history.filter((event) => event.text === 'Job offer declined').length,
    1,
  );
});
