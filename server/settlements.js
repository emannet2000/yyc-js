import { cargoDrivers } from '../shared/settlements.js';
export function createSettlements({ db, requireThat, cents, text, now }) {
  db.exec(`CREATE TABLE IF NOT EXISTS invoice_allocations(invoice_id TEXT NOT NULL REFERENCES invoices(id),driver_id TEXT NOT NULL REFERENCES users(id),rate_cents INTEGER NOT NULL CHECK(rate_cents>=0),reason TEXT NOT NULL,PRIMARY KEY(invoice_id,driver_id));
    CREATE TABLE IF NOT EXISTS invoice_allocation_revisions(id INTEGER PRIMARY KEY AUTOINCREMENT,invoice_id TEXT NOT NULL REFERENCES invoices(id),actor_id TEXT NOT NULL REFERENCES users(id),data TEXT NOT NULL,created_at TEXT NOT NULL);`);
  if (
    !db
      .prepare('PRAGMA table_info(invoice_entries)')
      .all()
      .some((column) => column.name === 'driver_id')
  ) {
    db.exec(
      'ALTER TABLE invoice_entries ADD COLUMN driver_id TEXT REFERENCES users(id);',
    );
    db.exec(
      "UPDATE invoice_entries SET driver_id=(SELECT driver_id FROM invoices WHERE invoices.id=invoice_entries.invoice_id) WHERE kind IN ('payout','payoutRefund');",
    );
  }
  // Preserve existing ledger values. Multi-driver legacy invoices require explicit review before further payouts.
  db.exec(`INSERT INTO invoice_allocations(invoice_id,driver_id,rate_cents,reason)
    SELECT i.id,i.driver_id,i.rate_cents,'Existing invoice allocation; review handover shares before further payouts'
    FROM invoices i WHERE i.driver_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM invoice_allocations a WHERE a.invoice_id=i.id);`);
  function read(invoiceId) {
    return db
      .prepare(
        `SELECT a.driver_id AS driverId,u.name,a.rate_cents AS rateCents,a.reason,
      COALESCE((SELECT SUM(CASE WHEN e.kind='payout' THEN e.amount_cents WHEN e.kind='payoutRefund' THEN -e.amount_cents ELSE 0 END) FROM invoice_entries e WHERE e.invoice_id=a.invoice_id AND e.driver_id=a.driver_id),0) AS paidCents
      FROM invoice_allocations a JOIN users u ON u.id=a.driver_id WHERE a.invoice_id=? ORDER BY a.driver_id`,
      )
      .all(invoiceId)
      .map((a) => ({ ...a, dueCents: a.rateCents - a.paidCents }));
  }
  function validate(s, input, totalCents) {
    const drivers = cargoDrivers(s);
    if (input === undefined && drivers.length === 1)
      input = [
        { driverId: drivers[0], amount: totalCents / 100, reason: 'Sole cargo driver' },
      ];
    requireThat(
      Array.isArray(input) && input.length === drivers.length && drivers.length > 0,
      400,
      'Allocate the entire agreed rate explicitly across every driver who carried cargo.',
    );
    const seen = new Set();
    const allocations = input.map((item) => {
      requireThat(
        item &&
          typeof item === 'object' &&
          drivers.includes(item.driverId) &&
          !seen.has(item.driverId),
        400,
        'Allocation drivers must be unique cargo participants.',
      );
      seen.add(item.driverId);
      const amount = item.amount === 0 ? 0 : cents(item.amount);
      requireThat(amount >= 0, 400, 'Driver allocations cannot be negative.');
      return { driverId: item.driverId, rateCents: amount, reason: text(item, 'reason') };
    });
    const sum = allocations.reduce((n, a) => n + a.rateCents, 0);
    requireThat(
      Number.isSafeInteger(sum) && sum === totalCents,
      400,
      'Driver allocations must total the agreed driver rate exactly.',
    );
    return allocations;
  }
  function save(invoiceId, allocations, actorId) {
    const previous = read(invoiceId);
    for (const old of previous)
      requireThat(
        (allocations.find((a) => a.driverId === old.driverId)?.rateCents || 0) >=
          old.paidCents,
        409,
        'Reverse recorded payouts before reducing a driver allocation below the amount already paid.',
      );
    db.prepare('DELETE FROM invoice_allocations WHERE invoice_id=?').run(invoiceId);
    for (const a of allocations)
      db.prepare('INSERT INTO invoice_allocations VALUES (?,?,?,?)').run(
        invoiceId,
        a.driverId,
        a.rateCents,
        a.reason,
      );
    db.prepare(
      'INSERT INTO invoice_allocation_revisions(invoice_id,actor_id,data,created_at) VALUES (?,?,?,?)',
    ).run(
      invoiceId,
      actorId,
      JSON.stringify({ previous, allocations }),
      new Date(now()).toISOString(),
    );
  }
  function participants(s) {
    return cargoDrivers(s).map((driverId) => ({
      driverId,
      name:
        db.prepare('SELECT name FROM users WHERE id=?').get(driverId)?.name || driverId,
    }));
  }
  return { read, validate, save, participants };
}
