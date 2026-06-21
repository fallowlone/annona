import type { Dish, Offer, RankedDish, ShoppingItem } from "./types";
import { effectiveUnitPrice } from "./normalize";

export function rankDishes(
  dishes: Dish[],
  matches: Map<string, Offer | null>
): RankedDish[] {
  const ranked: RankedDish[] = dishes.map((dish) => {
    let onOfferCount = 0;
    let estTotal = 0;
    for (const ing of dish.ingredients) {
      const m = matches.get(ing.canonical);
      if (m) {
        onOfferCount++;
        estTotal += effectiveUnitPrice(m);
      }
    }
    return { dish, onOfferCount, estTotal };
  });
  return ranked.sort((a, b) =>
    b.onOfferCount - a.onOfferCount || a.estTotal - b.estTotal
  );
}

export function buildShoppingList(
  dish: Dish,
  matches: Map<string, Offer | null>
): ShoppingItem[] {
  const items: ShoppingItem[] = [];
  for (const ing of dish.ingredients) {
    const m = matches.get(ing.canonical);
    if (m) {
      items.push({
        ingredient: ing.canonical,
        store: m.storeName,
        product: m.product,
        price: effectiveUnitPrice(m),
      });
    }
  }
  return items;
}
