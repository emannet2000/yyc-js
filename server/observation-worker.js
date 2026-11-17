// SQLite sampling is synchronous; ticks cannot overlap within this process.
export function startObservationWorker({
  sample,
  intervalMs = 60000,
  onError = () => console.error('Scheduled metrics snapshot failed.'),
  schedule = setInterval,
  cancel = clearInterval,
}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 2147483647)
    throw new Error('Metrics sample interval must be an integer from 1000 to 2147483647 milliseconds.');
  let stopped = false;
  const collect = () => {
    if (stopped) return;
    try {
      sample();
    } catch {
      // Do not log database errors, paths, or incident details.
      onError();
    }
  };
  const timer = schedule(collect, intervalMs);
  timer.unref();
  collect();
  return () => {
    stopped = true;
    cancel(timer);
  };
}
