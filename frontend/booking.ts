import { api } from './api';
import type { Payload } from './types';

const pending = new Map<string, string>();

// Keep uncertain submissions across a reload, scoped to the signed-in account
// and exact payload. A changed booking is a new request; an intentional repeat
// becomes a new request only after the previous response was acknowledged.
export async function createBooking(
  userId: string,
  data: Payload,
): Promise<{ id: string }> {
  const fingerprint = JSON.stringify(
    Object.fromEntries(
      Object.keys(data)
        .sort()
        .map((key) => [key, data[key]]),
    ),
  );
  const storageKey = `yyc.pending-booking:${userId}:${fingerprint}`;
  let key = pending.get(storageKey);
  if (!key) {
    try {
      key = sessionStorage.getItem(storageKey) || undefined;
    } catch {
      /* Storage may be disabled. */
    }
    key ||= crypto.randomUUID();
    pending.set(storageKey, key);
    try {
      sessionStorage.setItem(storageKey, key);
    } catch {
      /* In-memory retries still work. */
    }
  }
  const result = await api<{ id: string }>('/api/shipments', 'POST', data, {
    idempotencyKey: key,
  });
  if (!result || typeof result.id !== 'string')
    throw new Error('The server did not confirm the booking. Retry the same request.');
  pending.delete(storageKey);
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    /* Storage may be disabled. */
  }
  return result;
}
