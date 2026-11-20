import test from 'node:test';
import assert from 'node:assert/strict';
import { createShipmentLimiter } from '../server/shipment-limiter.js';

test('allows 50 shipments per user then blocks', () => {
  const limiter = createShipmentLimiter();
  for (let i = 0; i < 50; i++) assert.ok(limiter.check('store1'), `attempt ${i + 1} should pass`);
  assert.equal(limiter.check('store1'), false, '51st attempt should be blocked');
});

test('other users are not affected by one user hitting the limit', () => {
  const limiter = createShipmentLimiter();
  for (let i = 0; i < 20; i++) limiter.check('store1');
  assert.ok(limiter.check('store2'), 'store2 should still be allowed');
});

test('limit resets after the window expires', () => {
  let time = 0;
  const limiter = createShipmentLimiter({ now: () => time });
  for (let i = 0; i < 50; i++) limiter.check('store1');
  assert.equal(limiter.check('store1'), false);
  time = 10 * 60_000 + 1;
  assert.ok(limiter.check('store1'), 'should be allowed after window expires');
});
