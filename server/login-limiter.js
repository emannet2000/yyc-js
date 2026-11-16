import { createHash } from 'node:crypto';

// A proxy or shared connection must not combine unrelated accounts' failures.
export function createLoginLimiter({ now = Date.now } = {}) {
  const attempts = new Map();
  const windowMs = 15 * 60_000;
  return {
    reserve(address, email) {
      const time = now();
      for (const [key, record] of attempts)
        if (record.until <= time) attempts.delete(key);
      const key = createHash('sha256')
        .update(JSON.stringify([address, email]))
        .digest('hex');
      const record = attempts.get(key) || { count: 0, until: time + windowMs };
      if (record.count >= 20) return null;
      // Bound memory when many distinct addresses/accounts are tried.
      if (!attempts.has(key) && attempts.size >= 10_000)
        attempts.delete(attempts.keys().next().value);
      record.count++;
      attempts.set(key, record);
      return key;
    },
    succeed(key) {
      attempts.delete(key);
    },
  };
}
