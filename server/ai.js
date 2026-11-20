import Anthropic from '@anthropic-ai/sdk';

export function createAI({ claudeApiKey, db, now, log }) {
  if (!claudeApiKey) return null;

  const anthropic = new Anthropic({ apiKey: claudeApiKey });

  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_flags(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id TEXT NOT NULL REFERENCES shipments(id),
      flag_type TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('low','medium','high')),
      message TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '{}',
      acknowledged INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ai_flags_shipment ON ai_flags(shipment_id);
    CREATE INDEX IF NOT EXISTS ai_flags_ack ON ai_flags(acknowledged, created_at DESC);
  `);

  // ── Shared helpers ──────────────────────────────────────────────

  async function callClaude(params) {
    try {
      return await anthropic.messages.create(params);
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        log.warn('AI call failed', { status: err.status, message: err.message });
        return null;
      }
      throw err;
    }
  }

  function extractText(response) {
    if (!response) return null;
    for (const block of response.content)
      if (block.type === 'text') return block.text;
    return null;
  }

  function safeJsonParse(text, fallback) {
    if (!text) return fallback;
    const cleaned = text.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
    try { return JSON.parse(cleaned); } catch { return fallback; }
  }

  // ── Feature 1: Smart Booking Assistant ─────────────────────────

  const BOOKING_SYSTEM = `You are a delivery booking assistant for a trucking company in Edmonton, Alberta, Canada.
Extract structured booking information from free-text descriptions.

Extract only what is explicitly stated. Never invent or assume values.
Return a JSON object with any of these fields that are present:
{
  "pickup": "pickup address",
  "destination": "delivery address",
  "date": "YYYY-MM-DD (resolve relative dates using today's date provided in the user message)",
  "window": "one of: 09:00–12:00 | 13:00–16:00 | Flexible",
  "goods": "cargo description",
  "type": "one of: Box truck | Dry van",
  "kg": number (weight in kilograms),
  "pallets": integer (pallet count),
  "unloading": "one of: Store has a loading dock | Liftgate required",
  "pickupContact": "contact name or info at pickup location",
  "receivingContact": "contact name or info at delivery destination",
  "hours": "receiving hours at destination",
  "notes": "any additional delivery instructions"
}

Field extraction rules:
- Only include fields explicitly mentioned. Omit fields with no information in the text.
- window: morning/AM/before noon → "09:00–12:00"; afternoon/PM/after noon → "13:00–16:00"; anytime/flexible/any time → "Flexible"
- unloading: liftgate/lift gate/tailgate → "Liftgate required"; loading dock/dock door → "Store has a loading dock"
- type: if not mentioned, omit it. Only use "Box truck" or "Dry van".
- date: resolve relative references like "Friday", "next Tuesday", "tomorrow" using today's date.
- kg: if weight is given in lbs, convert to kg (1 lb = 0.453592 kg, round to nearest integer).
- pallets: must be a positive integer.

Return only valid JSON. No explanation text, no markdown code fences.`;

  async function parseBooking(text, todayDate) {
    const response = await callClaude({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: [{ type: 'text', text: BOOKING_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Today's date: ${todayDate}\n\nBooking description:\n${text}` }],
    });
    return safeJsonParse(extractText(response), {});
  }

  // ── Feature 2: Dispatch Recommendation ─────────────────────────

  const DISPATCH_SYSTEM = `You are a dispatch coordinator assistant for a trucking company.
Given a shipment's requirements and a list of available approved drivers, recommend the best driver.

Consider these factors in order of importance:
1. Truck type match (Box truck vs Dry van)
2. Liftgate availability when required
3. Cargo capacity (kg and pallets must fit)
4. Service area match
5. Current workload (fewer current assignments is better)

Return JSON in this exact shape:
{
  "driverId": "id of top recommended driver",
  "reason": "1-2 sentence explanation of why this driver is best for this shipment",
  "alternatives": [
    { "driverId": "...", "reason": "1 sentence explanation" }
  ]
}

Include up to 2 alternatives. If only one driver is suitable, return empty alternatives array.
Return only valid JSON. No markdown.`;

  async function recommendDispatch(shipment, availableDrivers) {
    if (!availableDrivers.length) return null;
    const driverSummaries = availableDrivers.map((d) => ({
      id: d.id,
      name: d.name,
      truckType: d.truck?.type,
      kg: d.truck?.kg,
      pallets: d.truck?.pallets,
      liftgate: d.truck?.liftgate,
      area: d.truck?.area,
    }));
    const shipmentContext = {
      pickup: shipment.pickup,
      destination: shipment.destination,
      date: shipment.date,
      window: shipment.window,
      kg: shipment.kg,
      pallets: shipment.pallets,
      type: shipment.type,
      unloading: shipment.unloading,
      goods: shipment.goods,
    };
    const response = await callClaude({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: [{ type: 'text', text: DISPATCH_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: `Shipment:\n${JSON.stringify(shipmentContext, null, 2)}\n\nAvailable drivers:\n${JSON.stringify(driverSummaries, null, 2)}`,
      }],
    });
    return safeJsonParse(extractText(response), null);
  }

  // ── Feature 3: Exception Resolution Suggestions ─────────────────

  const EXCEPTION_SYSTEM = `You are a delivery operations advisor for a trucking company.
When a shipment has a failed delivery or unresolved exception, suggest 2-3 concrete resolution options.

Return JSON:
{
  "suggestions": [
    {
      "action": "short action title (5 words or less)",
      "reason": "why this resolves the issue (1 sentence)",
      "detail": "specific instructions for the broker (1-2 sentences)"
    }
  ]
}

Base suggestions only on the data provided. Be specific and actionable.
Common actions include: schedule redelivery, arrange return to sender, contact recipient to confirm availability,
offer alternate delivery window, left-at-door waiver, escalate to customer service.
Return only valid JSON. No markdown.`;

  async function suggestExceptionResolution(shipment) {
    const context = {
      status: shipment.status,
      goods: shipment.goods,
      pickup: shipment.pickup,
      destination: shipment.destination,
      unloading: shipment.unloading,
      issue: shipment.issue || null,
      failedAttempts: shipment.failedAttempts || [],
      date: shipment.date,
      window: shipment.window,
      recentHistory: (shipment.history || []).slice(-5),
    };
    const response = await callClaude({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: [{ type: 'text', text: EXCEPTION_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Shipment exception details:\n${JSON.stringify(context, null, 2)}` }],
    });
    return safeJsonParse(extractText(response), null);
  }

  // ── Feature 4: Delivery Summary ─────────────────────────────────

  const SUMMARY_SYSTEM = `You are a customer-facing delivery operations narrator for a trucking company.
Write a clear, professional plain-English summary of a shipment's journey from booking to current state.

The summary should be 3-5 sentences covering: what was shipped, the route, key milestones
(quotation, dispatch, pickup, any issues or failed attempts, delivery outcome or current status).
Write as if explaining to the store owner who booked the delivery.
Do not include driver rates, internal IDs beyond the shipment ID, or sensitive operational details.
Use plain language. Return only the summary text — no headings, no bullet points, no markdown.`;

  async function summarizeShipment(shipment) {
    const context = {
      id: shipment.id,
      goods: shipment.goods,
      pickup: shipment.pickup,
      destination: shipment.destination,
      date: shipment.date,
      window: shipment.window,
      status: shipment.status,
      pallets: shipment.pallets,
      kg: shipment.kg,
      driverName: shipment.driverName,
      issue: shipment.issue || null,
      failedAttempts: shipment.failedAttempts || [],
      pod: shipment.pod || null,
      recipient: shipment.recipient || null,
      history: shipment.history || [],
    };
    const response = await callClaude({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system: [{ type: 'text', text: SUMMARY_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Shipment data:\n${JSON.stringify(context, null, 2)}` }],
    });
    return extractText(response);
  }

  // ── Feature 5: Anomaly Detection ───────────────────────────────

  const ANOMALY_SYSTEM = `You are a delivery operations anomaly detector for a trucking company.
Analyze shipment data and history for unusual patterns that warrant broker attention.

Look for:
- Multiple failed delivery attempts (more than 1)
- Delivery still "In transit" significantly past the scheduled window
- More than 3 status changes in a short period (possible routing issue)
- Issue reported but shipment still active without resolution after pickup

Return JSON:
{
  "anomalies": [
    {
      "type": "timing | attempts | pattern | exception",
      "severity": "low | medium | high",
      "message": "concise description of the anomaly (1 sentence)",
      "detail": "what specifically triggered this flag (1 sentence)"
    }
  ]
}

If nothing is anomalous, return: { "anomalies": [] }
Return only valid JSON. No markdown.`;

  async function detectAnomalies(shipment) {
    const context = {
      id: shipment.id,
      status: shipment.status,
      date: shipment.date,
      window: shipment.window,
      estimatedMinutes: shipment.estimatedMinutes || null,
      failedAttempts: shipment.failedAttempts || [],
      issue: shipment.issue || null,
      history: (shipment.history || []).map((h) => ({ text: h.text, time: h.time })),
    };
    const response = await callClaude({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: [{ type: 'text', text: ANOMALY_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: `Current time: ${new Date(now()).toISOString()}\nShipment data:\n${JSON.stringify(context, null, 2)}`,
      }],
    });
    const parsed = safeJsonParse(extractText(response), { anomalies: [] });
    return parsed.anomalies || [];
  }

  async function runAnomalyCheck(shipmentId, getShipment) {
    try {
      const shipment = getShipment(shipmentId);
      if (!shipment) return;
      const anomalies = await detectAnomalies(shipment);
      for (const a of anomalies) {
        db.prepare(
          `INSERT INTO ai_flags(shipment_id,flag_type,severity,message,details,created_at)
           VALUES (?,?,?,?,?,?)`,
        ).run(
          shipmentId,
          a.type || 'general',
          ['low', 'medium', 'high'].includes(a.severity) ? a.severity : 'low',
          String(a.message || '').slice(0, 500),
          JSON.stringify({ detail: a.detail }),
          new Date(now()).toISOString(),
        );
      }
      if (anomalies.length)
        log.info('AI anomaly flags stored', { shipmentId, count: anomalies.length });
    } catch (err) {
      log.warn('Anomaly check failed', { shipmentId, err: err?.message });
    }
  }

  // ── Feature 6: Recipient Notifications ─────────────────────────

  const NOTIFICATION_SYSTEM = `You are a friendly delivery status notification writer for a trucking service.
Write a 1-2 sentence recipient-facing status update. Tone: reassuring, clear, friendly.
Only state what is confirmed. Do not make promises about exact times unless an ETA is provided.
Do not mention driver names, internal reference numbers, company-internal details, or delivery rates.
Return only the message text — no greeting, no sign-off, no markdown.`;

  async function generateRecipientNotification(shipment, eventType) {
    const context = {
      status: shipment.status,
      date: shipment.date,
      window: shipment.window,
      goods: shipment.goods,
      eventType,
      failedAttempts: (shipment.failedAttempts || []).length,
      redeliveryPlan: shipment.redeliveryPlan || null,
    };
    const response = await callClaude({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: [{ type: 'text', text: NOTIFICATION_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: `Write a recipient notification for this delivery event:\n${JSON.stringify(context, null, 2)}`,
      }],
    });
    return extractText(response);
  }

  // ── HTTP Route Handler ──────────────────────────────────────────

  async function route(path, req, res, user, data, { send, requireThat, shipments, db: routeDb }) {
    if (path === '/api/ai/booking-parse' && req.method === 'POST') {
      requireThat(user.role === 'store', 403, 'Only stores can use booking assist.');
      const text = data.text;
      requireThat(
        typeof text === 'string' && text.length > 0 && text.length <= 2000,
        400,
        'text must be a non-empty string up to 2000 characters.',
      );
      const todayDate = new Date(now()).toISOString().slice(0, 10);
      const fields = await parseBooking(text, todayDate);
      send(res, 200, { fields });
      return true;
    }

    if (path === '/api/ai/dispatch-recommend' && req.method === 'POST') {
      requireThat(user.role === 'admin', 403, 'Broker access required.');
      requireThat(typeof data.shipmentId === 'string', 400, 'shipmentId required.');
      const [shipment] = shipments({ role: 'admin' }, data.shipmentId, false);
      requireThat(shipment, 404, 'Delivery not found.');
      const driverRows = routeDb.prepare(
        `SELECT u.*,t.id AS truck_id,t.type AS truck_type,t.kg AS truck_kg,
         t.pallets AS truck_pallets,t.liftgate AS truck_liftgate,t.profile AS truck_profile,
         t.approved AS truck_approved
         FROM users u LEFT JOIN trucks t ON t.driver_id=u.id
         WHERE u.role='driver' AND u.disabled=0 AND u.approved=1 AND t.approved=1`,
      ).all();
      const drivers = driverRows.map((d) => ({
        id: d.id,
        name: d.name,
        truck: d.truck_type ? {
          type: d.truck_type, kg: d.truck_kg, pallets: d.truck_pallets,
          liftgate: !!d.truck_liftgate, area: JSON.parse(d.truck_profile || '{}').area,
        } : null,
      }));
      const result = await recommendDispatch(shipment, drivers);
      requireThat(result, 503, 'AI recommendation unavailable. Try again.');
      send(res, 200, result);
      return true;
    }

    if (path === '/api/ai/exception-suggest' && req.method === 'POST') {
      requireThat(user.role === 'admin', 403, 'Broker access required.');
      requireThat(typeof data.shipmentId === 'string', 400, 'shipmentId required.');
      const [shipment] = shipments({ role: 'admin' }, data.shipmentId, true);
      requireThat(shipment, 404, 'Delivery not found.');
      requireThat(
        shipment.status === 'Delivery failed' || (shipment.issue && !shipment.issue.resolved),
        409,
        'No active exception to suggest resolution for.',
      );
      const result = await suggestExceptionResolution(shipment);
      requireThat(result, 503, 'AI suggestions unavailable. Try again.');
      send(res, 200, result);
      return true;
    }

    const summaryMatch = /^\/api\/ai\/shipment-summary\/([^/]+)$/.exec(path);
    if (summaryMatch && req.method === 'GET') {
      const [shipment] = shipments(user, summaryMatch[1], true);
      requireThat(shipment, 404, 'Delivery not found.');
      const summary = await summarizeShipment(shipment);
      requireThat(summary, 503, 'AI summary unavailable. Try again.');
      send(res, 200, { summary });
      return true;
    }

    if (path === '/api/ai/flags' && req.method === 'GET') {
      requireThat(user.role === 'admin', 403, 'Broker access required.');
      const flags = routeDb.prepare(
        `SELECT f.id,f.shipment_id,f.flag_type,f.severity,f.message,f.details,f.created_at,
         s.status AS shipment_status FROM ai_flags f
         JOIN shipments s ON s.id=f.shipment_id
         WHERE f.acknowledged=0 ORDER BY f.created_at DESC LIMIT 100`,
      ).all();
      send(res, 200, { flags });
      return true;
    }

    const ackMatch = /^\/api\/ai\/flags\/(\d+)\/acknowledge$/.exec(path);
    if (ackMatch && req.method === 'POST') {
      requireThat(user.role === 'admin', 403, 'Broker access required.');
      routeDb.prepare('UPDATE ai_flags SET acknowledged=1 WHERE id=?').run(Number(ackMatch[1]));
      send(res, 200, { ok: true });
      return true;
    }

    return false;
  }

  return { route, runAnomalyCheck, generateRecipientNotification };
}
