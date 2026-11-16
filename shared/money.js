/** Accept positive amounts that round-trip through safe integer cents. @param {unknown} value */
export function isPositiveMoney(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return false;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) && cents > 0 && value === cents / 100;
}
