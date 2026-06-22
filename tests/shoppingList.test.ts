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

const dishOf = (servings: number, ings: { canonical: string; qty: number | null; unit: string | null }[]): Dish => ({
  nameRu: "D", nameUa: null, nameDe: null, cuisine: "ru", course: "second", keepsDays: 1,
  tags: [], servings, ingredients: ings,
});

const oneOffer: Matcher = {
  async searchTerms() { return []; },
  async matchIngredient(c) { return offer({ store: "aldi", storeName: "Aldi", product: c }); },
};

test("buildGroupedList sums quantities of the same ingredient+unit across dishes", async () => {
  const d1 = dishOf(4, [{ canonical: "лук", qty: 2, unit: "шт" }]);
  const d2 = dishOf(4, [{ canonical: "лук", qty: 1, unit: "шт" }]);
  const list = await buildGroupedList([d1, d2], oneOffer, 30459, 4); // target == base → no scaling
  const item = list.groups[0]!.items.find((i) => i.ingredient === "лук");
  expect(item).toMatchObject({ qty: 3, unit: "шт" });
});

test("buildGroupedList keeps mismatched units as separate lines", async () => {
  const d1 = dishOf(4, [{ canonical: "молоко", qty: 200, unit: "мл" }]);
  const d2 = dishOf(4, [{ canonical: "молоко", qty: 1, unit: "шт" }]);
  const list = await buildGroupedList([d1, d2], oneOffer, 30459, 4);
  const milk = list.groups[0]!.items.filter((i) => i.ingredient === "молоко");
  expect(milk).toHaveLength(2);
  expect(milk.map((i) => `${i.qty}${i.unit}`).sort()).toEqual(["1шт", "200мл"]);
});

test("buildGroupedList scales quantities to targetServings", async () => {
  const d1 = dishOf(4, [{ canonical: "рис", qty: 100, unit: "г" }]);
  const list = await buildGroupedList([d1], oneOffer, 30459, 8); // 4 → 8 doubles
  expect(list.groups[0]!.items[0]).toMatchObject({ qty: 200, unit: "г" });
});

test("buildGroupedList leaves a null-qty ingredient without a quantity", async () => {
  const d1 = dishOf(4, [{ canonical: "соль", qty: null, unit: null }]);
  const list = await buildGroupedList([d1], oneOffer, 30459, 8);
  expect(list.groups[0]!.items[0]).toMatchObject({ ingredient: "соль", qty: null });
});
