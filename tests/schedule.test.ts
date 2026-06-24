import { test, expect } from "bun:test";
import { msUntilNext } from "../src/schedule";

const WEEK = 7 * 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
// Derive "our" 1=Mon..7=Sun weekday from a Date so assertions don't depend on
// which weekday the literal date happens to be.
const ourDow = (d: Date): number => (d.getDay() === 0 ? 7 : d.getDay());

test("msUntilNext schedules later the same day when the target hour is still ahead", () => {
  const now = new Date("2026-06-22T08:30:00");
  expect(msUntilNext(now, ourDow(now), 9)).toBe(30 * 60 * 1000); // 08:30 → 09:00
});

test("msUntilNext rolls to next week when today's target hour has passed", () => {
  const now = new Date("2026-06-22T10:00:00");
  expect(msUntilNext(now, ourDow(now), 9)).toBe(WEEK - HOUR); // 09:00 already gone today
});

test("msUntilNext is always within (0, 7 days] for any weekday", () => {
  const now = new Date("2026-06-22T10:00:00");
  for (let dow = 1; dow <= 7; dow++) {
    const ms = msUntilNext(now, dow, 9);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(WEEK);
  }
});
