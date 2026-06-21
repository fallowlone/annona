import type { Dish, Offer, RankedDish, ShoppingItem } from "./types";

// We surface the package price (`Offer.price`) here — the shelf price the family
// actually pays — NOT `effectiveUnitPrice` (`referencePrice ?? price`). marktguru's
// `referencePrice` is a Grundpreis (e.g. €/kg), useful for the Matcher's
// cheapest-per-unit comparison but wrong for a shopping-list total. So estTotal is
// the rough sum of shelf prices and ShoppingItem.price is the shelf price.

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
        estTotal += m.price;
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
        price: m.price,
      });
    }
  }
  return items;
}
