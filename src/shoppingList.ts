import type { Dish, GroupedShoppingList, StoreGroup } from "./types";
import type { Matcher } from "./matcher";
import { canonicalStore, mapsLink, type StoreKey } from "./stores";
import { scaleIngredients } from "./scale";
import { unitInfo, displayBaseQty, type Dim } from "./units";
import { normalizePantryItem } from "./recipes/pantryStore";

// For a convertible unit, `qty` accumulates in base units (g/ml) under a shared
// `dim` so e.g. "0.5 кг" + "300 г" merge; for a count/opaque unit, `dim` is null
// and `qty` sums only the same raw `unit`.
type Bucket = { dim: Dim | null; unit: string | null; qty: number | null };

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
  targetServings?: number,
  pantry?: Set<string>
): Promise<GroupedShoppingList> {
  // canonical → unit → summed scaled qty. Insertion order is preserved.
  const agg = new Map<string, Map<string, Bucket>>();
  const inPantrySeen = new Map<string, string>(); // normalized → original casing (distinct)
  for (const dish of dishes) {
    const scaled = scaleIngredients(dish.ingredients, dish.servings, targetServings ?? dish.servings);
    for (const ing of scaled) {
      const norm = normalizePantryItem(ing.canonical);
      if (pantry && pantry.has(norm)) {
        if (!inPantrySeen.has(norm)) inPantrySeen.set(norm, ing.canonical);
        continue;
      }
      let byUnit = agg.get(ing.canonical);
      if (!byUnit) {
        byUnit = new Map();
        agg.set(ing.canonical, byUnit);
      }
      // Convertible units share one bucket per dimension (summed in base units);
      // everything else buckets by its raw unit string.
      const info = ing.qty !== null ? unitInfo(ing.unit) : null;
      const key = info ? `dim:${info.dim}` : `unit:${ing.unit ?? ""}`;
      const bucket = byUnit.get(key) ?? { dim: info?.dim ?? null, unit: ing.unit, qty: null };
      if (ing.qty !== null) bucket.qty = (bucket.qty ?? 0) + (info ? ing.qty * info.per : ing.qty);
      byUnit.set(key, bucket);
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
      const display =
        bucket.dim !== null && bucket.qty !== null
          ? displayBaseQty(bucket.qty, bucket.dim)
          : { qty: bucket.qty, unit: bucket.unit };
      group.items.push({
        ingredient: canonical,
        product: offer.product,
        price: offer.price,
        qty: display.qty,
        unit: display.unit,
      });
    }
  }

  return { groups: [...groups.values()], missing, inPantry: [...inPantrySeen.values()] };
}
