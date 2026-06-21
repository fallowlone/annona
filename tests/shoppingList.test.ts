import { test, expect } from "bun:test";
import { buildGroupedList } from "../src/shoppingList";
import type { Dish, Offer } from "../src/types";
import type { Matcher } from "../src/matcher";

const offer = (over: Partial<Offer>): Offer => ({
  externalId: 1, store: "aldi", storeName: "Aldi", product: "X", price: 1,
  oldPrice: null, referencePrice: null, unit: "St", validFrom: "", validTo: "", ...over,
});

const dish = (ings: string[]): Dish => ({
  nameRu: "D", nameUa: null, nameDe: null, cuisine: "ru", course: "second", keepsDays: 1,
  tags: [], servings: 4, ingredients: ings.map((c) => ({ canonical: c, qty: 1, unit: "шт" })),
});

test("buildGroupedList groups matched ingredients by store with a maps link", async () => {
  const offers: Record<string, Offer> = {
    "картофель": offer({ store: "aldi-nord", storeName: "Aldi Nord", product: "Kartoffeln", price: 1.99 }),
    "сметана": offer({ store: "kaufland", storeName: "Kaufland", product: "Schmand", price: 0.99 }),
    "лук": offer({ store: "aldi", storeName: "Aldi", product: "Zwiebeln", price: 0.5 }),
  };
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient(c) { return offers[c] ?? null; },
  };
  const list = await buildGroupedList([dish(["картофель", "сметана", "лук"])], matcher, 30459);
  const aldi = list.groups.find((g) => g.store === "aldi");
  const kauf = list.groups.find((g) => g.store === "kaufland");
  expect(aldi!.items.map((i) => i.ingredient).sort()).toEqual(["картофель", "лук"]);
  expect(kauf!.items.map((i) => i.ingredient)).toEqual(["сметана"]);
  expect(aldi!.mapsUrl).toBe("https://maps.apple.com/?q=Aldi%2030459");
  expect(list.missing).toEqual([]);
});

test("buildGroupedList puts ingredients with no offer under missing", async () => {
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient(c) { return c === "лук" ? offer({ store: "aldi", storeName: "Aldi" }) : null; },
  };
  const list = await buildGroupedList([dish(["лук", "укроп"])], matcher, 30459);
  expect(list.missing).toEqual(["укроп"]);
  expect(list.groups.flatMap((g) => g.items.map((i) => i.ingredient))).toEqual(["лук"]);
});

test("buildGroupedList deduplicates ingredients shared across dishes", async () => {
  let calls = 0;
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient() { calls++; return offer({ store: "aldi", storeName: "Aldi" }); },
  };
  await buildGroupedList([dish(["лук"]), dish(["лук"])], matcher, 30459);
  expect(calls).toBe(1); // "лук" matched once, not twice
});
