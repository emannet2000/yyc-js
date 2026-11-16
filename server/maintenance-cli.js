import { createBackupPolicy, recoveryDrill } from './maintenance.js';
import { configuredBackupUpload, configuredWebhook } from './integrations.js';
const [operation, source, directory] = process.argv.slice(2);
try {
  if (
    !['backup', 'drill'].includes(operation) ||
    !source ||
    !directory ||
    process.argv.length !== 5
  )
    throw new Error(
      'Usage: node server/maintenance-cli.js <backup|drill> <source.sqlite> <directory>',
    );
  console.log(
    JSON.stringify(
      operation === 'drill'
        ? recoveryDrill(source, directory)
        : await createBackupPolicy({
            source,
            directory,
            keep: Number(process.env.BACKUP_KEEP || 14),
            upload: configuredBackupUpload(),
            alert: configuredWebhook('OPERATIONS_ALERT'),
          }).run(),
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
