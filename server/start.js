import { resolve } from 'node:path';
import { startupConfig } from './config.js';
import { createBackupPolicy } from './maintenance.js';
import { configuredWebhook, configuredBackupUpload } from './integrations.js';
import { configuredResetDelivery } from './reset-delivery.js';
import { createRoadRouter } from './routing.js';
import { createApplication } from './app.js';
const config = startupConfig();
const app = createApplication({
  calculateRoute: createRoadRouter(),
  databasePath: config.databasePath,
  publicOrigin: config.publicOrigin,
  sendResetLink: configuredResetDelivery(),
  sendNotification: configuredWebhook('NOTIFICATION_DELIVERY'),
  secureCookies: config.secureCookies,
});
const backups = createBackupPolicy({
  source: config.databasePath,
  directory: process.env.BACKUP_DIRECTORY || resolve('data/backups'),
  keep: config.backupKeep,
  upload: configuredBackupUpload(),
  alert: configuredWebhook('OPERATIONS_ALERT'),
});
const { port, host } = config;
app.server.listen(port, host, () =>
  console.log(`YYC workspace: http://${host}:${port}/react/`),
);
const backup = () =>
  void backups
    .run()
    .catch(() => console.error('Scheduled backup failed. Check backup last-run.json.'));
const backupTimer = setInterval(backup, config.backupInterval);
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
  clearInterval(backupTimer);
  clearInterval(notificationTimer);
  app.server.close(() => {
    app.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
