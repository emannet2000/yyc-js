import { backupDatabase, restoreDatabase } from './backup.js';
const [operation, source, destination] = process.argv.slice(2);
if (
  !['backup', 'restore'].includes(operation) ||
  !source ||
  !destination ||
  process.argv.length !== 5
) {
  console.error(
    'Usage: node server/backup-cli.js <backup|restore> <source.sqlite> <new-destination.sqlite>',
  );
  process.exitCode = 1;
} else {
  try {
    console.log(
      (operation === 'restore' ? restoreDatabase : backupDatabase)(source, destination),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
