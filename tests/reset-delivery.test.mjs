import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredResetDelivery } from '../server/reset-delivery.js';

test('recovery delivery requires explicit HTTPS configuration and a credential', () => {
  assert.equal(configuredResetDelivery({}), null);
  assert.throws(
    () =>
      configuredResetDelivery({
        RESET_DELIVERY_URL: 'http://delivery.example',
        RESET_DELIVERY_TOKEN: 'test',
      }),
    /HTTPS/,
  );
  assert.throws(
    () => configuredResetDelivery({ RESET_DELIVERY_URL: 'https://delivery.example' }),
    /TOKEN/,
  );
});

test('configured delivery sends the intended payload with a deadline and refuses failure responses', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return new Response('{}', { status: requests.length === 1 ? 200 : 503 });
  });
  const deliver = configuredResetDelivery({
    RESET_DELIVERY_URL: 'https://delivery.example/reset',
    RESET_DELIVERY_TOKEN: 'test-delivery-credential',
  });
  const message = {
    email: 'fake@example.com',
    resetUrl: 'https://workspace.example/react/?reset=1#token=fake',
    expiresAt: 123,
  };
  await deliver(message);
  assert.equal(requests[0].url.href, 'https://delivery.example/reset');
  assert.equal(
    requests[0].options.headers.Authorization,
    'Bearer test-delivery-credential',
  );
  assert.equal(requests[0].options.redirect, 'error');
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(requests[0].options.body), message);
  await assert.rejects(deliver(message), /delivery failed/);
});
