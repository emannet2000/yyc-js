import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupDatabase, restoreDatabase } from '../server/backup.js';
import { setup, start, login, booking, action } from './helpers/app.mjs';

test('a live WAL backup restores accounts, delivered shipments, audit history and idempotency', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'yyc-backup-'));
  const source = join(directory, 'source.sqlite'),
    snapshot = join(directory, 'backup.sqlite'),
    restored = join(directory, 'restored.sqlite');
  const fixture = await setup(t, { databasePath: source });
  const control = new DatabaseSync(source);
  control.exec('PRAGMA journal_mode=WAL;');
  const { admin, store, driver, driverId } = fixture;
  await admin(`/api/drivers/${driverId}/approve`, 'POST', {});
  const headers = { 'Idempotency-Key': 'backup-workflow-key-123' };
  const id = (await store('/api/shipments', 'POST', booking(), headers)).value.id;
  await action(admin, id, 'quote', { price: 450, rate: 300 });
  await action(store, id, 'acceptQuote');
  await action(admin, id, 'offer', { driverId });
  await action(driver, id, 'acceptJob');
  await action(driver, id, 'pickup');
  await action(driver, id, 'deliver', { pod: 'BACKUP-POD', recipient: 'Receiving team' });
  await admin(`/api/accounts/${driverId}/password-reset`, 'POST', {
    reason: 'Recovery test',
  });
  const oldCookie = (await login(store, 'store@example.com')).headers
    .get('set-cookie')
    .split(';')[0];
  const before = (await admin('/api/state')).value;
  backupDatabase(source, snapshot);
  assert.equal(statSync(snapshot).mode & 0o777, 0o600);
  await store('/api/shipments', 'POST', { ...booking(), goods: 'After snapshot' });
  restoreDatabase(snapshot, restored);
  const restoredApp = await start(t, { databasePath: restored });
  const recoveredAdmin = restoredApp.client(),
    recoveredStore = restoredApp.client();
  assert.equal(
    (await recoveredStore('/api/state', 'GET', undefined, { Cookie: oldCookie })).status,
    401,
  );
  await login(recoveredAdmin, 'admin@example.com');
  await login(recoveredStore, 'store@example.com');
  const after = (await recoveredAdmin('/api/state')).value;
  assert.deepEqual(after.accounts, before.accounts);
  assert.deepEqual(after.shipments, before.shipments);
  assert.equal(
    (await recoveredStore('/api/shipments', 'POST', booking(), headers)).value.id,
    id,
  );
  const recoveredDb = new DatabaseSync(restored);
  assert.equal(
    recoveredDb.prepare('SELECT count(*) AS total FROM password_resets').get().total,
    0,
  );
  assert.equal(
    recoveredDb.prepare('SELECT count(*) AS total FROM sessions').get().total,
    2,
  );
  assert.ok(
    recoveredDb.prepare('SELECT count(*) AS total FROM account_audit').get().total > 0,
  );
  recoveredDb.close();
  control.close();
  await fixture.stop();
  await restoredApp.stop();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
});

test('backup and restore reject overwrite, corruption, and source/destination identity', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'yyc-backup-errors-'));
  const source = join(directory, 'source.sqlite'),
    target = join(directory, 'existing.sqlite'),
    corrupt = join(directory, 'corrupt.sqlite');
  const app = await start(t, { databasePath: source });
  writeFileSync(target, 'keep me');
  writeFileSync(corrupt, 'invalid database');
  assert.throws(() => backupDatabase(source, source), /must differ/);
  assert.throws(() => backupDatabase(source, target), /EEXIST/);
  assert.throws(() => restoreDatabase(corrupt, join(directory, 'not-created.sqlite')));
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(target, 'utf8'), 'keep me');
  await app.stop();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
});

test('restore invalidates unused first-broker setup tokens', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'yyc-setup-restore-'));
  const source = join(directory, 'source.sqlite'),
    snapshot = join(directory, 'snapshot.sqlite'),
    restored = join(directory, 'restored.sqlite');
  const fixture = await start(t, { databasePath: source });
  fixture.app.createSetupToken();
  backupDatabase(source, snapshot);
  restoreDatabase(snapshot, restored);
  const db = new DatabaseSync(restored, { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bootstrap_tokens').get().n, 0);
  db.close();
  await fixture.stop();
  rmSync(directory, { recursive: true, force: true });
});
