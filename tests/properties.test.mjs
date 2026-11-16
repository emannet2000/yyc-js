import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { isPositiveMoney } from '../shared/money.js';
import { windowsOverlap, driverAvailable, canTakeCargo } from '../shared/scheduling.js';
import { createLoginLimiter } from '../server/login-limiter.js';
import { createRegistrationLimiter } from '../server/registration-limiter.js';

const seed = Number(process.env.FC_SEED ?? 0x5eed2026);
const numRuns = Number(process.env.FC_RUNS ?? 500);
assert.ok(
  Number.isInteger(seed) && seed >= -2147483648 && seed <= 2147483647,
  'FC_SEED must be a signed 32-bit integer.',
);
assert.ok(
  Number.isInteger(numRuns) && numRuns > 0,
  'FC_RUNS must be a positive integer.',
);
const check = (property) => fc.assert(property, { seed, numRuns, verbose: true });

// Keep generated monetary inputs within a range where each cent is representable
// distinctly, rather than promising arbitrary-precision arithmetic from doubles.
test('property: positive cent amounts round-trip without changing their value', () => {
  check(
    fc.property(fc.integer({ min: 1, max: 1_000_000_000_000 }), (cents) => {
      const value = cents / 100;
      assert.equal(isPositiveMoney(value), true);
      assert.equal(Number(value.toFixed(2)), value);
    }),
  );
});

test('property: nonzero fractions of a cent are rejected', () => {
  check(
    fc.property(
      fc.integer({ min: 0, max: 100_000_000 }),
      fc.integer({ min: 1, max: 9 }),
      (cents, fraction) => {
        assert.equal(isPositiveMoney((cents * 10 + fraction) / 1000), false);
      },
    ),
  );
});

test('property: accepted arbitrary inputs are finite positive numbers with at most two decimal places', () => {
  check(
    fc.property(fc.oneof(fc.double(), fc.anything()), (value) => {
      if (!isPositiveMoney(value)) return;
      assert.equal(typeof value, 'number');
      assert.ok(Number.isFinite(value) && value >= 0.01);
      assert.match(String(value), /^\d+(?:\.\d{1,2})?$/);
    }),
  );
});

const morning = '09:00–12:00',
  afternoon = '13:00–16:00';
const knownWindow = fc.constantFrom(morning, afternoon, 'Flexible');
const unknownWindow = fc.oneof(
  fc.constantFrom('', 'constructor', '__proto__', 'toString', 'hasOwnProperty'),
  fc.string().filter((value) => ![morning, afternoon, 'Flexible'].includes(value)),
);
const anyWindow = fc.oneof(knownWindow, unknownWindow);
const separated = (a, b) =>
  (a === morning && b === afternoon) || (a === afternoon && b === morning);

test('property: window conflicts are symmetric and only morning/afternoon are disjoint', () => {
  check(
    fc.property(anyWindow, anyWindow, (a, b) => {
      assert.equal(windowsOverlap(a, b), windowsOverlap(b, a));
      assert.equal(windowsOverlap(a, b), !separated(a, b));
      assert.equal(windowsOverlap(a, a), true);
    }),
  );
});

test('property: unrecognized windows conservatively conflict with every known window', () => {
  check(
    fc.property(unknownWindow, knownWindow, (unknown, known) => {
      assert.equal(windowsOverlap(unknown, known), true);
      assert.equal(windowsOverlap(known, unknown), true);
    }),
  );
});

const identity = fc.constantFrom('a', 'b', 'c');
const date = fc.constantFrom('2099-01-01', '2099-01-02', '2099-01-03');
const candidate = fc.record({ id: identity, date, window: anyWindow });
const shipment = fc.record({
  id: identity,
  date,
  window: anyWindow,
  status: fc.constantFrom(
    'Awaiting quote',
    'Quote ready',
    'Ready to assign',
    'Offered',
    'Assigned',
    'In transit',
    'Delivered',
    'Cancelled',
  ),
  driverId: fc.option(identity, { nil: null }),
  offeredTo: fc.option(identity, { nil: null }),
});

test('property: availability matches reservations for the same driver, date, and conflicting window', () => {
  check(
    fc.property(
      candidate,
      fc.array(shipment, { maxLength: 50 }),
      identity,
      (booking, jobs, driver) => {
        const reservations = jobs.filter(
          (job) =>
            job.id !== booking.id &&
            job.date === booking.date &&
            ['Offered', 'Assigned', 'In transit'].includes(job.status) &&
            (job.driverId === driver || job.offeredTo === driver),
        );
        const expected = reservations.every((job) =>
          separated(job.window, booking.window),
        );
        assert.equal(driverAvailable(booking, jobs, driver), expected);
        assert.equal(driverAvailable(booking, [...jobs].reverse(), driver), expected);
      },
    ),
  );
});

test('property: adding unrelated or terminal jobs cannot change availability', () => {
  check(
    fc.property(
      candidate,
      fc.array(shipment, { maxLength: 30 }),
      identity,
      shipment,
      (booking, jobs, driver, extra) => {
        const before = driverAvailable(booking, jobs, driver);
        for (const irrelevant of [
          { ...extra, id: booking.id },
          { ...extra, status: 'Delivered' },
          { ...extra, status: 'Cancelled' },
          { ...extra, driverId: 'unrelated-driver', offeredTo: null },
          { ...extra, date: '2100-12-31' },
        ])
          assert.equal(driverAvailable(booking, [...jobs, irrelevant], driver), before);
      },
    ),
  );
});

const windowMs = 15 * 60_000;
const elapsed = fc.oneof(
  fc.constantFrom(0, 1, windowMs - 1, windowMs, windowMs + 1),
  fc.integer({ min: 0, max: windowMs * 2 }),
);
const loginCommand = fc.oneof(
  fc.record({
    kind: fc.constant('reserve'),
    address: identity,
    email: identity,
    count: fc.integer({ min: 1, max: 25 }),
  }),
  fc.record({ kind: fc.constant('success'), address: identity, email: identity }),
  fc.record({ kind: fc.constant('advance'), elapsed }),
);

test('property: login attempt sequences obey account isolation, reset, and expiration', () => {
  check(
    fc.property(fc.array(loginCommand, { minLength: 1, maxLength: 60 }), (commands) => {
      let time = 0;
      const limiter = createLoginLimiter({ now: () => time });
      const model = new Map(),
        tokens = new Map();
      for (const command of commands) {
        if (command.kind === 'advance') {
          time += command.elapsed;
          continue;
        }
        const pair = `${command.address}:${command.email}`;
        if (command.kind === 'success') {
          if (tokens.has(pair)) {
            limiter.succeed(tokens.get(pair));
            model.delete(pair);
          }
          continue;
        }
        for (let attempt = 0; attempt < command.count; attempt++) {
          let record = model.get(pair);
          if (!record || time >= record.expires)
            record = { count: 0, expires: time + windowMs };
          const accepted = record.count < 20;
          const token = limiter.reserve(command.address, command.email);
          assert.equal(token !== null, accepted);
          if (accepted) {
            record.count++;
            model.set(pair, record);
            tokens.set(pair, token);
          }
        }
      }
    }),
  );
});

const registrationCommand = fc.oneof(
  fc.record({
    kind: fc.constant('reserve'),
    address: identity,
    count: fc.integer({ min: 1, max: 6 }),
  }),
  fc.record({
    kind: fc.constant('release'),
    index: fc.nat({ max: 100 }),
    twice: fc.boolean(),
  }),
  fc.record({ kind: fc.constant('advance'), elapsed }),
);

test('property: registration sequences preserve capacity and rate limits across duplicate releases and expiry', () => {
  check(
    fc.property(
      fc.array(registrationCommand, { minLength: 1, maxLength: 100 }),
      (commands) => {
        let time = 0,
          active = 0;
        const limiter = createRegistrationLimiter({ now: () => time });
        const records = new Map(),
          handles = [];
        for (const command of commands) {
          if (command.kind === 'advance') {
            time += command.elapsed;
            continue;
          }
          if (command.kind === 'release') {
            if (!handles.length) continue;
            const handle = handles[command.index % handles.length];
            handle.release();
            if (command.twice) handle.release();
            if (handle.active) {
              active--;
              handle.active = false;
            }
            continue;
          }
          for (let attempt = 0; attempt < command.count; attempt++) {
            let record = records.get(command.address);
            if (!record || time >= record.expires)
              record = { count: 0, expires: time + windowMs };
            const accepted = active < 4 && record.count < 20;
            const release = limiter.reserve(command.address);
            assert.equal(typeof release === 'function', accepted);
            if (accepted) {
              record.count++;
              records.set(command.address, record);
              active++;
              handles.push({ release, active: true });
            }
            assert.ok(active >= 0 && active <= 4);
          }
        }
      },
    ),
  );
});

test('property: live cargo and pending transfers block pickup regardless of appointment dates or windows', () => {
  check(
    fc.property(
      candidate,
      fc.array(shipment, { maxLength: 50 }),
      identity,
      (booking, jobs, driver) => {
        const expected = !jobs.some(
          (job) =>
            job.id !== booking.id &&
            job.status === 'In transit' &&
            (job.driverId === driver || job.offeredTo === driver),
        );
        assert.equal(canTakeCargo(booking.id, jobs, driver), expected);
        assert.equal(
          canTakeCargo(
            booking.id,
            jobs
              .map((job) => ({ ...job, date: booking.date, window: booking.window }))
              .reverse(),
            driver,
          ),
          expected,
        );
      },
    ),
  );
});

test('property: planned loading and travel buffers reserve time across midnight', () => {
  check(
    fc.property(
      fc.integer({ min: 1, max: 10080 }),
      fc.integer({ min: 0, max: 10080 }),
      (duration, buffer) => {
        const first = {
          id: 'first',
          date: '2099-01-01',
          window: '13:00–16:00',
          status: 'Assigned',
          driverId: 'driver',
          estimatedMinutes: duration,
          travelBufferMinutes: buffer,
        };
        const next = { id: 'next', date: '2099-01-02', window: '09:00–12:00' };
        const expectedEnd = 13 * 60 + Math.max(180, duration) + buffer;
        assert.equal(
          driverAvailable(next, [first], 'driver'),
          expectedEnd <= 24 * 60 + 9 * 60,
        );
        for (const status of ['In transit', 'Delivery failed', 'Returning'])
          assert.equal(canTakeCargo(next.id, [{ ...first, status }], 'driver'), false);
        for (const status of ['Delivered', 'Returned', 'Cancelled'])
          assert.equal(canTakeCargo(next.id, [{ ...first, status }], 'driver'), true);
      },
    ),
  );
});
