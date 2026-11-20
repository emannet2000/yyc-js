// Bounds evidence upload throughput per authenticated user.
export function createEvidenceLimiter({ now = Date.now } = {}) {
  const windows = new Map();
  return {
    check(userId) {
      const time = now();
      for (const [key, record] of windows)
        if (record.until <= time) windows.delete(key);
      const record = windows.get(userId) || { count: 0, until: time + 5 * 60_000 };
      if (record.count >= 30) return false;
      if (!windows.has(userId) && windows.size >= 10_000) return false;
      record.count++;
      windows.set(userId, record);
      return true;
    },
  };
}
