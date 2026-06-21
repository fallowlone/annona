import type { Dish, GroupedShoppingList, StoreGroup } from "./types";
import type { Matcher } from "./matcher";
import { canonicalStore, mapsLink, type StoreKey } from "./stores";

/**
 * Aggregate the DISTINCT canonical ingredients of all dishes, match each to its
 * cheapest whitelist offer, and group by store with an Apple Maps link. Ingredients
 * with no whitelist offer go under `missing`.
 */
export async function buildGroupedList(
  dishes: Dish[],
  matcher: Matcher,
  plz: number
): Promise<GroupedShoppingList> {
  const canonicals = [
    ...new Set(dishes.flatMap((d) => d.ingredients.map((i) => i.canonical))),
  ];
  const groups = new Map<StoreKey, StoreGroup>();
  const missing: string[] = [];

  for (const c of canonicals) {
    const offer = await matcher.matchIngredient(c);
    const key = offer ? (canonicalStore(offer.store) ?? canonicalStore(offer.storeName)) : null;
    if (!offer || key === null) {
      missing.push(c);
      continue;
    }
    let group = groups.get(key);
    if (!group) {
      group = { store: key, storeName: offer.storeName, mapsUrl: mapsLink(key, plz), items: [] };
      groups.set(key, group);
    }
    group.items.push({ ingredient: c, product: offer.product, price: offer.price });
  }

  return { groups: [...groups.values()], missing };
}
