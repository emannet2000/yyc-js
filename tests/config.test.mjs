import test from 'node:test';
import assert from 'node:assert/strict';
import { startupConfig } from '../server/config.js';

test('production startup requires persistent storage, HTTPS and secure cookies', () => {
  const env = { NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://deliveries.example.com' };
  assert.equal(startupConfig(env).secureCookies, true);
  for (const override of [
    { PUBLIC_ORIGIN: '' },
    { PUBLIC_ORIGIN: 'http://deliveries.example.com' },
    { PUBLIC_ORIGIN: 'https://user:pass@deliveries.example.com' },
    { PUBLIC_ORIGIN: 'https://deliveries.example.com/path' },
    { COOKIE_SECURE: 'false' },
    { COOKIE_SECURE: 'typo' },
    { DATABASE_PATH: ':memory:' },
    { PORT: 'NaN' },
    { PORT: '65536' },
    { BACKUP_INTERVAL_HOURS: '-1' },
    { BACKUP_KEEP: '0' },
  ])
    assert.throws(() => startupConfig({ ...env, ...override }));
});

test('local startup binds to localhost with configurable port', () => {
  const config = startupConfig({ PORT: '3001' });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.publicOrigin, 'http://127.0.0.1:3001');
  assert.equal(config.secureCookies, false);
});
