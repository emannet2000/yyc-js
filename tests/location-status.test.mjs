import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = ts.transpileModule(
  readFileSync(new URL('../frontend/locationStatus.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 } },
).outputText;
const { locationStatus, LOCATION_FRESH_MS } = await import(
  `data:text/javascript,${encodeURIComponent(source)}`
);

const now = Date.parse('2026-11-19T12:00:00.000Z');
const at = (msAgo) => new Date(now - msAgo).toISOString();
const point = (over = {}) => ({
  latitude: 51.04,
  longitude: -114.07,
  accuracy: 12,
  driverId: 'driver-1',
  recordedAt: at(30_000),
  ...over,
});

test('no point yet reports none with a clear message', () => {
  const s = locationStatus(null, 'driver-1', now);
  assert.equal(s.state, 'none');
  assert.match(s.message, /No location has been shared/);
});

test('coordinates without latitude are still treated as none', () => {
  assert.equal(locationStatus({ driverId: 'driver-1' }, 'driver-1', now).state, 'none');
});

test('a point from a previous driver is hidden', () => {
  const s = locationStatus(point({ driverId: 'old' }), 'driver-1', now);
  assert.equal(s.state, 'previous-driver');
});

test('a fresh point is live with its age', () => {
  const s = locationStatus(point({ recordedAt: at(3 * 60_000) }), 'driver-1', now);
  assert.equal(s.state, 'live');
  assert.equal(s.ageMinutes, 3);
  assert.equal(s.message, 'Updated 3 min ago');
});

test('a point under a minute old says less than a minute', () => {
  const s = locationStatus(point(), 'driver-1', now);
  assert.equal(s.state, 'live');
  assert.equal(s.message, 'Updated less than a minute ago');
});

test('a point older than the freshness window is stale', () => {
  const s = locationStatus(
    point({ recordedAt: at(LOCATION_FRESH_MS + 60_000) }),
    'driver-1',
    now,
  );
  assert.equal(s.state, 'stale');
  assert.equal(s.ageMinutes, 6);
  assert.match(s.message, /may have stopped sharing/);
});

test('exactly at the window boundary is stale', () => {
  const s = locationStatus(point({ recordedAt: at(LOCATION_FRESH_MS) }), 'driver-1', now);
  assert.equal(s.state, 'stale');
});

test('a point with an unparseable time is stale, not live', () => {
  const s = locationStatus(point({ recordedAt: 'not a date' }), 'driver-1', now);
  assert.equal(s.state, 'stale');
  assert.equal(s.ageMinutes, null);
});

test('clock skew into the future counts as live with age zero', () => {
  const s = locationStatus(point({ recordedAt: at(-5_000) }), 'driver-1', now);
  assert.equal(s.state, 'live');
  assert.equal(s.ageMinutes, 0);
});

test('no assigned driver hides any point', () => {
  assert.equal(locationStatus(point(), null, now).state, 'previous-driver');
});
