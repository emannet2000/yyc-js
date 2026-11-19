import test from 'node:test';
import assert from 'node:assert/strict';
import { driverVehicleBlockers } from '../shared/scheduling.js';
import { setup } from './helpers/app.mjs';

const shipment = {
  type: 'Box truck',
  kg: 500,
  pallets: 2,
  unloading: '',
  date: '2099-11-05',
};
const driver = (unavailableDates) => ({
  role: 'driver',
  approved: true,
  truck: {
    approved: true,
    type: 'Box truck',
    kg: 1000,
    pallets: 4,
    liftgate: false,
    unavailableDates,
  },
});

test('a driver marked unavailable on the pickup date is blocked from that job', () => {
  assert.deepEqual(driverVehicleBlockers(shipment, driver(['2099-11-05'])), [
    'Unavailable on pickup date',
  ]);
});

test('other days do not block the driver', () => {
  assert.deepEqual(driverVehicleBlockers(shipment, driver(['2099-11-06'])), []);
});

test('drivers save unavailable days sorted and without duplicates', async (t) => {
  const f = await setup(t);
  const res = await f.driver('/api/availability', 'PATCH', {
    dates: ['2099-11-09', '2099-11-05', '2099-11-09'],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.value.unavailableDates, ['2099-11-05', '2099-11-09']);
  const state = (await f.driver('/api/state')).value;
  assert.deepEqual(state.user.truck.unavailableDates, ['2099-11-05', '2099-11-09']);
});

test('availability rejects bad dates and non-drivers', async (t) => {
  const f = await setup(t);
  assert.equal(
    (await f.driver('/api/availability', 'PATCH', { dates: ['05/11/2099'] })).status,
    400,
  );
  assert.equal(
    (await f.driver('/api/availability', 'PATCH', { dates: 'x' })).status,
    400,
  );
  assert.equal(
    (await f.store('/api/availability', 'PATCH', { dates: ['2099-11-05'] })).status,
    403,
  );
});
