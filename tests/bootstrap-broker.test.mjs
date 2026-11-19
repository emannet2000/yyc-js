import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApplication } from '../server/app.js';
import { ensureBootstrapBroker } from '../server/bootstrap-broker.js';

const env = {
  ADMIN_EMAIL: 'first.broker@example.com',
  ADMIN_PASSWORD: 'Bootstrap-Broker-2026',
  ADMIN_NAME: 'First Broker',
  ADMIN_PHONE: '403-555-0199',
};

test('does nothing when ADMIN_* settings are absent', async (t) => {
  const app = createApplication({ databasePath: ':memory:' });
  t.after(() => app.close());
  assert.deepEqual(await ensureBootstrapBroker(app, {}), {
    created: false,
    reason: 'not-configured',
  });
  assert.equal(app.hasBroker(), false);
});

test('creates the first broker from ADMIN_* settings', async (t) => {
  const app = createApplication({ databasePath: ':memory:' });
  t.after(() => app.close());
  assert.deepEqual(await ensureBootstrapBroker(app, env), { created: true });
  assert.equal(app.hasBroker(), true);
});

test('ignores ADMIN_* settings once a broker exists', async (t) => {
  const app = createApplication({ databasePath: ':memory:' });
  t.after(() => app.close());
  await ensureBootstrapBroker(app, env);
  const again = await ensureBootstrapBroker(app, {
    ...env,
    ADMIN_EMAIL: 'second@example.com',
  });
  assert.deepEqual(again, { created: false, reason: 'broker-exists' });
});

test('rejects half-configured settings', async (t) => {
  const app = createApplication({ databasePath: ':memory:' });
  t.after(() => app.close());
  await assert.rejects(
    ensureBootstrapBroker(app, { ADMIN_EMAIL: 'only@example.com' }),
    /ADMIN_EMAIL and ADMIN_PASSWORD must both be set/,
  );
  assert.equal(app.hasBroker(), false);
});

test('rejects a password that fails the account password policy', async (t) => {
  const app = createApplication({ databasePath: ':memory:' });
  t.after(() => app.close());
  await assert.rejects(ensureBootstrapBroker(app, { ...env, ADMIN_PASSWORD: 'short' }));
  assert.equal(app.hasBroker(), false);
});
