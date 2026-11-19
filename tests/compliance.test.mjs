import test from 'node:test';
import assert from 'node:assert/strict';
import { driverVehicleBlockers } from '../shared/scheduling.js';
import { setup, registration } from './helpers/app.mjs';

const shipment = {
  type: 'Box truck',
  kg: 500,
  pallets: 2,
  unloading: '',
  date: '2026-12-03',
};
const driver = (over = {}) => ({
  role: 'driver',
  approved: true,
  truck: {
    approved: true,
    type: 'Box truck',
    kg: 1000,
    pallets: 4,
    liftgate: false,
    ...over,
  },
});

test('a document that expires before pickup blocks the job, naming the document', () => {
  const reasons = driverVehicleBlockers(
    shipment,
    driver({ insuranceExpires: '2026-11-30' }),
  );
  assert.deepEqual(reasons, ['Insurance expired before pickup']);
});

test('documents valid on or after the pickup date do not block', () => {
  const reasons = driverVehicleBlockers(
    shipment,
    driver({
      licenceExpires: '2027-01-01',
      insuranceExpires: '2026-12-03',
      inspectionExpires: '2026-12-02',
    }),
  );
  assert.deepEqual(reasons, ['Inspection expired before pickup']);
});

test('missing compliance dates do not block older registrations', () => {
  assert.deepEqual(driverVehicleBlockers(shipment, driver()), []);
});

test('several expired documents are all reported', () => {
  const reasons = driverVehicleBlockers(
    shipment,
    driver({ licenceExpires: '2020-01-01', inspectionExpires: '2020-01-01' }),
  );
  assert.deepEqual(reasons, [
    'Licence expired before pickup',
    'Inspection expired before pickup',
  ]);
});

test('registration rejects compliance dates that are not YYYY-MM-DD', async (t) => {
  const f = await setup(t);
  const body = {
    ...registration('driver', 'bad-date@example.com'),
    licenceExpires: '03/12/2027',
  };
  const res = await f.client()('/api/register', 'POST', body);
  assert.equal(res.status, 400);
  assert.match(res.value.error, /YYYY-MM-DD/);
});

test('registration accepts valid compliance dates', async (t) => {
  const f = await setup(t);
  const body = {
    ...registration('driver', 'good-date@example.com'),
    licenceExpires: '2028-06-30',
    insuranceExpires: '',
  };
  const res = await f.client()('/api/register', 'POST', body);
  assert.equal(res.status, 201);
});
