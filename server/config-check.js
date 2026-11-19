// Reports which optional features are switched on, and what the operator must
// still set up. Never prints secret values; only names and states.
export function checkConfiguration(env = process.env) {
  const items = [];
  const add = (level, area, message) => items.push({ level, area, message });
  const set = (name) => Boolean(env[name]);
  const production = env.NODE_ENV === 'production';

  const origin = env.PUBLIC_ORIGIN || '';
  if (origin.startsWith('https://')) add('ok', 'HTTPS', 'Public address uses HTTPS.');
  else
    add(
      production ? 'error' : 'warn',
      'HTTPS',
      'PUBLIC_ORIGIN is not an https:// address. Set one before real use.',
    );

  const geocoding = set('ORS_API_KEY') || set('GEOCODING_URL');
  add(
    geocoding ? 'ok' : 'warn',
    'Arrival detection',
    geocoding
      ? 'Geocoding is configured; arrival prompts can run.'
      : 'Set ORS_API_KEY or GEOCODING_URL. Arrival prompts stay off until then.',
  );

  const routing = set('ORS_API_KEY') || (set('ROUTING_URL') && set('GEOCODING_URL'));
  add(
    routing ? 'ok' : 'warn',
    'Road ETAs',
    routing
      ? 'Road routing is configured.'
      : 'Set ORS_API_KEY, or ROUTING_URL and GEOCODING_URL. ETAs use schedule estimates only.',
  );

  const alerts = set('OPERATIONS_ALERT_URL') && set('OPERATIONS_ALERT_TOKEN');
  add(
    alerts ? 'ok' : 'warn',
    'Backup failure alerts',
    alerts
      ? 'Alerts are sent when a backup fails.'
      : 'Set OPERATIONS_ALERT_URL and OPERATIONS_ALERT_TOKEN. Backup failures are logged only.',
  );

  const notifications =
    set('NOTIFICATION_DELIVERY_URL') && set('NOTIFICATION_DELIVERY_TOKEN');
  add(
    notifications ? 'ok' : 'warn',
    'Email and text notifications',
    notifications
      ? 'Notifications are sent to your delivery service.'
      : 'Set NOTIFICATION_DELIVERY_URL and NOTIFICATION_DELIVERY_TOKEN. Users see in-app notices only.',
  );

  const reset = set('RESET_DELIVERY_URL') && set('RESET_DELIVERY_TOKEN');
  add(
    reset ? 'ok' : 'warn',
    'Password reset email',
    reset
      ? 'Reset links are emailed.'
      : 'Set RESET_DELIVERY_URL and RESET_DELIVERY_TOKEN. Brokers must send recovery links by hand.',
  );

  const days =
    env.LOCATION_HISTORY_DAYS === undefined ? 90 : Number(env.LOCATION_HISTORY_DAYS);
  if (Number.isFinite(days) && days >= 0)
    add(
      'ok',
      'Location history',
      `Kept for ${days} days${env.LOCATION_HISTORY_DAYS === undefined ? ' (default; see the retention policy)' : ''}.`,
    );
  else
    add(
      'error',
      'Location history',
      'LOCATION_HISTORY_DAYS must be zero or a positive number.',
    );

  return items;
}
