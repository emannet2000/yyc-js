import {
  mkdirSync,
  readdirSync,
  statSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { backupDatabase, restoreDatabase } from './backup.js';

export function createBackupPolicy({
  source,
  directory,
  keep = 14,
  now = Date.now,
  upload = null,
  alert = null,
}) {
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > 10000)
    throw new Error('Backup retention must be between 1 and 10000 snapshots.');
  source = resolve(source);
  directory = resolve(directory);
  let running = false;
  async function run() {
    if (running) return { skipped: true };
    running = true;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    let path;
    try {
      path = join(
        directory,
        `yyc-${new Date(now()).toISOString().replaceAll(':', '-')}-${randomUUID()}.sqlite`,
      );
      backupDatabase(source, path);
      const content = readFileSync(path),
        sha256 = createHash('sha256').update(content).digest('hex');
      if (upload) await upload({ name: basename(path), content, sha256 });
      const result = {
        ok: true,
        path,
        sha256,
        uploaded: !!upload,
        completedAt: new Date(now()).toISOString(),
      };
      writeFileSync(join(directory, 'last-run.json'), JSON.stringify(result, null, 2), {
        mode: 0o600,
      });
      const files = readdirSync(directory)
        .filter((name) =>
          /^yyc-\d{4}-\d{2}-\d{2}T[\d-]+\.\d{3}Z-[a-f0-9-]+\.sqlite$/.test(name),
        )
        .map((name) => ({ name, time: statSync(join(directory, name)).mtimeMs }))
        .sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
      for (const file of files.slice(keep)) rmSync(join(directory, file.name));
      return result;
    } catch (error) {
      const result = {
        ok: false,
        path: path || null,
        error: error.message,
        completedAt: new Date(now()).toISOString(),
      };
      writeFileSync(join(directory, 'last-run.json'), JSON.stringify(result, null, 2), {
        mode: 0o600,
      });
      if (alert)
        try {
          await alert({
            type: 'backup-failed',
            message:
              'A scheduled YYC backup or upload failed. Check the backup status file.',
          });
        } catch {
          /* Failure remains recorded locally. */
        }
      throw error;
    } finally {
      running = false;
    }
  }
  return { run };
}
export function recoveryDrill(source, directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID(),
    snapshot = join(directory, `drill-${id}.sqlite`),
    restored = join(directory, `restored-${id}.sqlite`);
  backupDatabase(source, snapshot);
  restoreDatabase(snapshot, restored);
  const original = new DatabaseSync(snapshot, { readOnly: true }),
    recovered = new DatabaseSync(restored, { readOnly: true });
  try {
    const tables = original
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    let compared = 0;
    for (const table of tables) {
      if (['sessions', 'password_resets'].includes(table)) {
        if (recovered.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n !== 0)
          throw new Error(`Restored ${table} were not cleared.`);
        continue;
      }
      const name = table.replaceAll('"', '""');
      const rows = (db) =>
        db
          .prepare(`SELECT * FROM "${name}"`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort();
      if (JSON.stringify(rows(original)) !== JSON.stringify(rows(recovered)))
        throw new Error(`Recovery mismatch: ${table}`);
      compared++;
    }
    return { ok: true, comparedTables: compared, snapshot, restored };
  } finally {
    original.close();
    recovered.close();
  }
}
