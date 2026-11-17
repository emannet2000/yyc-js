import { resolve } from 'node:path';

export function startupConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const onRender = env.RENDER === 'true';
  const publicOrigin = env.PUBLIC_ORIGIN || (onRender && env.RENDER_EXTERNAL_URL);
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be an integer between 1 and 65535.');
  if (env.COOKIE_SECURE && !['true', 'false'].includes(env.COOKIE_SECURE))
    throw new Error('COOKIE_SECURE must be true or false.');
  if (production && (!publicOrigin || env.COOKIE_SECURE === 'false'))
    throw new Error('Production requires PUBLIC_ORIGIN and secure cookies.');
  const origin = new URL(publicOrigin || `http://127.0.0.1:${port}`);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/' ||
    (production && origin.protocol !== 'https:')
  )
    throw new Error('PUBLIC_ORIGIN must be an origin, using HTTPS in production.');
  const backupInterval = Number(env.BACKUP_INTERVAL_HOURS || 24) * 3600000;
  if (!Number.isFinite(backupInterval) || backupInterval < 60000)
    throw new Error('Backup interval must be at least one minute.');
  const backupKeep = Number(env.BACKUP_KEEP || 14);
  if (!Number.isSafeInteger(backupKeep) || backupKeep < 1 || backupKeep > 10000)
    throw new Error('Backup retention must be between 1 and 10000 snapshots.');
  if (production && env.DATABASE_PATH === ':memory:')
    throw new Error('Production requires a persistent database.');
  return {
    port,
    host: env.HOST || (onRender ? '0.0.0.0' : '127.0.0.1'),
    publicOrigin: origin.origin,
    secureCookies: production || env.COOKIE_SECURE === 'true',
    databasePath: env.DATABASE_PATH || resolve('data/yyc.sqlite'),
    backupInterval,
    backupKeep,
  };
}
