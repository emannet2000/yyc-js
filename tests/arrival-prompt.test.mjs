import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, booking, action } from './helpers/app.mjs';

const pickup = { latitude: 51.0447, longitude: -114.0719 };
const far = { latitude: 51.0447 + 1000 / 111320, longitude: -114.0719 };

async function assigned(t, options) {
  const f = await setup(t, options);
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  const id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  await action(f.admin, id, 'quote', { price: 450, rate: 300 });
  await action(f.store, id, 'acceptQuote');
  await action(f.admin, id, 'offer', { driverId: f.driverId });
  await action(f.driver, id, 'acceptJob');
  return { ...f, id };
}

const sendAt = (f, id, point, accuracy = 10) =>
  f.driver(`/api/shipments/${id}/tracking`, 'POST', {
    ...point,
    accuracy,
    recordedAt: new Date().toISOString(),
  });

// Background geocoding runs after the sample is saved, so wait for the prompt.
async function promptOf(f, id, ms = 3000) {
  const deadline = Date.now() + ms;
  let prompt = null;
  while (Date.now() < deadline) {
    prompt = (await f.driver(`/api/shipments/${id}/tracking`)).value.arrivalPrompt;
    if (prompt) return prompt;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return prompt;
}

test('a driver at the pickup is prompted to record arrival', async (t) => {
  const f = await assigned(t, { geocode: async () => pickup });
  assert.equal((await sendAt(f, f.id, pickup)).status, 200);
  const prompt = await promptOf(f, f.id);
  assert.deepEqual(prompt, {
    target: 'pickup',
    kind: 'arrival',
    label: 'pickup location',
    distanceM: 0,
  });
});

test('a driver one kilometre away is not prompted', async (t) => {
  const f = await assigned(t, { geocode: async () => pickup });
  await sendAt(f, f.id, far);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    (await f.driver(`/api/shipments/${f.id}/tracking`)).value.arrivalPrompt,
    null,
  );
});

test('without a geocoder there is no prompt and nothing else changes', async (t) => {
  const f = await assigned(t);
  await sendAt(f, f.id, pickup);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const value = (await f.driver(`/api/shipments/${f.id}/tracking`)).value;
  assert.equal(value.arrivalPrompt, null);
  assert.equal(value.latitude, pickup.latitude);
});

test('a failing geocoder does not block location updates', async (t) => {
  const f = await assigned(t, {
    geocode: async () => {
      throw new Error('Geocoding unavailable.');
    },
  });
  const res = await sendAt(f, f.id, pickup);
  assert.equal(res.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    (await f.driver(`/api/shipments/${f.id}/tracking`)).value.arrivalPrompt,
    null,
  );
});
