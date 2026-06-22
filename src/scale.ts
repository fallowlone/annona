import type { Ingredient } from "./types";

/** Round a scaled quantity: integers at >= 10, one decimal below. */
function roundQty(value: number): number {
  return value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
}

/**
 * Scale ingredient quantities from `baseServings` to `targetServings`.
 * `qty === null` (по вкусу) is preserved. A non-positive base is a no-op guard
 * against divide-by-zero. Pure: returns a new array of new objects.
 */
export function scaleIngredients(
  ingredients: Ingredient[],
  baseServings: number,
  targetServings: number
): Ingredient[] {
  if (baseServings <= 0) return ingredients.map((i) => ({ ...i }));
  const factor = targetServings / baseServings;
  return ingredients.map((i) => ({
    ...i,
    qty: i.qty === null ? null : roundQty(i.qty * factor),
  }));
}
