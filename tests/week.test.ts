import { test, expect } from "bun:test";
import { isoWeek } from "../src/util/week";

test("isoWeek formats ISO year-week", () => {
  expect(isoWeek(new Date("2026-06-21T12:00:00Z"))).toMatch(/^\d{4}-W\d{2}$/);
  expect(isoWeek(new Date("2026-01-01T12:00:00Z"))).toBe("2026-W01");
});

test("isoWeek zero-pads single-digit week numbers", () => {
  // 2026-01-05 is a Monday — still W02 (first full week)? No: Jan 5 2026 is Monday.
  // Jan 1 = Thu (W01), Jan 5 = Mon (W02)
  expect(isoWeek(new Date("2026-01-05T12:00:00Z"))).toBe("2026-W02");
  // Confirm W01 is padded (not "W1")
  expect(isoWeek(new Date("2026-01-01T12:00:00Z"))).toMatch(/W0\d$/);
});

test("isoWeek handles year-boundary: Dec 28 belongs to its own year's last week", () => {
  // Dec 28, 2026 is a Monday. The ISO week containing it: week starts Mon Dec 28.
  // Dec 31 is a Thursday — that week's Thursday is in 2026, so it's 2026-W53? No:
  // ISO 8601: a week belongs to the year that contains its Thursday.
  // Dec 31, 2026 is a Thursday → 2026. Count of weeks: last week of 2026.
  // Jan 1, 2026 = W01, so we count forward. 52 weeks × 7 = 364 days from Jan 1.
  // Jan 1 + 364 = Dec 31, 2026 (same Thursday offset) → W53? Let's check:
  // Actually: 2026 starts on Thursday (Jan 1). ISO week 1 starts Mon Dec 29, 2025.
  // Wait — Jan 1 2026 IS W01 (brief confirms). The algorithm places it in W01.
  // Dec 28 2026 (Mon): its Thursday is Dec 31 2026 → year 2026 → count weeks.
  // From yearStart (Jan 1 2026, UTC), d is set to Dec 31 (Thursday).
  // (Dec 31 - Jan 1) / 86400000 = 364 days. Math.ceil((364+1)/7) = Math.ceil(365/7) = Math.ceil(52.14) = 53.
  // So Dec 28, 2026 should be 2026-W53.
  expect(isoWeek(new Date("2026-12-28T12:00:00Z"))).toBe("2026-W53");
});

test("isoWeek handles year-boundary: early Jan that belongs to previous year's last week", () => {
  // Jan 1, 2016 is a Friday. Its Thursday is Dec 31, 2015 → belongs to 2015.
  // So Jan 1 2016 should be 2015-W53.
  expect(isoWeek(new Date("2016-01-01T12:00:00Z"))).toBe("2015-W53");
});
