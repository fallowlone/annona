/**
 * Milliseconds from `now` until the next occurrence of weekday `dow`
 * (1=Mon … 7=Sun) at `hour`:00 local time. If that moment is today and still
 * ahead, it fires today; otherwise it rolls forward (up to a full week).
 */
export function msUntilNext(now: Date, dow: number, hour: number): number {
  const jsTarget = dow % 7; // our 1..7 (Sun=7) → JS 0..6 (Sun=0)
  const candidate = new Date(now);
  candidate.setHours(hour, 0, 0, 0);
  const daysAhead = (jsTarget - now.getDay() + 7) % 7;
  candidate.setDate(candidate.getDate() + daysAhead);
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 7);
  return candidate.getTime() - now.getTime();
}
