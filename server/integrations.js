// Operators supply HTTPS endpoints. No network calls are made without configuration.
export function configuredWebhook(prefix, env = process.env) {
  const endpoint = env[`${prefix}_URL`],
    token = env[`${prefix}_TOKEN`];
  if (!endpoint) return null;
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || !token)
    throw new Error(`${prefix} requires HTTPS and a bearer token.`);
  return async (message) => {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`${prefix} delivery failed.`);
  };
}
export function configuredBackupUpload(env = process.env) {
  if (!env.BACKUP_UPLOAD_URL) return null;
  const url = new URL(env.BACKUP_UPLOAD_URL);
  if (url.protocol !== 'https:' || !env.BACKUP_UPLOAD_TOKEN)
    throw new Error('Backup upload requires HTTPS and BACKUP_UPLOAD_TOKEN.');
  return async ({ name, content, sha256 }) => {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/vnd.sqlite3',
        Authorization: `Bearer ${env.BACKUP_UPLOAD_TOKEN}`,
        'X-Backup-Name': name,
        'X-Content-SHA256': sha256,
      },
      body: content,
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error('Off-machine backup upload failed.');
  };
}
