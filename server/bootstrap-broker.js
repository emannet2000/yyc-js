// Creates the first broker account automatically at startup when the operator
// supplies ADMIN_EMAIL and ADMIN_PASSWORD. It only runs while no broker exists,
// so once the first broker is present these variables are ignored.
export async function ensureBootstrapBroker(app, env = process.env) {
  const email = (env.ADMIN_EMAIL || '').trim();
  const password = env.ADMIN_PASSWORD || '';
  if (!email && !password) return { created: false, reason: 'not-configured' };
  if (!email || !password)
    throw new Error(
      'ADMIN_EMAIL and ADMIN_PASSWORD must both be set to create the first broker.',
    );
  if (app.hasBroker()) return { created: false, reason: 'broker-exists' };
  await app.createAdmin({
    name: env.ADMIN_NAME || 'YYC Broker',
    email,
    password,
    phone: env.ADMIN_PHONE || 'Contact YYC',
  });
  return { created: true };
}
