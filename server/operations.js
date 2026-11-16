import { randomUUID, createHash } from 'node:crypto';
import { isPositiveMoney } from '../shared/money.js';

export function createOperations({
  db,
  now,
  text,
  positive,
  choice,
  requireThat,
  transaction,
  shipments,
  persist,
  audit,
  account,
  accountEvent,
  send,
  sendNotification,
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS tracking(shipment_id TEXT PRIMARY KEY REFERENCES shipments(id),data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),shipment_id TEXT REFERENCES shipments(id),message TEXT NOT NULL,created_at TEXT NOT NULL,read_at TEXT,delivery_status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id,created_at);
  CREATE TABLE IF NOT EXISTS booking_drafts(user_id TEXT PRIMARY KEY REFERENCES users(id),data TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY,shipment_id TEXT NOT NULL REFERENCES shipments(id),actor_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,mime TEXT NOT NULL,content BLOB NOT NULL,sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS evidence_shipment ON evidence(shipment_id);
  CREATE TABLE IF NOT EXISTS invoices(id TEXT PRIMARY KEY,shipment_id TEXT NOT NULL UNIQUE REFERENCES shipments(id),amount_cents INTEGER NOT NULL,tax_cents INTEGER NOT NULL,rate_cents INTEGER NOT NULL,driver_id TEXT REFERENCES users(id),version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS invoice_entries(id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL REFERENCES invoices(id),request_key TEXT NOT NULL,kind TEXT NOT NULL,amount_cents INTEGER NOT NULL,reference TEXT NOT NULL,reason TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,UNIQUE(invoice_id,request_key));`);
  const timestamp = () => new Date(now()).toISOString();
  function notify(userId, shipmentId, message) {
    db.prepare(
      'INSERT INTO notifications(id,user_id,shipment_id,message,created_at,delivery_status) VALUES (?,?,?,?,?,?)',
    ).run(
      randomUUID(),
      userId,
      shipmentId,
      message,
      timestamp(),
      sendNotification ? 'pending' : 'in-app',
    );
  }
  function notifyShipment(s, message) {
    const recipients = new Set([
      s.storeId,
      s.driverId,
      s.offeredTo,
      ...db
        .prepare("SELECT id FROM users WHERE role='admin' AND disabled=0")
        .all()
        .map((u) => u.id),
    ]);
    for (const id of recipients) if (id) notify(id, s.id, `${s.id}: ${message}`);
  }
  function expire() {
    const rows = db
      .prepare(
        "SELECT id FROM shipments WHERE status IN ('Quote ready','Offered','Assigned','In transit','Delivery failed','Returning') AND (json_extract(data,'$.quoteExpiresAt') IS NOT NULL OR json_extract(data,'$.offerExpiresAt') IS NOT NULL)",
      )
      .all();
    if (!rows.length) return;
    transaction(db, () => {
      for (const row of rows) {
        const s = shipments({ role: 'admin' }, row.id, false)[0];
        let message;
        if (s.status === 'Quote ready' && s.quoteExpiresAt <= now()) {
          s.quoteArchive = [
            ...(s.quoteArchive || []),
            {
              version: s.quoteVersion,
              price: s.price,
              rate: s.rate,
              destination: s.destination,
              kg: s.kg,
              pallets: s.pallets,
              reason: 'Quotation expired',
            },
          ];
          s.quoteVersion++;
          s.price = null;
          s.rate = null;
          s.status = 'Awaiting quote';
          delete s.quoteExpiresAt;
          message = 'System: quotation expired; a new quotation is required';
        } else if (s.offeredTo && s.offerExpiresAt <= now()) {
          s.offeredTo = null;
          delete s.offerExpiresAt;
          delete s.handover;
          if (s.status === 'Offered') s.status = 'Ready to assign';
          message = 'System: driver offer expired; reservation released';
        }
        if (message) {
          s.version++;
          persist(s);
          audit(s, { id: s.storeId }, message);
        }
      }
    });
  }
  function withdrawOffers(driverId, actor, reason) {
    for (const s of shipments({ role: 'admin' }).filter(
      (s) => s.offeredTo === driverId,
    )) {
      s.offeredTo = null;
      delete s.handover;
      delete s.offerExpiresAt;
      if (s.status === 'Offered') s.status = 'Ready to assign';
      s.version++;
      persist(s);
      audit(s, actor, `Offer withdrawn: ${reason}`);
    }
  }
  function driverReview(id, actor, data) {
    return transaction(db, () => {
      const driver = account(db.prepare('SELECT * FROM users WHERE id=?').get(id));
      requireThat(
        driver?.role === 'driver' && !driver.disabled,
        404,
        'Active driver not found.',
      );
      requireThat(
        data.version === driver.version,
        409,
        'Driver profile changed. Refresh before reviewing.',
      );
      const decision = choice(data, 'decision', ['approve', 'reject', 'revoke']),
        reason = text(data, 'reason');
      const profile = {
        ...driver.profile,
        version: driver.version + 1,
        reviewDecision: decision,
        reviewReason: reason,
      };
      db.prepare('UPDATE users SET approved=?,profile=? WHERE id=?').run(
        decision === 'approve' ? 1 : 0,
        JSON.stringify(profile),
        id,
      );
      db.prepare('UPDATE trucks SET approved=? WHERE driver_id=?').run(
        decision === 'approve' ? 1 : 0,
        id,
      );
      if (decision !== 'approve') withdrawOffers(id, actor, reason);
      accountEvent(actor.id, id, `Driver review ${decision}: ${reason}`);
      notify(id, null, `Driver review ${decision}: ${reason}`);
    });
  }
  const cents = (value) => {
    requireThat(
      typeof value === 'number' && isPositiveMoney(Math.abs(value)),
      400,
      'Amount must be nonzero whole cents.',
    );
    const result = Math.round(value * 100);
    requireThat(Number.isSafeInteger(result), 400, 'Amount is too large.');
    return result;
  };
  function invoiceView(row, user) {
    const entries = db
      .prepare(
        'SELECT id,kind,amount_cents AS amountCents,reference,reason,created_at AS createdAt FROM invoice_entries WHERE invoice_id=? ORDER BY created_at,id',
      )
      .all(row.id);
    const sum = (kind) =>
      entries
        .filter((e) => e.kind === kind)
        .reduce((total, e) => total + e.amountCents, 0);
    const total = row.amount_cents + row.tax_cents + sum('adjustment'),
      paid = sum('payment') - sum('refund'),
      payout = sum('payout') - sum('payoutRefund');
    if (user.role === 'driver')
      return {
        id: row.id,
        shipmentId: row.shipment_id,
        rateCents: row.rate_cents,
        paidCents: payout,
        dueCents: row.rate_cents - payout,
        entries: entries.filter((e) => ['payout', 'payoutRefund'].includes(e.kind)),
      };
    return {
      id: row.id,
      shipmentId: row.shipment_id,
      version: row.version,
      createdAt: row.created_at,
      amountCents: row.amount_cents,
      taxCents: row.tax_cents,
      totalCents: total,
      paidCents: paid,
      dueCents: total - paid,
      ...(user.role === 'admin'
        ? { rateCents: row.rate_cents, payoutCents: payout }
        : {}),
      entries:
        user.role === 'admin'
          ? entries
          : entries.filter((e) => !['payout', 'payoutRefund'].includes(e.kind)),
    };
  }
  function invoices(user) {
    return db
      .prepare(
        `SELECT i.* FROM invoices i JOIN shipments s ON s.id=i.shipment_id ${user.role === 'store' ? 'WHERE s.store_id=?' : user.role === 'driver' ? 'WHERE i.driver_id=?' : ''} ORDER BY i.created_at DESC,i.id`,
      )
      .all(...(user.role === 'admin' ? [] : [user.id]))
      .map((row) => invoiceView(row, user));
  }
  async function processNotifications() {
    if (!sendNotification) return;
    const pending = db
      .prepare(
        "SELECT n.*,u.email FROM notifications n JOIN users u ON u.id=n.user_id WHERE u.disabled=0 AND ((n.delivery_status IN ('pending','failed') AND n.next_attempt_at<=?) OR (n.delivery_status='sending' AND n.lease_until<=?)) AND n.attempts<5 ORDER BY n.created_at LIMIT 10",
      )
      .all(now(), now());
    for (const n of pending) {
      const claim = db
        .prepare(
          "UPDATE notifications SET delivery_status='sending',lease_until=?,attempts=attempts+1 WHERE id=? AND attempts=? AND lease_until<=?",
        )
        .run(now() + 60000, n.id, n.attempts, now());
      if (!claim.changes) continue;
      try {
        await sendNotification({
          id: n.id,
          email: n.email,
          message: n.message,
          shipmentId: n.shipment_id,
        });
        db.prepare(
          "UPDATE notifications SET delivery_status='sent',lease_until=0 WHERE id=? AND attempts=?",
        ).run(n.id, n.attempts + 1);
      } catch {
        db.prepare(
          "UPDATE notifications SET delivery_status='failed',lease_until=0,next_attempt_at=? WHERE id=? AND attempts=?",
        ).run(now() + Math.min(3600000, 60000 * 2 ** n.attempts), n.id, n.attempts + 1);
      }
    }
  }
  async function route(path, req, res, user, data, url) {
    const admin = () =>
      requireThat(user.role === 'admin', 403, 'Broker access required.');
    const tracking = /^\/api\/shipments\/([^/]+)\/tracking$/.exec(path);
    if (tracking) {
      const s = shipments(user, tracking[1], false)[0];
      requireThat(s, 404, 'Delivery not found.');
      const previous = db
        .prepare('SELECT data FROM tracking WHERE shipment_id=?')
        .get(s.id);
      const current = previous ? JSON.parse(previous.data) : {};
      if (req.method === 'GET') {
        send(res, 200, current);
        return true;
      }
      if (req.method === 'POST') {
        requireThat(
          user.role === 'driver' &&
            s.driverId === user.id &&
            ['Assigned', 'In transit', 'Delivery failed', 'Returning'].includes(s.status),
          403,
          'Only the active assigned driver can share location.',
        );
        requireThat(
          typeof data.latitude === 'number' &&
            Number.isFinite(data.latitude) &&
            Math.abs(data.latitude) <= 90 &&
            typeof data.longitude === 'number' &&
            Number.isFinite(data.longitude) &&
            Math.abs(data.longitude) <= 180 &&
            typeof data.accuracy === 'number' &&
            Number.isFinite(data.accuracy) &&
            data.accuracy >= 0 &&
            data.accuracy <= 100000,
          400,
          'Location coordinates or accuracy are invalid.',
        );
        const recordedAt =
          data.recordedAt === undefined ? timestamp() : text(data, 'recordedAt');
        requireThat(
          Number.isFinite(Date.parse(recordedAt)) &&
            Date.parse(recordedAt) <= now() + 60000 &&
            Date.parse(recordedAt) >= now() - 5 * 60000,
          400,
          'Location sample is too old or in the future.',
        );
        requireThat(
          current.driverId !== user.id ||
            !current.recordedAt ||
            Date.parse(recordedAt) >= Date.parse(current.recordedAt),
          409,
          'A newer location has already been recorded.',
        );
        Object.assign(current, {
          latitude: data.latitude,
          longitude: data.longitude,
          accuracy: data.accuracy,
          recordedAt,
          driverId: user.id,
        });
      } else if (req.method === 'PATCH') {
        requireThat(
          (user.role === 'admin' || (user.role === 'driver' && s.driverId === user.id)) &&
            ['Assigned', 'In transit', 'Delivery failed', 'Returning'].includes(s.status),
          403,
          'Only the broker or active driver can update the ETA.',
        );
        const eta = text(data, 'eta', true);
        requireThat(
          !eta ||
            (Number.isFinite(Date.parse(eta)) &&
              Date.parse(eta) >= now() &&
              Date.parse(eta) <= now() + 30 * 86400000),
          400,
          'Choose an ETA within the next 30 days.',
        );
        Object.assign(current, { eta, etaUpdatedAt: timestamp(), etaSource: 'manual' });
      } else return false;
      db.prepare(
        'INSERT INTO tracking VALUES (?,?) ON CONFLICT(shipment_id) DO UPDATE SET data=excluded.data',
      ).run(s.id, JSON.stringify(current));
      send(res, 200, { ok: true });
      return true;
    }
    if (path === '/api/notifications' && req.method === 'GET') {
      send(
        res,
        200,
        db
          .prepare(
            'SELECT id,shipment_id AS shipmentId,message,created_at AS createdAt,read_at AS readAt,delivery_status AS deliveryStatus,attempts FROM notifications WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 200',
          )
          .all(user.id),
      );
      return true;
    }
    const notification = /^\/api\/notifications\/([^/]+)\/(read|retry)$/.exec(path);
    if (notification && req.method === 'POST') {
      const n = db
        .prepare('SELECT * FROM notifications WHERE id=? AND user_id=?')
        .get(notification[1], user.id);
      requireThat(n, 404, 'Notification not found.');
      if (notification[2] === 'read')
        db.prepare('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=?').run(
          timestamp(),
          n.id,
        );
      else {
        requireThat(
          sendNotification,
          409,
          'External notification delivery is not configured.',
        );
        requireThat(
          n.delivery_status === 'failed',
          409,
          'Only failed deliveries can be retried.',
        );
        db.prepare(
          "UPDATE notifications SET delivery_status='pending',attempts=0,next_attempt_at=0,lease_until=0 WHERE id=?",
        ).run(n.id);
      }
      send(res, 200, { ok: true });
      return true;
    }
    if (path === '/api/booking-draft') {
      requireThat(user.role === 'store', 403, 'Store access required.');
      const draft = db
        .prepare(
          'SELECT data,version,updated_at AS updatedAt FROM booking_drafts WHERE user_id=?',
        )
        .get(user.id);
      if (req.method === 'GET') {
        send(
          res,
          200,
          draft
            ? {
                data: JSON.parse(draft.data),
                version: draft.version,
                updatedAt: draft.updatedAt,
              }
            : { data: {}, version: 0 },
        );
        return true;
      }
      if (['PUT', 'DELETE'].includes(req.method)) {
        requireThat(
          data.version === (draft?.version || 0),
          409,
          'Draft changed in another tab. Reload the draft before saving.',
        );
        if (req.method === 'DELETE')
          db.prepare(
            'INSERT INTO booking_drafts VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,version=excluded.version,updated_at=excluded.updated_at',
          ).run(user.id, '{}', (draft?.version || 0) + 1, timestamp());
        else {
          requireThat(
            data.data && typeof data.data === 'object' && !Array.isArray(data.data),
            400,
            'Draft data must be an object.',
          );
          const allowed = [
            'pickup',
            'destination',
            'date',
            'window',
            'goods',
            'kg',
            'pallets',
            'type',
            'unloading',
            'pickupContact',
            'receivingContact',
            'hours',
            'appointment',
            'cargoNotes',
            'notes',
            'deliveryDeadline',
          ];
          requireThat(
            Object.entries(data.data).every(
              ([key, value]) =>
                allowed.includes(key) &&
                ['string', 'number'].includes(typeof value) &&
                String(value).length <= 2000,
            ),
            400,
            'Draft contains invalid fields.',
          );
          db.prepare(
            'INSERT INTO booking_drafts VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,version=excluded.version,updated_at=excluded.updated_at',
          ).run(
            user.id,
            JSON.stringify(data.data),
            (draft?.version || 0) + 1,
            timestamp(),
          );
        }
        send(res, 200, { version: (draft?.version || 0) + 1 });
        return true;
      }
    }
    if (path === '/api/driver-profile' && req.method === 'PATCH') {
      requireThat(user.role === 'driver', 403, 'Driver access required.');
      transaction(db, () => {
        const driver = account(db.prepare('SELECT * FROM users WHERE id=?').get(user.id));
        requireThat(
          data.version === driver.version,
          409,
          'Profile changed. Refresh before editing.',
        );
        const truck = {
          truck: text(data, 'truck'),
          plate: text(data, 'plate').toUpperCase(),
          type: choice(data, 'type', ['Box truck', 'Dry van']),
          kg: positive(data, 'kg'),
          pallets: positive(data, 'pallets', true),
          area: text(data, 'area'),
          liftgate: data.liftgate === true,
        };
        requireThat(
          typeof data.liftgate === 'boolean',
          400,
          'liftgate must be a boolean.',
        );
        const material = Object.entries(truck).some(
          ([key, value]) => driver.truck[key] !== value,
        );
        requireThat(
          !material ||
            !shipments(user).some(
              (s) =>
                s.driverId === user.id &&
                ['In transit', 'Delivery failed', 'Returning'].includes(s.status),
            ),
          409,
          'Finish or hand over live cargo before changing the truck.',
        );
        requireThat(
          !db
            .prepare(
              'SELECT id FROM trucks WHERE plate=? COLLATE NOCASE AND driver_id<>?',
            )
            .get(truck.plate, user.id),
          409,
          'Truck plate is already registered.',
        );
        const profile = {
          ...driver.profile,
          phone: text(data, 'phone'),
          version: driver.version + 1,
          ...(material
            ? { reviewDecision: 'pending', reviewReason: 'Truck details changed' }
            : {}),
        };
        db.prepare('UPDATE users SET name=?,profile=?,approved=? WHERE id=?').run(
          text(data, 'name'),
          JSON.stringify(profile),
          material ? 0 : driver.approved ? 1 : 0,
          user.id,
        );
        db.prepare(
          'UPDATE trucks SET plate=?,profile=?,approved=? WHERE driver_id=?',
        ).run(
          truck.plate,
          JSON.stringify(truck),
          material ? 0 : driver.truck.approved ? 1 : 0,
          user.id,
        );
        if (material)
          withdrawOffers(user.id, user, 'Truck details changed; reapproval required');
        accountEvent(
          user.id,
          user.id,
          'Driver profile updated' + (material ? '; reapproval required' : ''),
        );
        notify(
          user.id,
          null,
          material
            ? 'Truck details saved; broker reapproval required.'
            : 'Profile saved.',
        );
      });
      send(res, 200, { ok: true });
      return true;
    }
    const review = /^\/api\/drivers\/([^/]+)\/review$/.exec(path);
    if (review && req.method === 'POST') {
      admin();
      driverReview(review[1], user, data);
      send(res, 200, { ok: true });
      return true;
    }
    const evidenceRoute = /^\/api\/shipments\/([^/]+)\/evidence$/.exec(path);
    if (evidenceRoute) {
      const s = shipments(user, evidenceRoute[1], false)[0];
      requireThat(s, 404, 'Delivery not found.');
      if (req.method === 'GET') {
        send(
          res,
          200,
          db
            .prepare(
              'SELECT id,name,mime,sha256,created_at AS createdAt FROM evidence WHERE shipment_id=? ORDER BY created_at,id',
            )
            .all(s.id),
        );
        return true;
      }
      if (req.method === 'POST') {
        requireThat(
          user.role === 'admin' || (user.role === 'driver' && s.driverId === user.id),
          403,
          'Only the broker or assigned driver can attach evidence.',
        );
        let requestHash;
        if (data.requestKey !== undefined) {
          requireThat(
            typeof data.requestKey === 'string' &&
              /^[A-Za-z0-9_-]{16,128}$/.test(data.requestKey),
            400,
            'Invalid evidence request key.',
          );
          requestHash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
          const previous = db
            .prepare('SELECT * FROM action_requests WHERE user_id=? AND request_key=?')
            .get(user.id, data.requestKey);
          if (previous) {
            requireThat(
              previous.shipment_id === s.id && previous.request_hash === requestHash,
              409,
              'Evidence request key was used with different details.',
            );
            send(res, 201, JSON.parse(previous.result));
            return true;
          }
        }
        requireThat(
          s.version === data.version,
          409,
          'Delivery changed. Refresh before attaching evidence.',
        );
        const name = text(data, 'name'),
          mime = choice(data, 'mime', ['image/png', 'image/jpeg', 'application/pdf']);
        requireThat(
          name.length <= 120 && !/[\r\n/\\]/.test(name),
          400,
          'Choose a filename without path characters.',
        );
        requireThat(
          typeof data.content === 'string' &&
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
              data.content,
            ),
          400,
          'Invalid base64 content.',
        );
        const content = Buffer.from(data.content, 'base64');
        requireThat(
          content.length > 0 && content.length <= 2 * 1024 * 1024,
          400,
          'Files must be between 1 byte and 2 MiB.',
        );
        const signature =
          mime === 'image/png'
            ? content
                .subarray(0, 8)
                .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : mime === 'image/jpeg'
              ? content[0] === 255 && content[1] === 216 && content[2] === 255
              : content.subarray(0, 5).toString() === '%PDF-';
        requireThat(signature, 400, 'File content does not match its type.');
        transaction(db, () => {
          requireThat(
            db.prepare('SELECT count(*) AS n FROM evidence WHERE shipment_id=?').get(s.id)
              .n < 10,
            409,
            'A delivery can have at most ten files.',
          );
          db.prepare('INSERT INTO evidence VALUES (?,?,?,?,?,?,?,?)').run(
            randomUUID(),
            s.id,
            user.id,
            name,
            mime,
            content,
            createHash('sha256').update(content).digest('hex'),
            timestamp(),
          );
          s.version++;
          persist(s);
          audit(s, user, `Evidence attached: ${name}`);
          if (data.requestKey)
            db.prepare('INSERT INTO action_requests VALUES (?,?,?,?,?)').run(
              user.id,
              data.requestKey,
              s.id,
              requestHash,
              JSON.stringify({ ok: true }),
            );
        });
        send(res, 201, { ok: true });
        return true;
      }
    }
    const download = /^\/api\/evidence\/([^/]+)$/.exec(path);
    if (download && req.method === 'GET') {
      const file = db.prepare('SELECT * FROM evidence WHERE id=?').get(download[1]);
      requireThat(
        file && shipments(user, file.shipment_id, false)[0],
        404,
        'Evidence not found.',
      );
      res.writeHead(200, {
        'Content-Type': file.mime,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(Buffer.from(file.content));
      return true;
    }
    if (
      (path === '/api/invoices' || path === '/api/settlements') &&
      req.method === 'GET'
    ) {
      requireThat(
        path === '/api/settlements' ? user.role === 'driver' : user.role !== 'driver',
        403,
        'This financial view is not available for this account.',
      );
      send(res, 200, invoices(user));
      return true;
    }
    if (path === '/api/invoices' && req.method === 'POST') {
      admin();
      const result = transaction(db, () => {
        const s = shipments(user, text(data, 'shipmentId'), false)[0];
        requireThat(
          s && ['Delivered', 'Returned'].includes(s.status),
          409,
          'Only completed deliveries or returns can be invoiced.',
        );
        const existing = db
          .prepare('SELECT * FROM invoices WHERE shipment_id=?')
          .get(s.id);
        if (existing) return invoiceView(existing, user);
        requireThat(
          s.version === data.version,
          409,
          'Delivery changed. Refresh before invoicing.',
        );
        requireThat(
          isPositiveMoney(s.price) && isPositiveMoney(s.rate),
          409,
          'The delivery must have an agreed price and rate.',
        );
        const tax = data.taxCents ?? 0;
        requireThat(
          Number.isSafeInteger(tax) && tax >= 0 && tax <= 1000000000,
          400,
          'Tax must be a nonnegative whole-cent amount.',
        );
        const id = `INV-${randomUUID()}`;
        db.prepare('INSERT INTO invoices VALUES (?,?,?,?,?,?,1,?)').run(
          id,
          s.id,
          cents(s.price),
          tax,
          cents(s.rate),
          s.driverId,
          timestamp(),
        );
        audit(s, user, `Invoice issued: ${id}`);
        return invoiceView(db.prepare('SELECT * FROM invoices WHERE id=?').get(id), user);
      });
      send(res, 201, result);
      return true;
    }
    const entry = /^\/api\/invoices\/([^/]+)\/entries$/.exec(path);
    if (entry && req.method === 'POST') {
      admin();
      const result = transaction(db, () => {
        const row = db.prepare('SELECT * FROM invoices WHERE id=?').get(entry[1]);
        requireThat(row, 404, 'Invoice not found.');
        const kind = choice(data, 'kind', [
            'payment',
            'refund',
            'adjustment',
            'payout',
            'payoutRefund',
          ]),
          amount = cents(data.amount),
          reference = text(data, 'reference'),
          reason = text(data, 'reason'),
          key = text(data, 'requestKey');
        requireThat(
          /^[A-Za-z0-9_-]{16,128}$/.test(key),
          400,
          'A valid requestKey is required.',
        );
        requireThat(
          kind === 'adjustment' || amount > 0,
          400,
          'This entry must be positive.',
        );
        const previous = db
          .prepare('SELECT * FROM invoice_entries WHERE invoice_id=? AND request_key=?')
          .get(row.id, key);
        if (previous) {
          requireThat(
            previous.kind === kind &&
              previous.amount_cents === amount &&
              previous.reference === reference &&
              previous.reason === reason,
            409,
            'Request key was already used for a different entry.',
          );
          return invoiceView(row, user);
        }
        requireThat(
          data.version === row.version,
          409,
          'Invoice changed. Refresh before posting.',
        );
        const view = invoiceView(row, user);
        requireThat(
          kind !== 'payment' || amount <= view.dueCents,
          409,
          'Payment exceeds the outstanding balance.',
        );
        requireThat(
          kind !== 'refund' || amount <= view.paidCents,
          409,
          'Refund exceeds payments received.',
        );
        requireThat(
          kind !== 'adjustment' || view.totalCents + amount >= view.paidCents,
          409,
          'Adjustment would reduce the total below payments received.',
        );
        requireThat(
          kind !== 'payout' || amount <= view.rateCents - view.payoutCents,
          409,
          'Payout exceeds the agreed driver rate.',
        );
        requireThat(
          kind !== 'payoutRefund' || amount <= view.payoutCents,
          409,
          'Payout reversal exceeds payouts recorded.',
        );
        db.prepare('INSERT INTO invoice_entries VALUES (?,?,?,?,?,?,?,?,?)').run(
          randomUUID(),
          row.id,
          key,
          kind,
          amount,
          reference,
          reason,
          user.id,
          timestamp(),
        );
        db.prepare('UPDATE invoices SET version=version+1 WHERE id=?').run(row.id);
        const s = shipments(user, row.shipment_id, false)[0];
        audit(s, user, `Financial entry recorded: ${kind}`);
        return invoiceView(
          db.prepare('SELECT * FROM invoices WHERE id=?').get(row.id),
          user,
        );
      });
      send(res, 200, result);
      return true;
    }
    if (path === '/api/reports' && req.method === 'GET') {
      admin();
      const all = shipments(user).filter(
        (s) =>
          (!url.searchParams.get('from') || s.date >= url.searchParams.get('from')) &&
          (!url.searchParams.get('to') || s.date <= url.searchParams.get('to')) &&
          (!url.searchParams.get('customer') ||
            s.storeId === url.searchParams.get('customer')) &&
          (!url.searchParams.get('driver') ||
            s.driverId === url.searchParams.get('driver')) &&
          (!url.searchParams.get('status') ||
            s.status === url.searchParams.get('status')),
      );
      const ids = new Set(all.map((s) => s.id));
      const bills = invoices(user).filter((i) => ids.has(i.shipmentId));
      const result = {
        shipments: all,
        summary: {
          total: all.length,
          outstanding: all.filter(
            (s) => !['Delivered', 'Returned', 'Cancelled'].includes(s.status),
          ).length,
          exceptions: all.filter(
            (s) => (s.issue && !s.issue.resolved) || s.status === 'Delivery failed',
          ).length,
          invoiceCents: bills.reduce((n, i) => n + i.totalCents, 0),
          receivableCents: bills.reduce((n, i) => n + i.dueCents, 0),
          payoutCents: bills.reduce((n, i) => n + i.payoutCents, 0),
        },
      };
      if (url.searchParams.get('format') === 'csv') {
        const escape = (value) =>
          `"${String(value ?? '')
            .replace(/^[=+@\-\t\r]/, "'$&")
            .replaceAll('"', '""')}"`;
        const fields = [
          'id',
          'date',
          'status',
          'customer',
          'driverName',
          'pickup',
          'destination',
          'price',
          'rate',
        ];
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="deliveries.csv"',
          'Cache-Control': 'no-store',
        });
        res.end(
          [
            fields.map(escape).join(','),
            ...all.map((s) => fields.map((key) => escape(s[key])).join(',')),
          ].join('\r\n'),
        );
      } else send(res, 200, result);
      return true;
    }
    return false;
  }
  return {
    route,
    expire,
    notifyShipment,
    notify,
    driverReview,
    withdrawOffers,
    processNotifications,
  };
}
