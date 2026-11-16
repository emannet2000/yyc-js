import { DatabaseSync } from 'node:sqlite';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function validate(db) {
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok')
    throw new Error('Database integrity check failed.');
  if (db.prepare('PRAGMA foreign_key_check').all().length)
    throw new Error('Database foreign key check failed.');
  for (const table of [
    'users',
    'trucks',
    'sessions',
    'shipments',
    'audit',
    'counters',
    'booking_requests',
  ]) {
    if (
      !db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table)
    )
      throw new Error(`Missing application table: ${table}`);
  }
}

// VACUUM INTO takes a consistent SQLite snapshot, including committed WAL data.
// Publish via an exclusive hard link: never overwrite a database or backup.
export function backupDatabase(source, destination, { restore = false } = {}) {
  source = resolve(source);
  destination = resolve(destination);
  if (source === destination) throw new Error('Source and destination must differ.');
  mkdirSync(dirname(destination), { recursive: true });
  const directory = mkdtempSync(join(dirname(destination), '.yyc-snapshot-'));
  const temporary = join(directory, 'snapshot.sqlite');
  let db;
  try {
    db = new DatabaseSync(source, { readOnly: true });
    validate(db);
    db.prepare('VACUUM INTO ?').run(temporary);
    db.close();
    db = undefined;
    chmodSync(temporary, 0o600);
    db = new DatabaseSync(temporary);
    validate(db);
    if (restore) {
      db.exec('BEGIN IMMEDIATE; DELETE FROM sessions;');
      if (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='password_resets'",
          )
          .get()
      )
        db.exec('DELETE FROM password_resets;');
      if (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='recipient_links'",
          )
          .get()
      )
        db.exec('DELETE FROM recipient_links;');
      for (const table of ['mobile_devices', 'mobile_pairings']) {
        if (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
            .get(table)
        )
          db.exec(`DELETE FROM ${table};`);
      }
      db.exec('COMMIT;');
      validate(db);
    }
    db.close();
    db = undefined;
    linkSync(temporary, destination);
    return destination;
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
export const restoreDatabase = (source, destination) =>
  backupDatabase(source, destination, { restore: true });
