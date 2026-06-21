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

/** Lay out a `days`-day menu with a first and a second course each day. */
export function planWeek(firsts: Dish[], seconds: Dish[], days: number): WeeklyMenu {
  const f = fillCourse(firsts, days);
  const s = fillCourse(seconds, days);
  const out: MenuDay[] = [];
  for (let k = 0; k < days; k++) {
    out.push({ day: k + 1, first: f[k] ?? null, second: s[k] ?? null });
  }
  return { days: out };
}
