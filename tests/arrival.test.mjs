import test from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceMetres,
  arrivalTarget,
  arrivalSuggestion,
  targetAddress,
  targetLabel,
} from '../server/arrival.js';

const here = { latitude: 51.0447, longitude: -114.0719 };
const metresNorth = (m) => ({
  latitude: here.latitude + m / 111320,
  longitude: here.longitude,
});
const now = Date.parse('2026-11-19T12:00:00.000Z');
const sample = (over = {}) => ({
  ...here,
  accuracy: 12,
  driverId: 'driver-1',
  recordedAt: new Date(now - 10000).toISOString(),
  ...over,
});

test('distance between two points is close to the true value', () => {
  const d = distanceMetres(here, metresNorth(1000));
  assert.ok(Math.abs(d - 1000) < 5, `got ${d}`);
  assert.equal(distanceMetres(here, here), 0);
});

test('pickup is the target while assigned and not yet arrived', () => {
  assert.equal(arrivalTarget({ status: 'Assigned' }), 'pickup');
  assert.equal(arrivalTarget({ status: 'Assigned', arrivedAt: 'x' }), null);
});

test('destination is the target in transit once every stop is complete', () => {
  assert.equal(
    arrivalTarget({ status: 'In transit', stops: [{ completedAt: 'x' }] }),
    'destination',
  );
  assert.equal(
    arrivalTarget({ status: 'In transit', stops: [{ id: 'a', completedAt: 'x' }] }),
    'destination',
  );
});

test('no target for offered, delivered or failed jobs', () => {
  assert.equal(arrivalTarget({ status: 'Offered' }), null);
  assert.equal(arrivalTarget({ status: 'Delivered' }), null);
  assert.equal(arrivalTarget({ status: 'Delivery failed' }), null);
});

test('a close, accurate, recent sample prompts arrival with the distance', () => {
  const s = arrivalSuggestion({
    target: 'pickup',
    point: metresNorth(100),
    sample: sample(),
    driverId: 'driver-1',
    now,
  });
  assert.deepEqual(s, {
    target: 'pickup',
    kind: 'arrival',
    label: 'pickup location',
    distanceM: 100,
  });
});

test('no prompt when the driver is outside the radius', () => {
  assert.equal(
    arrivalSuggestion({
      target: 'destination',
      point: metresNorth(400),
      sample: sample(),
      driverId: 'driver-1',
      now,
    }),
    null,
  );
});

test('no prompt for poor accuracy, stale samples, other drivers or missing targets', () => {
  const point = metresNorth(50);
  const base = { target: 'pickup', point, driverId: 'driver-1', now };
  assert.equal(arrivalSuggestion({ ...base, sample: sample({ accuracy: 80 }) }), null);
  assert.equal(
    arrivalSuggestion({
      ...base,
      sample: sample({ recordedAt: new Date(now - 3 * 60000).toISOString() }),
    }),
    null,
  );
  assert.equal(
    arrivalSuggestion({ ...base, sample: sample({ driverId: 'other' }) }),
    null,
  );
  assert.equal(arrivalSuggestion({ ...base, target: null, sample: sample() }), null);
  assert.equal(arrivalSuggestion({ ...base, point: null, sample: sample() }), null);
});

test('the next uncompleted intermediate stop is the target before the destination', () => {
  const stops = [
    { id: 'a', address: 'First store', completedAt: 'x' },
    { id: 'b', address: 'Second store' },
    { id: 'c', address: 'Third store' },
  ];
  assert.equal(arrivalTarget({ status: 'In transit', stops }), 'stop:b');
  assert.equal(targetAddress({ status: 'In transit', stops }, 'stop:b'), 'Second store');
  assert.equal(targetLabel({ status: 'In transit', stops }, 'stop:b'), 'stop 2');
});

test('a stop prompt is reported as a stop, not an arrival', () => {
  const s = arrivalSuggestion({
    target: 'stop:b',
    label: 'stop 2',
    point: metresNorth(20),
    sample: sample(),
    driverId: 'driver-1',
    now,
  });
  assert.deepEqual(s, { target: 'stop:b', kind: 'stop', label: 'stop 2', distanceM: 20 });
});
