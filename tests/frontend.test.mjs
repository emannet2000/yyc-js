import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
function compile(path, replacements = {}) {
  let source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  for (const [from, to] of Object.entries(replacements))
    source = source
      .replaceAll(`'${from}'`, JSON.stringify(to))
      .replaceAll(`"${from}"`, JSON.stringify(to));
  return 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
}
const apiUrl = compile('../frontend/api.ts');
const { api, ApiError, setCsrf } = await import(apiUrl);
const actionDraftsUrl = compile('../frontend/actionDrafts.ts', {
  '../shared/planning.js': new URL('../shared/planning.js', import.meta.url).href,
});
const uiUrl = compile('../frontend/stores/useUiStore.ts', {
  '../actionDrafts': actionDraftsUrl,
  zustand: new URL('../node_modules/zustand/esm/index.mjs', import.meta.url).href,
});
const offlineUrl = compile('../frontend/offline.ts', {
  './api': apiUrl,
  '../shared/planning.js': new URL('../shared/planning.js', import.meta.url).href,
});
const trackingUrl = compile('../frontend/tracking.ts', {
  zustand: new URL('../node_modules/zustand/esm/index.mjs', import.meta.url).href,
});
const { useAppStore: store } = await import(
  compile('../frontend/stores/useAppStore.ts', {
    '../api': apiUrl,
    '../offline': offlineUrl,
    '../tracking': trackingUrl,
    './useUiStore': uiUrl,
    zustand: new URL('../node_modules/zustand/esm/index.mjs', import.meta.url).href,
  })
);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const workspace = { user: { id: 'store', role: 'store' }, shipments: [], drivers: [] };
const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
});
test.beforeEach(() => {
  store.setState({
    state: null,
    loading: true,
    bootError: '',
    busy: false,
    message: '',
    needsRefresh: false,
    refreshReason: null,
  });
  setCsrf(null);
});
test('API retains HTTP status for HTML, null, empty and JSON errors', async () => {
  for (const response of [
    new Response('<h1>Unauthorized</h1>', { status: 401 }),
    json(null, 500),
    new Response(null, { status: 409 }),
    json({ error: 'Conflict' }, 409),
  ]) {
    const status = response.status;
    globalThis.fetch = async () => response;
    await assert.rejects(
      api('/api/state'),
      (error) => error instanceof ApiError && error.status === status,
    );
  }
});
test('API supports empty success and rejects malformed successful JSON', async () => {
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assert.equal(await api('/api/logout', 'POST', {}), undefined);
  globalThis.fetch = async () => new Response('<html>Oops</html>');
  await assert.rejects(
    api('/api/state'),
    (error) => error instanceof ApiError && error.status === 200,
  );
});
test('API sends CSRF only on mutations', async () => {
  const requests = [];
  globalThis.fetch = async (_path, options) => {
    requests.push(options);
    return json({});
  };
  setCsrf('token');
  await api('/api/state');
  await api('/api/profile', 'PATCH', {});
  assert.equal(requests[0].headers['X-CSRF-Token'], undefined);
  assert.equal(requests[1].headers['X-CSRF-Token'], 'token');
});
test('startup 401 at either session or state returns to login and clears CSRF', async () => {
  for (const atState of [false, true]) {
    store.setState({ state: workspace });
    setCsrf('old');
    globalThis.fetch = async (path) =>
      atState && path === '/api/session'
        ? json({ user: workspace.user, csrf: 'new' })
        : new Response('Expired', { status: 401 });
    await store.getState().boot();
    assert.equal(store.getState().state, null);
    assert.equal(store.getState().bootError, '');
    assert.equal(store.getState().loading, false);
    globalThis.fetch = async (_path, options) => {
      assert.equal(options.headers['X-CSRF-Token'], undefined);
      return json({});
    };
    await api('/api/logout', 'POST', {});
  }
});
test('startup network errors remain retryable', async () => {
  globalThis.fetch = async () => {
    throw new Error('Offline');
  };
  await store.getState().boot();
  assert.equal(store.getState().bootError, 'Offline');
  globalThis.fetch = async () => json({ user: null, csrf: null });
  await store.getState().boot();
  assert.equal(store.getState().bootError, '');
});
test('successful save followed by failed refresh blocks duplicate mutations until refreshed', async () => {
  let writes = 0,
    moved = false;
  store.setState({ state: workspace });
  globalThis.fetch = async (path) => {
    if (path === '/api/state') throw new Error('Offline');
    writes++;
    return json({});
  };
  await store.getState().save(
    () => api('/api/shipments', 'POST', {}),
    'Delivery request saved.',
    () => {
      moved = true;
    },
  );
  assert.equal(writes, 1);
  assert.equal(moved, true);
  assert.equal(store.getState().needsRefresh, true);
  assert.match(store.getState().message, /Your change was saved/);
  await store.getState().act('id', 1, 'cancel');
  assert.equal(writes, 1);
  globalThis.fetch = async () => json(workspace);
  await store.getState().refresh();
  assert.equal(store.getState().needsRefresh, false);
});
test('failed save does not invoke navigation or mark the workspace saved', async () => {
  let moved = false;
  globalThis.fetch = async () => json({ error: 'Invalid cargo' }, 400);
  await store.getState().save(
    () => api('/api/shipments', 'POST', {}),
    'Saved.',
    () => {
      moved = true;
    },
  );
  assert.equal(moved, false);
  assert.equal(store.getState().needsRefresh, false);
  assert.equal(store.getState().message, 'Invalid cargo');
});
test('401 during refresh after save preserves confirmation and clears session', async () => {
  store.setState({ state: workspace });
  globalThis.fetch = async (path) =>
    path === '/api/state' ? json({ error: 'Expired' }, 401) : json({});
  await store.getState().save(() => api('/api/profile', 'PATCH', {}), 'Profile saved.');
  assert.equal(store.getState().state, null);
  assert.match(store.getState().message, /Profile saved/);
});

test('uncertain booking retries reuse their key across reloads; acknowledged repeats use a new key', async () => {
  const stored = new Map();
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key) => stored.get(key) || null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: (key) => stored.delete(key),
    },
  });
  try {
    const bookingUrl = compile('../frontend/booking.ts', { './api': apiUrl });
    const { createBooking } = await import(bookingUrl);
    const keys = [];
    globalThis.fetch = async (_path, options) => {
      keys.push(options.headers['Idempotency-Key']);
      throw new Error('Response lost after commit');
    };
    const payload = { goods: 'Boxes', kg: 900, pallets: 4 };
    await assert.rejects(createBooking('retry-user', payload), /Response lost/);
    // Re-evaluate the module to simulate losing the in-memory map on reload.
    const reloaded = await import(bookingUrl + '#reloaded');
    globalThis.fetch = async (_path, options) => {
      keys.push(options.headers['Idempotency-Key']);
      return json({ id: 'YYC-1' }, 201);
    };
    const result = await reloaded.createBooking('retry-user', {
      pallets: 4,
      kg: 900,
      goods: 'Boxes',
    });
    assert.equal(result.id, 'YYC-1');
    assert.equal(keys[0], keys[1]);
    assert.equal(stored.size, 0);
    await reloaded.createBooking('retry-user', payload);
    assert.notEqual(keys[1], keys[2]);
  } finally {
    if (previousStorage)
      Object.defineProperty(globalThis, 'sessionStorage', previousStorage);
    else delete globalThis.sessionStorage;
  }
});

test('conflict followed by failed refresh blocks more changes until refresh succeeds', async () => {
  let writes = 0;
  store.setState({ state: workspace });
  globalThis.fetch = async (path) => {
    if (path === '/api/state') throw new Error('Offline');
    writes++;
    return json({ error: 'Delivery changed.' }, 409);
  };
  await store.getState().act('id', 1, 'cancel');
  assert.equal(store.getState().needsRefresh, true);
  assert.equal(store.getState().refreshReason, 'conflict');
  assert.match(store.getState().message, /Refresh before making another change/);
  assert.doesNotMatch(store.getState().message, /was saved/);
  await store.getState().act('id', 1, 'cancel');
  assert.equal(writes, 1);
  globalThis.fetch = async () => json(workspace);
  await store.getState().refresh();
  assert.equal(store.getState().needsRefresh, false);
  assert.equal(store.getState().refreshReason, null);
});

test('expired session during conflict recovery returns to login', async () => {
  store.setState({ state: workspace });
  globalThis.fetch = async (path) =>
    path === '/api/state'
      ? json({ error: 'Expired' }, 401)
      : json({ error: 'Conflict' }, 409);
  await store.getState().act('id', 1, 'cancel');
  assert.equal(store.getState().state, null);
  assert.equal(store.getState().needsRefresh, false);
});

test('rendered fields require whole pallets and cent amounts while weights permit fractions', async () => {
  const { Field } = await import(
    compile('../frontend/Field.tsx', {
      'react/jsx-runtime': new URL(
        '../node_modules/react/jsx-runtime.js',
        import.meta.url,
      ).href,
    })
  );
  const pallet = renderToStaticMarkup(
    createElement(Field, { name: 'pallets', label: 'Pallets', type: 'number' }),
  );
  assert.match(pallet, /step="1"/);
  assert.match(pallet, /max="9007199254740991"/);
  assert.match(pallet, /min="1"/);
  for (const name of ['kg', 'price', 'rate']) {
    const html = renderToStaticMarkup(
      createElement(Field, { name, label: name, type: 'number' }),
    );
    assert.match(html, name === 'kg' ? /step="any"/ : /step="0.01"/);
    assert.doesNotMatch(html, /min="1"/);
  }
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('an old refresh cannot restore state after logout, even if it completes during logout', async () => {
  for (const duringLogout of [false, true]) {
    const stale = deferred(),
      logoutResponse = deferred();
    store.setState({ state: workspace, loading: false });
    setCsrf('old-token');
    globalThis.fetch = async (path) =>
      path === '/api/state' ? stale.promise : logoutResponse.promise;
    const refresh = store.getState().refresh();
    const logout = store.getState().logout();
    if (duringLogout) {
      stale.resolve(json({ ...workspace, user: { id: 'stale' } }));
      await refresh;
      assert.equal(store.getState().state.user.id, 'store');
    }
    logoutResponse.resolve(json({}));
    await logout;
    stale.resolve(json(workspace));
    await refresh;
    assert.equal(store.getState().state, null);
  }
});

test('old boot responses cannot restore CSRF or state after logout', async () => {
  const oldSession = deferred();
  globalThis.fetch = async (path) =>
    path === '/api/session' ? oldSession.promise : json({});
  const boot = store.getState().boot();
  await store.getState().logout();
  oldSession.resolve(json({ user: workspace.user, csrf: 'stale-token' }));
  await boot;
  assert.equal(store.getState().state, null);
  assert.equal(store.getState().loading, false);
  globalThis.fetch = async (_path, options) => {
    assert.equal(options.headers['X-CSRF-Token'], undefined);
    return json({});
  };
  await api('/api/logout', 'POST', {});
});

test('responses and failures from an old account cannot overwrite a new login', async () => {
  for (const fail of [false, true]) {
    setCsrf('account-a-token');
    const old = deferred();
    globalThis.fetch = async () => old.promise;
    const previous = store.getState().run(() => store.getState().refresh());
    setCsrf('account-b-token');
    const next = { ...workspace, user: { id: 'account-b', role: 'store' } };
    globalThis.fetch = async () => json(next);
    await store.getState().refresh();
    if (fail) old.reject(new Error('Old connection failed'));
    else old.resolve(json(workspace));
    await previous;
    assert.equal(store.getState().state.user.id, 'account-b');
    assert.equal(store.getState().message, '');
  }
});

test('newer refresh results win when requests complete out of order', async () => {
  const first = deferred();
  globalThis.fetch = async () => first.promise;
  const old = store.getState().refresh();
  const current = { ...workspace, shipments: [{ id: 'latest' }] };
  globalThis.fetch = async () => json(current);
  await store.getState().refresh();
  first.resolve(json(workspace));
  await old;
  assert.equal(store.getState().state.shipments[0].id, 'latest');
});

test('failed logout retains its token and permits retry without accepting stale reads', async () => {
  setCsrf('retry-token');
  store.setState({ state: workspace, loading: false });
  const old = deferred();
  globalThis.fetch = async (path) => {
    if (path === '/api/state') return old.promise;
    throw new Error('Offline');
  };
  const refresh = store.getState().refresh();
  await store.getState().logout();
  old.resolve(json({ ...workspace, user: { id: 'stale' } }));
  await refresh;
  assert.equal(store.getState().state.user.id, 'store');
  assert.match(store.getState().message, /Offline/);
  globalThis.fetch = async (_path, options) => {
    assert.equal(options.headers['X-CSRF-Token'], 'retry-token');
    return json({});
  };
  await store.getState().logout();
  assert.equal(store.getState().state, null);
});

test('evidence drafts are scoped to an account and retained only for active assigned trips', async () => {
  const { useUiStore: ui } = await import(uiUrl);
  ui.getState().syncDeliveryDrafts('driver-a', ['trip-a', 'trip-b']);
  ui.getState().setDeliveryDraft('driver-a', 'trip-a', {
    pod: 'A',
    recipient: 'Staff A',
  });
  ui.getState().setDeliveryDraft('driver-a', 'trip-b', {
    pod: 'B',
    recipient: 'Staff B',
  });
  ui.getState().close();
  ui.getState().syncDeliveryDrafts('driver-a', ['trip-a']);
  assert.deepEqual(ui.getState().deliveryDrafts, {
    'trip-a': { pod: 'A', recipient: 'Staff A' },
  });
  ui.getState().syncDeliveryDrafts('driver-b', ['trip-a']);
  assert.deepEqual(ui.getState().deliveryDrafts, {});
  ui.getState().setDeliveryDraft('driver-b', 'trip-a', {
    pod: 'Private',
    recipient: 'Staff',
  });
  ui.getState().syncDeliveryDrafts(null, []);
  assert.deepEqual(ui.getState().deliveryDrafts, {});
  assert.equal(ui.getState().draftOwner, null);
});

test('action drafts retain eligible fields and clear unavailable actions and account changes', async () => {
  const { useUiStore: ui } = await import(uiUrl);
  const { actionDraftKey } = await import(actionDraftsUrl);
  ui.getState().syncDeliveryDrafts('broker-a', [], []);
  ui.getState().setActionDraft('broker-a', 'trip-a', 'requote', 'price', '500');
  ui.getState().setActionDraft(
    'broker-a',
    'trip-a',
    'handover',
    'reason',
    'Private reason',
  );
  ui.getState().syncDeliveryDrafts('broker-a', [], [actionDraftKey('trip-a', 'requote')]);
  assert.deepEqual(ui.getState().actionDrafts, {
    [actionDraftKey('trip-a', 'requote')]: { price: '500' },
  });
  ui.getState().syncDeliveryDrafts('broker-b', [], [actionDraftKey('trip-a', 'requote')]);
  assert.deepEqual(ui.getState().actionDrafts, {});
  ui.getState().setActionDraft('broker-b', 'trip-a', 'requote', 'price', '600');
  ui.getState().syncDeliveryDrafts(null, []);
  assert.deepEqual(ui.getState().actionDrafts, {});
});

test('refresh adopts the session token paired with its workspace and rejects older reads', async () => {
  store.setState({ state: workspace });
  setCsrf('previous-session');
  const old = deferred();
  globalThis.fetch = async () => old.promise;
  const previous = store.getState().refresh();
  const next = { ...workspace, csrf: 'current-session' };
  globalThis.fetch = async () => json(next);
  await store.getState().refresh();
  old.resolve(json({ ...workspace, csrf: 'previous-session' }));
  await previous;
  globalThis.fetch = async (_path, options) => {
    assert.equal(options.headers['X-CSRF-Token'], 'current-session');
    return json({});
  };
  await api('/api/profile', 'PATCH', {});
});

test('refreshing into another account clears the previous workspace navigation and private drafts', async () => {
  const { useUiStore: ui } = await import(uiUrl);
  store.setState({ state: workspace });
  ui.getState().setPage('accounts');
  ui.getState().select('old-trip');
  ui.getState().setQuery('private search');
  ui.getState().setActionDraft('store', 'old-trip', 'change', 'reason', 'Private reason');
  const next = {
    ...workspace,
    user: { id: 'other-account', role: 'driver' },
    csrf: 'other-token',
  };
  globalThis.fetch = async () => json(next);
  await store.getState().refresh();
  assert.equal(store.getState().state.user.id, 'other-account');
  assert.equal(ui.getState().page, 'dashboard');
  assert.equal(ui.getState().selected, null);
  assert.equal(ui.getState().query, '');
  assert.deepEqual(ui.getState().actionDrafts, {});
});

test('startup finishes when the shared session changes between session lookup and workspace loading', async () => {
  globalThis.fetch = async (path) =>
    path === '/api/session'
      ? json({ user: workspace.user, csrf: 'startup-token' })
      : json({ ...workspace, csrf: 'replacement-token' });
  await store.getState().boot();
  assert.equal(store.getState().loading, false);
  assert.equal(store.getState().state.csrf, 'replacement-token');
  globalThis.fetch = async (_path, options) => {
    assert.equal(options.headers['X-CSRF-Token'], 'replacement-token');
    return json({});
  };
  await api('/api/profile', 'PATCH', {});
});

test('a pending write from the previous session cannot confirm or refresh the new account', async () => {
  store.setState({ state: workspace });
  setCsrf('old-write-session');
  const write = deferred();
  globalThis.fetch = async () => write.promise;
  let confirmed = false;
  const saving = store.getState().save(
    () => api('/api/profile', 'PATCH', {}),
    'Old profile saved.',
    () => {
      confirmed = true;
    },
  );
  const next = {
    ...workspace,
    user: { id: 'new-owner', role: 'store' },
    csrf: 'new-owner-token',
  };
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return json(next);
  };
  await store.getState().refresh();
  write.resolve(json({}));
  await saving;
  assert.equal(confirmed, false);
  assert.equal(requests, 1);
  assert.equal(store.getState().state.user.id, 'new-owner');
  assert.equal(store.getState().message, '');
});

test('background sync preserves identical workspace references, refreshes notifications and flags removed assignments', async () => {
  const initial = {
    ...workspace,
    csrf: 'sync-token',
    user: { id: 'driver-sync', role: 'driver' },
    shipments: [
      { id: 'SYNC-1', driverId: 'driver-sync', status: 'Assigned', version: 1 },
    ],
  };
  setCsrf('sync-token');
  store.setState({
    state: initial,
    assignmentAlert: '',
    syncError: '',
    refreshVersion: 0,
  });
  globalThis.fetch = async () => json(initial);
  await store.getState().sync();
  assert.equal(store.getState().state, initial);
  assert.equal(store.getState().refreshVersion, 1);
  globalThis.fetch = async () => json({ ...initial, shipments: [] });
  await store.getState().sync();
  assert.equal(store.getState().state.shipments.length, 0);
  assert.match(store.getState().assignmentAlert, /SYNC-1/);
});

test('background sync skips mutations and leaves a warning on failure; session expiry clears the workspace', async () => {
  store.setState({ state: workspace, busy: true, syncError: '' });
  globalThis.fetch = async () => {
    throw new Error('Should not fetch during a write');
  };
  await store.getState().sync();
  store.setState({ busy: false });
  globalThis.fetch = async () => json({ error: 'Unavailable' }, 503);
  await store.getState().sync();
  assert.match(store.getState().syncError, /out of date/);
  assert.equal(store.getState().state, workspace);
  globalThis.fetch = async () => json({ error: 'Expired' }, 401);
  await store.getState().sync();
  assert.equal(store.getState().state, null);
});

test('offline milestones keep the same pickup and final-arrival proof scope as the server', async () => {
  const { projectAction } = await import(offlineUrl);
  let job = {
    id: 'delivery',
    version: 1,
    status: 'Assigned',
    driverId: 'driver',
    stops: [{ id: 'stop-1' }],
  };
  function queue(action, queuedAt, data = {}) {
    job = projectAction(job, {
      id: job.id,
      version: job.version,
      requestKey: `pending-${job.version}`,
      action,
      data,
      queuedAt,
    });
  }
  const pickupArrival = '2099-11-05T16:00:00.000Z';
  const pickupTime = '2099-11-05T16:05:00.000Z';
  const finalArrival = '2099-11-05T18:00:00.000Z';
  queue('arrival', pickupArrival);
  queue('pickup', pickupTime);
  assert.equal(job.pickupArrivedAt, pickupArrival);
  assert.equal(job.pickupAt, pickupTime);
  assert.equal(job.pickupVersion, job.version);
  assert.equal(job.pickupDriverId, 'driver');
  queue('attachEvidence', '2099-11-05T17:00:00.000Z');
  assert.equal(job.evidenceCount, 0);
  queue('completeStop', '2099-11-05T17:05:00.000Z', { stopId: 'stop-1' });
  queue('arrival', finalArrival);
  assert.equal(job.arrivedAt, finalArrival);
  assert.equal(job.finalArrivalVersion, job.version);
  queue('attachEvidence', '2099-11-05T18:01:00.000Z');
  assert.equal(job.evidenceCount, 1);
});

test('offline projection keeps invalid milestone actions pending without advancing the delivery', async () => {
  const { projectAction } = await import(offlineUrl);
  const pickup = { id: 'job', version: 1, status: 'Assigned' };
  const inTransit = {
    ...pickup,
    status: 'In transit',
    version: 3,
    stops: [{ id: 'first' }, { id: 'second' }],
  };
  const arrived = { ...inTransit, stops: [], arrivedAt: '2099-11-05T17:00:00.000Z' };
  const returning = { ...inTransit, status: 'Returning' };
  for (const [shipment, action, data] of [
    [pickup, 'pickup', {}],
    [inTransit, 'arrival', {}],
    [inTransit, 'completeStop', { stopId: 'second' }],
    [arrived, 'deliver', { pod: 'REFERENCE', recipient: 'Staff' }],
    [returning, 'confirmReturn', { pod: 'REFERENCE', recipient: 'Staff' }],
  ]) {
    assert.equal(
      projectAction(shipment, {
        id: shipment.id,
        version: shipment.version,
        requestKey: 'offline-test-key',
        action,
        data,
        queuedAt: '2099-11-05T17:05:00.000Z',
      }),
      shipment,
    );
  }
});
