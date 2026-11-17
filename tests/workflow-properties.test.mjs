import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setup, booking } from './helpers/app.mjs';

const seed = Number(process.env.FC_SEED ?? 0x5eed2026),
  numRuns = Number(process.env.WORKFLOW_FC_RUNS ?? 25);
assert.ok(Number.isInteger(seed) && Number.isInteger(numRuns) && numRuns > 0);
const attempts = fc.array(
  fc.record({
    actor: fc.constantFrom('admin', 'store', 'driver', 'other'),
    action: fc.constantFrom(
      'quote',
      'requote',
      'acceptQuote',
      'offer',
      'acceptJob',
      'decline',
      'arrival',
      'pickup',
      'deliver',
      'issue',
      'resolve',
      'change',
      'cancel',
      'unknown',
    ),
    stale: fc.boolean(),
    invalid: fc.boolean(),
  }),
  { maxLength: 40 },
);

test('workflow property: generated delivery traces enforce authorization, transitions, versions and atomic rollback', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'yyc-workflow-properties-'));
  const databasePath = join(directory, 'workflow.sqlite');
  const fixture = await setup(t, { databasePath });
  const db = new DatabaseSync(databasePath, { readOnly: true });
  t.after(async () => {
    db.close();
    await fixture.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const { admin, driverId } = fixture;
  await admin(`/api/drivers/${driverId}/approve`, 'POST', {});
  let scenario = 0;
  await fc.assert(
    fc.asyncProperty(attempts, async (commands) => {
      const index = scenario++,
        input = {
          ...booking(),
          date: new Date(Date.UTC(2099, 0, index + 1)).toISOString().slice(0, 10),
        };
      const headers = { 'Idempotency-Key': `workflow-property-${index}-request` };
      const created = await fixture.store('/api/shipments', 'POST', input, headers);
      assert.equal(created.status, 201);
      const id = created.value.id;
      const model = {
        status: 'Awaiting quote',
        version: 1,
        quoteVersion: 1,
        driverId: null,
        offeredTo: null,
        openIssue: false,
        reported: false,
        arrived: false,
        priced: false,
      };
      function snapshot() {
        return {
          shipment: db.prepare('SELECT * FROM shipments WHERE id=?').get(id),
          audit: db
            .prepare('SELECT * FROM audit WHERE shipment_id=? ORDER BY id')
            .all(id),
          counters: db.prepare('SELECT * FROM counters ORDER BY name').all(),
        };
      }
      async function perform(command, step) {
        if (command.action === 'deliver' && model.status === 'In transit') {
          const s = (await admin('/api/state')).value.shipments.find((s) => s.id === id);
          if (!s.evidenceCount) {
            const reply = await admin(`/api/shipments/${id}/evidence`, 'POST', {
              version: model.version,
              name: 'receipt.pdf',
              mime: 'application/pdf',
              content: Buffer.from('%PDF-1.4\nProperty evidence').toString('base64'),
            });
            assert.equal(reply.status, 201);
            model.version++;
          }
        }
        const before = snapshot();
        const active = ['Assigned', 'In transit'].includes(model.status);
        const visible =
          command.actor === 'admin' ||
          command.actor === 'store' ||
          (command.actor === 'driver' &&
            (model.driverId === driverId || model.offeredTo === driverId));
        const rules = {
          quote: command.actor === 'admin' && model.status === 'Awaiting quote',
          requote:
            command.actor === 'admin' &&
            model.priced &&
            ['Quote ready', 'Ready to assign', 'Offered', 'Assigned'].includes(
              model.status,
            ),
          acceptQuote: command.actor === 'store' && model.status === 'Quote ready',
          offer: command.actor === 'admin' && model.status === 'Ready to assign',
          acceptJob: command.actor === 'driver' && model.status === 'Offered',
          decline: command.actor === 'driver' && model.status === 'Offered',
          arrival:
            command.actor === 'driver' &&
            model.driverId === driverId &&
            active &&
            !model.arrived,
          pickup:
            command.actor === 'driver' &&
            model.driverId === driverId &&
            model.status === 'Assigned' &&
            !model.openIssue,
          deliver:
            command.actor === 'driver' &&
            model.driverId === driverId &&
            model.status === 'In transit' &&
            model.arrived &&
            !model.openIssue,
          issue:
            command.actor === 'driver' &&
            model.driverId === driverId &&
            active &&
            !model.openIssue,
          resolve: command.actor === 'admin' && model.openIssue,
          change:
            command.actor === 'admin' &&
            !['In transit', 'Delivered', 'Cancelled'].includes(model.status),
          cancel:
            (command.actor === 'admin' &&
              !['In transit', 'Delivered', 'Cancelled'].includes(model.status)) ||
            (command.actor === 'store' &&
              ['Awaiting quote', 'Quote ready'].includes(model.status)),
        };
        const invalidMatters = [
          'quote',
          'requote',
          'offer',
          'deliver',
          'issue',
          'resolve',
          'change',
        ].includes(command.action);
        const accepted =
          visible &&
          !!rules[command.action] &&
          !command.stale &&
          !(command.invalid && invalidMatters);
        const data = {
          version: model.version - (command.stale ? 1 : 0),
          action: command.action,
          price: command.action === 'requote' ? 500 + step : 450,
          rate: 300,
          driverId,
          pod: 'POD-PROPERTY',
          recipient: 'Receiving team',
          reason: 'Generated workflow test',
          note: 'Recorded issue',
          resolution: 'Receiving team confirmed',
          destination: `Revised destination ${index}-${step}`,
          kg: 1000,
          pallets: 4,
        };
        if (command.invalid)
          Object.assign(data, {
            price: 0.001,
            driverId: 'missing',
            pod: '',
            reason: '',
            resolution: '',
            destination: '',
          });
        const result = await fixture[command.actor](
          `/api/shipments/${id}/actions`,
          'POST',
          data,
        );
        assert.equal(
          result.status === 200,
          accepted,
          JSON.stringify({ command, model, result }),
        );
        if (!accepted) {
          assert.ok(result.status >= 400 && result.status < 500);
          if (!visible) assert.equal(result.status, 404);
          else if (command.stale) assert.equal(result.status, 409);
          assert.deepEqual(
            snapshot(),
            before,
            'Rejected actions must not modify shipment, audit or counters',
          );
          return;
        }
        model.version++;
        switch (command.action) {
          case 'quote':
            model.priced = true;
            model.status = 'Quote ready';
            break;
          case 'requote':
            model.status = 'Quote ready';
            model.quoteVersion++;
            model.driverId = null;
            model.offeredTo = null;
            model.arrived = false;
            break;
          case 'acceptQuote':
            model.status = 'Ready to assign';
            break;
          case 'offer':
            model.status = 'Offered';
            model.offeredTo = driverId;
            break;
          case 'acceptJob':
            model.status = 'Assigned';
            model.driverId = driverId;
            model.offeredTo = null;
            break;
          case 'decline':
            model.status = 'Ready to assign';
            model.offeredTo = null;
            break;
          case 'arrival':
            model.arrived = true;
            break;
          case 'pickup':
            model.status = 'In transit';
            model.arrived = false;
            break;
          case 'deliver':
            model.status = 'Delivered';
            break;
          case 'issue':
            model.openIssue = true;
            model.reported = true;
            break;
          case 'resolve':
            model.openIssue = false;
            break;
          case 'change':
            model.priced = false;
            model.status = 'Awaiting quote';
            model.quoteVersion++;
            model.driverId = null;
            model.offeredTo = null;
            model.arrived = false;
            break;
          case 'cancel':
            model.status = 'Cancelled';
            model.driverId = null;
            model.offeredTo = null;
            break;
        }
        const actual = (await admin('/api/state')).value.shipments.find(
          (s) => s.id === id,
        );
        for (const key of ['status', 'version', 'quoteVersion', 'driverId', 'offeredTo'])
          assert.equal(actual[key], model[key], key);
        assert.equal(!!actual.issue && !actual.issue.resolved, model.openIssue);
        assert.equal(actual.history.length, before.audit.length + 1);
      }
      function advance() {
        const next = {
          'Awaiting quote': ['admin', 'quote'],
          'Quote ready': ['store', 'acceptQuote'],
          'Ready to assign': ['admin', 'offer'],
          Offered: ['driver', 'acceptJob'],
          Assigned: model.openIssue
            ? ['admin', 'resolve']
            : ['driver', model.arrived ? 'pickup' : 'arrival'],
          'In transit': model.openIssue
            ? ['admin', 'resolve']
            : !model.reported
              ? ['driver', 'issue']
              : ['driver', model.arrived ? 'deliver' : 'arrival'],
        }[model.status] || ['admin', 'pickup'];
        return { actor: next[0], action: next[1], stale: false, invalid: false };
      }
      let step = 0;
      // Mix generated attempts with deliberate progress so deep delivery states
      // are exercised instead of spending almost every case awaiting a quotation.
      for (const command of commands) {
        await perform(command, step++);
        await perform(advance(), step++);
      }
      for (let n = 0; n < 12; n++) await perform(advance(), step++);
      const beforeReplay = snapshot();
      assert.equal(
        (await fixture.store('/api/shipments', 'POST', input, headers)).value.id,
        id,
      );
      assert.deepEqual(
        snapshot(),
        beforeReplay,
        'An idempotent booking replay must not change persisted workflow state',
      );
    }),
    { seed, numRuns, verbose: true },
  );
});
