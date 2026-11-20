// Bounds shipment creation rate per authenticated store user.
export function createShipmentLimiter({ now = Date.now } = {}) {
  const windows = new Map();
  return {
    check(userId) {
      const time = now();
      for (const [key, record] of windows)
        if (record.until <= time) windows.delete(key);
      const record = windows.get(userId) || { count: 0, until: time + 10 * 60_000 };
      if (record.count >= 50) return false;
      if (!windows.has(userId) && windows.size >= 10_000) return false;
      record.count++;
      windows.set(userId, record);
      return true;
    },
  };
}
