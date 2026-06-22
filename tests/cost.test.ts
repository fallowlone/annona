import { test, expect } from "bun:test";
import { dishCostFromMatches, estimateDishCost } from "../src/cost";
import type { Dish, Offer } from "../src/types";
import type { Matcher } from "../src/matcher";

const offer = (price: number): Offer => ({
  externalId: 1, store: "aldi", storeName: "Aldi", product: "x",
  price, oldPrice: null, referencePrice: null, unit: "kg", validFrom: "", validTo: "",
});

const dish: Dish = {
  nameRu: "Борщ", nameUa: null, nameDe: null, cuisine: "ua", course: "first",
  keepsDays: 4, tags: [], servings: 4,
  ingredients: [{ canonical: "свёкла", qty: 1, unit: "кг" }, { canonical: "капуста", qty: 1, unit: "кг" }],
};

test("dishCostFromMatches sums matched offer prices, ignores unmatched", () => {
  const matches = new Map<string, Offer | null>([
    ["свёкла", offer(0.99)],
    ["капуста", null],
  ]);
  expect(dishCostFromMatches(dish, matches)).toBeCloseTo(0.99);
});

test("estimateDishCost matches each ingredient and sums", async () => {
  const prices: Record<string, number> = { "свёкла": 0.99, "капуста": 1.49 };
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient(c) { return c in prices ? offer(prices[c]!) : null; },
  };
  expect(await estimateDishCost(matcher, dish)).toBeCloseTo(2.48);
});
