import test from 'node:test';
import assert from 'node:assert/strict';
import { checkConfiguration } from '../server/config-check.js';

const find = (items, area) => items.find((item) => item.area === area);

test('an empty configuration reports every optional feature as still to set up', () => {
  const items = checkConfiguration({});
  for (const area of [
    'Arrival detection',
    'Road ETAs',
    'Backup failure alerts',
    'Email and text notifications',
    'Password reset email',
  ])
    assert.equal(find(items, area).level, 'warn', area);
  assert.equal(find(items, 'HTTPS').level, 'warn');
});

test('production refuses a non-HTTPS public address as an error', () => {
  const items = checkConfiguration({
    NODE_ENV: 'production',
    PUBLIC_ORIGIN: 'http://x.example',
  });
  assert.equal(find(items, 'HTTPS').level, 'error');
});

test('geocoding and alerts are ok when their settings are present', () => {
  const items = checkConfiguration({
    ORS_API_KEY: 'k',
    OPERATIONS_ALERT_URL: 'https://a.example',
    OPERATIONS_ALERT_TOKEN: 't',
    PUBLIC_ORIGIN: 'https://deliveries.example.com',
  });
  assert.equal(find(items, 'Arrival detection').level, 'ok');
  assert.equal(find(items, 'Road ETAs').level, 'ok');
  assert.equal(find(items, 'Backup failure alerts').level, 'ok');
  assert.equal(find(items, 'HTTPS').level, 'ok');
});

test('a secret value is never printed in any message', () => {
  const items = checkConfiguration({
    ORS_API_KEY: 'super-secret-key',
    OPERATIONS_ALERT_URL: 'https://a.example',
    OPERATIONS_ALERT_TOKEN: 'alert-token-value',
  });
  const text = JSON.stringify(items);
  assert.doesNotMatch(text, /super-secret-key|alert-token-value/);
});

test('an invalid retention setting is an error', () => {
  const items = checkConfiguration({ LOCATION_HISTORY_DAYS: 'soon' });
  assert.equal(find(items, 'Location history').level, 'error');
});
