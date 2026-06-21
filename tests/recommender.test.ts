import { test, expect } from "bun:test";
import { rankDishes, buildShoppingList } from "../src/recommender";
import type { Dish, Offer } from "../src/types";

const offer = (over: Partial<Offer>): Offer => ({
  externalId: 1,
  store: "edeka",
  storeName: "Edeka",
  product: "X",
  price: 1,
  oldPrice: null,
  referencePrice: 1,
  unit: "St",
  validFrom: "2026-06-22",
  validTo: "2026-06-28",
  ...over,
});

const dish = (nameRu: string, ings: string[]): Dish => ({
  nameRu,
  nameUa: null,
  nameDe: null,
  cuisine: "ru",
  tags: [],
  servings: 4,
  ingredients: ings.map((c) => ({ canonical: c, qty: 1, unit: "шт" })),
});

test("rankDishes orders by on-offer count DESC", () => {
  const matches = new Map<string, Offer | null>([
    ["сметана", offer({ price: 1, storeName: "Kaufland", product: "Schmand" })],
    ["картофель", offer({ price: 2, storeName: "Aldi", product: "Kartoffeln" })],
    ["укроп", null],
  ]);
  const ranked = rankDishes(
    [
      dish("Окрошка", ["укроп"]),
      dish("Пюре", ["сметана", "картофель"]),
    ],
    matches
  );
  expect(ranked[0].dish.nameRu).toBe("Пюре");
  expect(ranked[0].onOfferCount).toBe(2);
  expect(ranked[1].dish.nameRu).toBe("Окрошка");
  expect(ranked[1].onOfferCount).toBe(0);
});

test("rankDishes tie-break by estTotal ASC", () => {
  const matches = new Map<string, Offer | null>([
    ["a", offer({ price: 5 })],
    ["b", offer({ price: 3 })],
    ["c", offer({ price: 2 })],
    ["d", offer({ price: 1 })],
  ]);
  const ranked = rankDishes(
    [
      dish("Expensive", ["a", "b"]), // 2 on offer, cost 8
      dish("Cheap", ["c", "d"]), // 2 on offer, cost 3
    ],
    matches
  );
  expect(ranked[0].dish.nameRu).toBe("Cheap");
  expect(ranked[0].onOfferCount).toBe(2);
  expect(ranked[0].estTotal).toBe(3);
  expect(ranked[1].dish.nameRu).toBe("Expensive");
  expect(ranked[1].estTotal).toBe(8);
});

test("rankDishes with a null match", () => {
  const matches = new Map<string, Offer | null>([
    ["сметана", offer({ price: 1 })],
    ["укроп", null],
  ]);
  const ranked = rankDishes([dish("X", ["сметана", "укроп"])], matches);
  expect(ranked[0].onOfferCount).toBe(1);
  expect(ranked[0].estTotal).toBe(1);
});

test("rankDishes estTotal uses price directly", () => {
  const matches = new Map<string, Offer | null>([
    [
      "масло",
      offer({
        price: 5,
        referencePrice: null, // no reference price
        storeName: "Kaufland",
      }),
    ],
  ]);
  const ranked = rankDishes([dish("X", ["масло"])], matches);
  expect(ranked[0].estTotal).toBe(5);
});

test("buildShoppingList creates items from matches", () => {
  const matches = new Map<string, Offer | null>([
    [
      "сметана",
      offer({
        storeName: "Kaufland",
        product: "Schmand",
        price: 0.99,
      }),
    ],
    ["укроп", null],
  ]);
  const list = buildShoppingList(dish("X", ["сметана", "укроп"]), matches);
  expect(list).toHaveLength(1);
  expect(list[0].ingredient).toBe("сметана");
  expect(list[0].store).toBe("Kaufland");
  expect(list[0].product).toBe("Schmand");
  expect(list[0].price).toBe(0.99);
});

test("rankDishes with empty dish list", () => {
  const matches = new Map<string, Offer | null>();
  const ranked = rankDishes([], matches);
  expect(ranked).toHaveLength(0);
});

test("rankDishes with a dish with no ingredients", () => {
  const matches = new Map<string, Offer | null>();
  const ranked = rankDishes([dish("Empty", [])], matches);
  expect(ranked).toHaveLength(1);
  expect(ranked[0].onOfferCount).toBe(0);
  expect(ranked[0].estTotal).toBe(0);
});
