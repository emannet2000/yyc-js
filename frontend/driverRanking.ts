// Orders candidate drivers for a job. Pure so the rules can be tested.
// Order: available drivers first, then the smallest truck that still fits the
// load (keeps larger trucks free), then the driver with fewer active jobs.
export interface DriverCandidate {
  id: string;
  blocked: boolean;
  // Kilograms of truck capacity left after this job; null when unknown.
  spareKg: number | null;
  activeJobs: number;
}

const big = Number.MAX_SAFE_INTEGER;

export function rankDrivers<T extends DriverCandidate>(list: T[]): T[] {
  return [...list].sort(
    (a, b) =>
      Number(a.blocked) - Number(b.blocked) ||
      (a.spareKg ?? big) - (b.spareKg ?? big) ||
      a.activeJobs - b.activeJobs ||
      a.id.localeCompare(b.id),
  );
}

export function fitNote(c: DriverCandidate): string {
  const spare =
    c.spareKg == null ? 'capacity unknown' : `${Math.round(c.spareKg)} kg to spare`;
  const jobs = c.activeJobs === 1 ? '1 active job' : `${c.activeJobs} active jobs`;
  return `${spare} · ${jobs}`;
}
