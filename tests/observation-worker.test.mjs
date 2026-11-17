import test from 'node:test';
import assert from 'node:assert/strict';
import { startObservationWorker } from '../server/observation-worker.js';
import { setup } from './helpers/app.mjs';

function scheduler() {
  const state = { unreferenced: false, cancelled: false };
  state.timer = { unref() { state.unreferenced = true; } };
  state.schedule = (tick, delay) => {
    state.tick = tick;
    state.delay = delay;
    return state.timer;
  };
  state.cancel = (timer) => {
    assert.equal(timer, state.timer);
    state.cancelled = true;
  };
  return state;
}

test('scheduled snapshots persist at startup and on ticks, and stop before database closure', async (t) => {
  const f = await setup(t);
  const clock = scheduler();
  const stop = startObservationWorker({ sample: f.app.sampleObservations, ...clock });
  t.after(stop);
  assert.equal(clock.delay, 60000);
  assert.equal(clock.unreferenced, true);
  assert.equal((await f.admin('/api/sysadmin/observations')).value.observations.length, 1);
  clock.tick();
  assert.equal((await f.admin('/api/sysadmin/observations')).value.observations.length, 2);
  stop();
  assert.equal(clock.cancelled, true);
  await f.stop();
  assert.doesNotThrow(clock.tick);
});

test('sampling failures are reported safely and later ticks retry', () => {
  const clock = scheduler();
  let attempts = 0, errors = 0;
  const stop = startObservationWorker({
    ...clock,
    intervalMs: 5000,
    sample() { if (++attempts === 1) throw new Error('sensitive database detail'); },
    onError(...args) { assert.deepEqual(args, []); errors++; },
  });
  assert.equal(errors, 1);
  clock.tick();
  assert.equal(attempts, 2);
  assert.equal(errors, 1);
  assert.equal(clock.delay, 5000);
  stop();
});

test('invalid sampling intervals fail before collecting or scheduling', () => {
  for (const intervalMs of [0, -1, 999, 1000.5, NaN, Infinity, 2147483648]) {
    assert.throws(() => startObservationWorker({
      intervalMs,
      sample() { assert.fail('must not collect'); },
      schedule() { assert.fail('must not schedule'); },
    }), /Metrics sample interval/);
  }
});
