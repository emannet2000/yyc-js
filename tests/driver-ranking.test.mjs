import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = ts.transpileModule(
  readFileSync(new URL('../frontend/driverRanking.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 } },
).outputText;
const { rankDrivers, fitNote } = await import(
  `data:text/javascript,${encodeURIComponent(source)}`
);

const d = (id, over = {}) => ({
  id,
  blocked: false,
  spareKg: 100,
  activeJobs: 0,
  ...over,
});

test('available drivers rank above blocked ones', () => {
  const ranked = rankDrivers([d('a', { blocked: true, spareKg: 500 }), d('b')]);
  assert.deepEqual(
    ranked.map((x) => x.id),
    ['b', 'a'],
  );
});

test('among available drivers the smallest sufficient truck ranks first', () => {
  const ranked = rankDrivers([d('big', { spareKg: 800 }), d('small', { spareKg: 40 })]);
  assert.deepEqual(
    ranked.map((x) => x.id),
    ['small', 'big'],
  );
});

test('ties on fit go to the driver with fewer active jobs', () => {
  const ranked = rankDrivers([
    d('busy', { activeJobs: 3 }),
    d('free', { activeJobs: 0 }),
  ]);
  assert.equal(ranked[0].id, 'free');
});

test('unknown capacity sorts after known capacity', () => {
  const ranked = rankDrivers([
    d('unknown', { spareKg: null }),
    d('known', { spareKg: 900 }),
  ]);
  assert.equal(ranked[0].id, 'known');
});

test('ranking does not mutate its input', () => {
  const input = [d('b', { spareKg: 300 }), d('a', { spareKg: 10 })];
  rankDrivers(input);
  assert.deepEqual(
    input.map((x) => x.id),
    ['b', 'a'],
  );
});

test('fit note describes spare capacity and job count', () => {
  assert.equal(
    fitNote(d('x', { spareKg: 99.6, activeJobs: 1 })),
    '100 kg to spare · 1 active job',
  );
  assert.equal(
    fitNote(d('x', { spareKg: null, activeJobs: 2 })),
    'capacity unknown · 2 active jobs',
  );
});
