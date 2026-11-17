import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = ts.transpileModule(
  readFileSync(new URL('../frontend/roadMap.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext } },
).outputText;
const { roadLine } = await import(
  'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
);
test('road overlay uses geographic coordinates and only the current shipment plan', () => {
  const route = {
    shipmentVersion: 3,
    geometry: {
      type: 'LineString',
      coordinates: [
        [-114.07, 51.05],
        [-114.08, 51.06],
      ],
    },
  };
  assert.deepEqual(roadLine(route, 3), [
    [51.05, -114.07],
    [51.06, -114.08],
  ]);
  assert.deepEqual(roadLine(route, 4), []);
  for (const coordinates of [
    [
      [181, 51],
      [10, 50],
    ],
    [
      [1, 91],
      [1, 50],
    ],
    [
      [NaN, 51],
      [1, 50],
    ],
    [[1, 50]],
  ])
    assert.deepEqual(
      roadLine({ ...route, geometry: { type: 'LineString', coordinates } }, 3),
      [],
    );
});
