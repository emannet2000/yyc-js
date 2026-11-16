import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createBackupPolicy, recoveryDrill } from '../server/maintenance.js';
import { configuredWebhook, configuredBackupUpload } from '../server/integrations.js';
import { setup, booking, action } from './helpers/app.mjs';

test('scheduled backups retain configured snapshots, upload checksums, and recover all operational tables', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'yyc-policy-')),
    source = join(directory, 'source.sqlite');
  const f = await setup(t, { databasePath: source });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await f.store('/api/booking-draft', 'PUT', {
    version: 0,
    data: { pickup: 'Saved partial request' },
  });
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  const id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  await action(f.admin, id, 'quote', { price: 450, rate: 300 });
  await action(f.store, id, 'acceptQuote');
  await action(f.admin, id, 'offer', { driverId: f.driverId });
  await action(f.driver, id, 'acceptJob');
  await action(f.driver, id, 'pickup');
  let shipment = (await f.admin('/api/state')).value.shipments[0];
  await f.driver(`/api/shipments/${id}/evidence`, 'POST', {
    version: shipment.version,
    name: 'receipt.pdf',
    mime: 'application/pdf',
    content: Buffer.from('%PDF-1.4\n%%EOF').toString('base64'),
  });
  await action(f.driver, id, 'deliver', { pod: 'RECEIPT', recipient: 'Staff' });
  shipment = (await f.admin('/api/state')).value.shipments[0];
  await f.admin('/api/invoices', 'POST', { shipmentId: id, version: shipment.version });
  const uploaded = [],
    snapshots = join(directory, 'snapshots');
  const policy = createBackupPolicy({
    source,
    directory: snapshots,
    keep: 1,
    upload: async (payload) => {
      uploaded.push(payload);
    },
  });
  await policy.run();
  await policy.run();
  assert.equal(
    readdirSync(snapshots).filter((name) => name.endsWith('.sqlite')).length,
    1,
  );
  assert.equal(uploaded.length, 2);
  assert.equal(
    uploaded[0].sha256,
    createHash('sha256').update(uploaded[0].content).digest('hex'),
  );
  assert.equal(JSON.parse(readFileSync(join(snapshots, 'last-run.json'))).uploaded, true);
  const drill = recoveryDrill(source, join(directory, 'drill'));
  assert.equal(drill.ok, true);
  assert.ok(drill.comparedTables >= 12);
});

test('failed off-machine uploads preserve local snapshots and report a redacted operations alert', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'yyc-policy-failed-')),
    source = join(directory, 'source.sqlite');
  const f = await setup(t, { databasePath: source });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = join(directory, 'backups'),
    alerts = [];
  const policy = createBackupPolicy({
    source,
    directory: target,
    keep: 1,
    upload: async () => {
      throw new Error('Provider unavailable');
    },
    alert: async (message) => alerts.push(message),
  });
  await assert.rejects(policy.run(), /Provider unavailable/);
  assert.equal(alerts.length, 1);
  assert.equal(JSON.parse(readFileSync(join(target, 'last-run.json'))).ok, false);
  assert.equal(readdirSync(target).filter((name) => name.endsWith('.sqlite')).length, 1);
  writeFileSync(join(target, 'unrelated.sqlite'), 'keep');
  await assert.rejects(policy.run());
  assert.equal(readFileSync(join(target, 'unrelated.sqlite'), 'utf8'), 'keep');
  assert.equal((await f.admin('/api/state')).status, 200);
});

test('external adapters reject insecure or incomplete configuration without making requests', () => {
  assert.equal(configuredWebhook('NOTIFICATION_DELIVERY', {}), null);
  assert.equal(configuredBackupUpload({}), null);
  assert.throws(
    () =>
      configuredWebhook('NOTIFICATION_DELIVERY', {
        NOTIFICATION_DELIVERY_URL: 'http://example.test',
        NOTIFICATION_DELIVERY_TOKEN: 'secret',
      }),
    /HTTPS/,
  );
  assert.throws(
    () => configuredBackupUpload({ BACKUP_UPLOAD_URL: 'https://example.test' }),
    /TOKEN/,
  );
});
