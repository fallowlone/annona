import type { Dish, Offer } from "./types";
import type { Matcher } from "./matcher";

/** Sum the winning sale-offer shelf prices for a dish's ingredients (unmatched = 0). */
export function dishCostFromMatches(dish: Dish, matches: Map<string, Offer | null>): number {
  let total = 0;
  for (const ing of dish.ingredients) {
    const m = matches.get(ing.canonical);
    if (m) total += m.price;
  }
  return total;
}

/** Estimate a dish's cost "по акциям" by matching each ingredient via the matcher (cache-warm). */
export async function estimateDishCost(matcher: Matcher, dish: Dish): Promise<number> {
  const matches = new Map<string, Offer | null>();
  for (const ing of dish.ingredients) {
    if (!matches.has(ing.canonical)) {
      matches.set(ing.canonical, await matcher.matchIngredient(ing.canonical));
    }
  }
  return dishCostFromMatches(dish, matches);
}
