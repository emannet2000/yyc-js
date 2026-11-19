import { resolve } from 'node:path';
import { startupConfig } from './config.js';
import { createBackupPolicy } from './maintenance.js';
import { configuredWebhook, configuredBackupUpload } from './integrations.js';
import { configuredResetDelivery } from './reset-delivery.js';
import { createRoadRouter } from './routing.js';
import { createApplication } from './app.js';
import { createGeocoder } from './geocoder.js';
import { checkConfiguration } from './config-check.js';
import { ensureBootstrapBroker } from './bootstrap-broker.js';
const config = startupConfig();
for (const item of checkConfiguration())
  if (item.level !== 'ok') console.warn(`Setup: ${item.area}: ${item.message}`);
const app = createApplication({
  calculateRoute: createRoadRouter(),
  geocode: createGeocoder(),
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
const bootstrap = await ensureBootstrapBroker(app);
if (bootstrap.created) console.log('First broker account created from ADMIN_* settings.');
app.server.listen(port, host, () =>
  console.log(`YYC workspace: http://${host}:${port}/react/`),
);
const backup = () =>
  void backups
    .run()
    .catch(() => console.error('Scheduled backup failed. Check backup last-run.json.'));
// Retention: location samples older than this are deleted. The default of 90
// days is a placeholder until the business sets its own policy.
const locationHistoryDays = Number(process.env.LOCATION_HISTORY_DAYS ?? 90);
if (!Number.isFinite(locationHistoryDays) || locationHistoryDays < 0)
  throw new Error('LOCATION_HISTORY_DAYS must be zero or a positive number of days.');
const pruneTimer = setInterval(
  () => app.pruneTrackingHistory(locationHistoryDays),
  60 * 60000,
);
pruneTimer.unref();
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
  clearInterval(pruneTimer);
  app.closeStreams();
  app.server.close(() => {
    app.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
