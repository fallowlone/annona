import { test, expect } from "bun:test";
import { isAllowed, handleRecommend } from "../src/bot/handlers";
import type { Dish, Offer } from "../src/types";
import type { Matcher } from "../src/matcher";

test("isAllowed enforces the whitelist", () => {
  expect(isAllowed(111, [111, 222])).toBe(true);
  expect(isAllowed(999, [111, 222])).toBe(false);
  expect(isAllowed(undefined, [111])).toBe(false);
});

test("handleRecommend formats the cheapest dish with its shopping list", async () => {
  const offers: Record<string, Offer> = {
    "сметана": { externalId: 1, store: "kaufland", storeName: "Kaufland", product: "Schmand",
      price: 0.99, oldPrice: null, referencePrice: 0.99, unit: "St", validFrom: "", validTo: "" },
    "картофель": { externalId: 2, store: "aldi", storeName: "Aldi", product: "Kartoffeln 2,5kg",
      price: 1.99, oldPrice: null, referencePrice: 0.8, unit: "kg", validFrom: "", validTo: "" },
  };
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient(c) { return offers[c] ?? null; },
  };
  const dishes: Dish[] = [{
    nameRu: "Картофельное пюре", nameUa: null, nameDe: null, cuisine: "ru", tags: [], servings: 4,
    ingredients: [{ canonical: "картофель", qty: 1, unit: "кг" }, { canonical: "сметана", qty: 1, unit: "уп" }],
  }];
  const text = await handleRecommend({ dishes, matcher });
  expect(text).toContain("Картофельное пюре");
  expect(text).toContain("Kaufland");
  expect(text).toContain("Aldi");
  expect(text).toContain("Schmand");
});

test("handleRecommend respects topN parameter", async () => {
  const offers: Record<string, Offer> = {
    "помидор": { externalId: 1, store: "kaufland", storeName: "Kaufland", product: "Tomatoes",
      price: 1.99, oldPrice: null, referencePrice: 1.99, unit: "kg", validFrom: "", validTo: "" },
    "огурец": { externalId: 2, store: "aldi", storeName: "Aldi", product: "Cucumbers",
      price: 0.99, oldPrice: null, referencePrice: 0.99, unit: "kg", validFrom: "", validTo: "" },
    "лук": { externalId: 3, store: "metro", storeName: "Metro", product: "Onions",
      price: 0.49, oldPrice: null, referencePrice: 0.49, unit: "kg", validFrom: "", validTo: "" },
  };
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient(c) { return offers[c] ?? null; },
  };
  const dishes: Dish[] = [
    {
      nameRu: "Салат", nameUa: null, nameDe: null, cuisine: "ru", tags: [], servings: 2,
      ingredients: [{ canonical: "помидор", qty: 2, unit: "шт" }, { canonical: "огурец", qty: 1, unit: "шт" }],
    },
    {
      nameRu: "Суп", nameUa: null, nameDe: null, cuisine: "ru", tags: [], servings: 4,
      ingredients: [{ canonical: "лук", qty: 1, unit: "шт" }],
    },
  ];
  const text = await handleRecommend({ dishes, matcher, topN: 1 });
  expect(text).toContain("Салат");
  expect(text).not.toContain("Суп");
});

test("handleRecommend with no offers returns fallback message", async () => {
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient() { return null; },
  };
  const dishes: Dish[] = [{
    nameRu: "Борщ", nameUa: null, nameDe: null, cuisine: "ru", tags: [], servings: 4,
    ingredients: [{ canonical: "свекла", qty: 1, unit: "кг" }, { canonical: "капуста", qty: 1, unit: "кг" }],
  }];
  const text = await handleRecommend({ dishes, matcher });
  expect(text).toContain("На этой неделе выгодных совпадений по акциям не нашёл");
  expect(text).not.toEqual("");
});
