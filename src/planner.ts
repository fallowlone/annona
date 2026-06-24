import type { Dish, WeeklyMenu, MenuDay } from "./types";

/**
 * Fill `days` slots from `dishes`: each dish occupies max(1, keepsDays) consecutive
 * days before the next is used; cycle back to the first when the list is exhausted.
 * An empty list yields all-null.
 */
export function fillCourse(dishes: Dish[], days: number): (Dish | null)[] {
  if (dishes.length === 0) return Array.from({ length: days }, () => null);
  const out: (Dish | null)[] = [];
  let i = 0;
  let used = 0;
  while (out.length < days) {
    const dish = dishes[i % dishes.length]!;
    out.push(dish);
    used++;
    if (used >= Math.max(1, dish.keepsDays ?? 1)) {
      i++;
      used = 0;
    }
  }
  return out;
}

/** A dish pinned to a specific 1-based day; its course decides which slot. */
export type DayPin = { day: number; dish: Dish };

/**
 * Fill a course's week, honoring pins: a pinned day always shows its pinned dish,
 * and pinned dishes are excluded from the auto-fill pool so they don't also land
 * on other days. No pins → identical to `fillCourse`.
 */
function fillWithPins(pool: Dish[], days: number, pinned: Map<number, Dish>): (Dish | null)[] {
  if (pinned.size === 0) return fillCourse(pool, days);
  const pinnedIds = new Set([...pinned.values()].map((d) => d.id));
  const rest = pool.filter((d) => d.id === undefined || !pinnedIds.has(d.id));
  const auto = fillCourse(rest, days);
  return Array.from({ length: days }, (_, k) => pinned.get(k + 1) ?? auto[k] ?? null);
}

/** Lay out a `days`-day menu with a first and a second course each day. Pins
 *  override the auto layout for their day+course. */
export function planWeek(firsts: Dish[], seconds: Dish[], days: number, pins: DayPin[] = []): WeeklyMenu {
  const pinFirst = new Map<number, Dish>();
  const pinSecond = new Map<number, Dish>();
  for (const p of pins) {
    if (p.day < 1 || p.day > days) continue;
    (p.dish.course === "first" ? pinFirst : pinSecond).set(p.day, p.dish);
  }
  const f = fillWithPins(firsts, days, pinFirst);
  const s = fillWithPins(seconds, days, pinSecond);
  const out: MenuDay[] = [];
  for (let k = 0; k < days; k++) {
    out.push({ day: k + 1, first: f[k] ?? null, second: s[k] ?? null });
  }
  return { days: out };
}
