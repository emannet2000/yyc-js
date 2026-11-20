import test from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers/app.mjs';

test('GET /api/health returns ok when db is reachable', async (t) => {
  const { client } = await start(t);
  const res = await client()('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.value.status, 'ok');
  assert.equal(res.value.db, 'ok');
  assert.ok(typeof res.value.uptime === 'number');
  assert.ok('backup' in res.value, 'backup field should be present');
  assert.equal(res.value.backup.status, 'unconfigured', 'test app has no backup dir');
  assert.equal(res.value.backup.ageSeconds, null);
});
