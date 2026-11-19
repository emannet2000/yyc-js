import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = ts.transpileModule(
  readFileSync(new URL('../frontend/locationTrail.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 } },
).outputText;
const { appendTrailPoint, TRAIL_MAX_POINTS } = await import(
  `data:text/javascript,${encodeURIComponent(source)}`
);

test('adds new points in order', () => {
  let t = [];
  t = appendTrailPoint(t, [51.0, -114.0]);
  t = appendTrailPoint(t, [51.1, -114.1]);
  assert.deepEqual(t, [
    [51.0, -114.0],
    [51.1, -114.1],
  ]);
});

test('ignores a repeated last point', () => {
  const t = [[51.0, -114.0]];
  assert.equal(appendTrailPoint(t, [51.0, -114.0]), t);
});

test('keeps only the newest points beyond the limit', () => {
  let t = [];
  for (let i = 0; i < 10; i++) t = appendTrailPoint(t, [i, i], 4);
  assert.deepEqual(t, [
    [6, 6],
    [7, 7],
    [8, 8],
    [9, 9],
  ]);
});

test('default limit is the exported constant', () => {
  let t = [];
  for (let i = 0; i < TRAIL_MAX_POINTS + 5; i++) t = appendTrailPoint(t, [i, 0]);
  assert.equal(t.length, TRAIL_MAX_POINTS);
  assert.equal(t[0][0], 5);
});

test('does not mutate the input array', () => {
  const t = [[1, 1]];
  appendTrailPoint(t, [2, 2]);
  assert.equal(t.length, 1);
});

const { trailFromHistory } = await import(
  `data:text/javascript,${encodeURIComponent(source)}`
);

test('history samples become trail points, skipping repeats', () => {
  const t = trailFromHistory([
    { latitude: 1, longitude: 2 },
    { latitude: 1, longitude: 2 },
    { latitude: 3, longitude: 4 },
  ]);
  assert.deepEqual(t, [
    [1, 2],
    [3, 4],
  ]);
});

test('history conversion keeps only the newest points', () => {
  const samples = Array.from({ length: 6 }, (_, i) => ({ latitude: i, longitude: 0 }));
  const t = trailFromHistory(samples, 3);
  assert.deepEqual(t, [
    [3, 0],
    [4, 0],
    [5, 0],
  ]);
});
