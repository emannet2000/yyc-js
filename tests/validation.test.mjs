import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistrationLimiter } from '../server/registration-limiter.js';
import { isPositiveMoney } from '../shared/money.js';

test('money accepts exact positive cents and rejects invalid, unsafe, or hidden fractions', () => {
  for (const value of [0.01, 0.07, 0.29, 1, 19.99, 450.5])
    assert.equal(isPositiveMoney(value), true, String(value));
  for (const value of [
    0,
    -1,
    0.001,
    1.005,
    10.999,
    0.1 + 0.2,
    Infinity,
    NaN,
    1e20,
    '1.00',
    null,
  ])
    assert.equal(isPositiveMoney(value), false, String(value));
});

test('registration capacity is released once and rate limits expire', () => {
  let time = 0;
  const limiter = createRegistrationLimiter({ now: () => time });
  const releases = Array.from({ length: 4 }, (_, i) => limiter.reserve(`ip-${i}`));
  assert.ok(releases.every(Boolean));
  assert.equal(limiter.reserve('another-ip'), null);
  releases[0]();
  releases[0]();
  const replacement = limiter.reserve('another-ip');
  assert.ok(replacement);
  assert.equal(limiter.reserve('extra-ip'), null);
  replacement();
  for (const release of releases) release();
  for (let i = 0; i < 20; i++) {
    const release = limiter.reserve('rate-limited');
    assert.ok(release);
    release();
  }
  assert.equal(limiter.reserve('rate-limited'), null);
  time = 15 * 60_000;
  assert.ok(limiter.reserve('rate-limited'));
});
