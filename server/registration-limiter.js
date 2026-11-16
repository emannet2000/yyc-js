// Registration limits apply across account names so inventing emails cannot
// bypass them. Concurrency also bounds the number of expensive password hashes.
export function createRegistrationLimiter({ now = Date.now } = {}) {
  const attempts = new Map();
  let active = 0;
  return {
    reserve(address) {
      const time = now();
      for (const [key, record] of attempts)
        if (record.until <= time) attempts.delete(key);
      const record = attempts.get(address) || { count: 0, until: time + 15 * 60_000 };
      if (record.count >= 20 || active >= 4) return null;
      if (!attempts.has(address) && attempts.size >= 10_000) return null;
      record.count++;
      attempts.set(address, record);
      active++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          active--;
        }
      };
    },
  };
}
