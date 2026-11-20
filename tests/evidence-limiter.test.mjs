import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceLimiter } from '../server/evidence-limiter.js';

test('allows 30 uploads per user then blocks', () => {
  const limiter = createEvidenceLimiter();
  for (let i = 0; i < 30; i++) assert.ok(limiter.check('user1'), `attempt ${i + 1} should pass`);
  assert.equal(limiter.check('user1'), false, '31st attempt should be blocked');
});

test('other users are not affected by one user hitting the limit', () => {
  const limiter = createEvidenceLimiter();
  for (let i = 0; i < 10; i++) limiter.check('user1');
  assert.ok(limiter.check('user2'), 'user2 should still be allowed');
});

test('limit resets after the window expires', () => {
  let time = 0;
  const limiter = createEvidenceLimiter({ now: () => time });
  for (let i = 0; i < 30; i++) limiter.check('user1');
  assert.equal(limiter.check('user1'), false);
  time = 5 * 60_000 + 1;
  assert.ok(limiter.check('user1'), 'should be allowed after window expires');
});
