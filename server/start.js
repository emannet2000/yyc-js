import { resolve } from 'node:path';
import { createBackupPolicy } from './maintenance.js';
import { configuredWebhook, configuredBackupUpload } from './integrations.js';
import { configuredResetDelivery } from './reset-delivery.js';
import { createRoadRouter } from './routing.js';
import { createApplication } from './app.js';
import { startObservationWorker } from './observation-worker.js';
const app = createApplication({
  calculateRoute: createRoadRouter(),
  databasePath: process.env.DATABASE_PATH,
  publicOrigin:
    process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${process.env.PORT || 3000}`,
  sendResetLink: configuredResetDelivery(),
  sendNotification: configuredWebhook('NOTIFICATION_DELIVERY'),
  secureCookies: process.env.COOKIE_SECURE === 'true',
});
const port = Number(process.env.PORT || 3000),
  host = process.env.HOST || '0.0.0.0';
const stopObservations = startObservationWorker({
  sample: app.sampleObservations,
  intervalMs: Number(process.env.METRICS_SAMPLE_INTERVAL_MS ?? 60000),
});
app.server.listen(port, host, () =>
  console.log(`YYC workspace: http://${host}:${port}/react/`),
);
const backupInterval = Number(process.env.BACKUP_INTERVAL_HOURS || 24) * 3600000;
if (!Number.isFinite(backupInterval) || backupInterval < 60000)
  throw new Error('Backup interval must be at least one minute.');
const backups = createBackupPolicy({
  source: process.env.DATABASE_PATH || resolve('data/yyc.sqlite'),
  directory: process.env.BACKUP_DIRECTORY || resolve('data/backups'),
  keep: Number(process.env.BACKUP_KEEP || 14),
  upload: configuredBackupUpload(),
  alert: configuredWebhook('OPERATIONS_ALERT'),
});
const backup = () =>
  void backups
    .run()
    .catch(() => console.error('Scheduled backup failed. Check backup last-run.json.'));
const backupTimer = setInterval(backup, backupInterval);
backupTimer.unref();
backup();
const notificationTimer = setInterval(() => {
  app.expire();
  void app
    .processNotifications()
    .catch(() => console.error('Notification worker failed.'));
}, 30000);
notificationTimer.unref();
function shutdown() {
  stopObservations();
  clearInterval(backupTimer);
  clearInterval(notificationTimer);
  app.server.close(() => {
    app.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
