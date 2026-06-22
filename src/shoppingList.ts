import type { Dish, GroupedShoppingList, StoreGroup } from "./types";
import type { Matcher } from "./matcher";
import { canonicalStore, mapsLink, type StoreKey } from "./stores";
import { scaleIngredients } from "./scale";

type Bucket = { unit: string | null; qty: number | null };

/**
 * Aggregate the ingredients of all dishes — each scaled to `targetServings` —
 * match each canonical to its cheapest whitelist offer, and group by store with
 * an Apple Maps link. Quantities of the same ingredient are summed only when the
 * unit matches; mismatched units stay on separate lines. Ingredients with no
 * whitelist offer go under `missing`. When `targetServings` is omitted, each dish
 * keeps its own servings (no scaling).
 */
export async function buildGroupedList(
  dishes: Dish[],
  matcher: Matcher,
  plz: number,
  targetServings?: number
): Promise<GroupedShoppingList> {
  // canonical → unit → summed scaled qty. Insertion order is preserved.
  const agg = new Map<string, Map<string, Bucket>>();
  for (const dish of dishes) {
    const scaled = scaleIngredients(dish.ingredients, dish.servings, targetServings ?? dish.servings);
    for (const ing of scaled) {
      let byUnit = agg.get(ing.canonical);
      if (!byUnit) {
        byUnit = new Map();
        agg.set(ing.canonical, byUnit);
      }
      const unitKey = ing.unit ?? "";
      const bucket = byUnit.get(unitKey) ?? { unit: ing.unit, qty: null };
      if (ing.qty !== null) bucket.qty = (bucket.qty ?? 0) + ing.qty;
      byUnit.set(unitKey, bucket);
    }
  }

  const groups = new Map<StoreKey, StoreGroup>();
  const missing: string[] = [];

  for (const [canonical, byUnit] of agg) {
    const offer = await matcher.matchIngredient(canonical);
    const key = offer ? (canonicalStore(offer.store) ?? canonicalStore(offer.storeName)) : null;
    if (!offer || key === null) {
      missing.push(canonical);
      continue;
    }
    let group = groups.get(key);
    if (!group) {
      group = { store: key, storeName: offer.storeName, mapsUrl: mapsLink(key, plz), items: [] };
      groups.set(key, group);
    }
    for (const bucket of byUnit.values()) {
      group.items.push({
        ingredient: canonical,
        product: offer.product,
        price: offer.price,
        qty: bucket.qty,
        unit: bucket.unit,
      });
    }
  }

  return { groups: [...groups.values()], missing };
}
