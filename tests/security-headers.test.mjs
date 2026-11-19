import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers/app.mjs';

test('API responses send a strict content security policy', async (t) => {
  const f = await setup(t);
  const res = await f.client()('/api/session');
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp, 'content-security-policy header is present');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /connect-src 'self'/);
});
