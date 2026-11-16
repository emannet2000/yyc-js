export const prePickup = [
  'Awaiting quote',
  'Quote ready',
  'Ready to assign',
  'Offered',
  'Assigned',
];
export const cargoStates = ['In transit', 'Delivery failed', 'Returning'];
export function calendarMinutes(date, clock = '00:00') {
  return Date.parse(`${date}T${clock}:00Z`) / 60000;
}
export function reservation(job) {
  const start =
    job.window === '13:00–16:00'
      ? '13:00'
      : job.window === '09:00–12:00'
        ? '09:00'
        : '00:00';
  const base = calendarMinutes(job.date, start);
  const end = base + (start === '00:00' ? 1440 : 180);
  return [
    base,
    Math.max(end, base + (job.estimatedMinutes || 0)) + (job.travelBufferMinutes || 0),
  ];
}
export function validDeadline(
  date,
  window,
  deadline,
  estimatedMinutes = 0,
  travelBufferMinutes = 0,
) {
  if (!deadline) return true;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(deadline)) return false;
  const parsed = new Date(`${deadline}:00Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 16) === deadline &&
    parsed.getTime() / 60000 >=
      reservation({ date, window, estimatedMinutes, travelBufferMinutes })[1]
  );
}
