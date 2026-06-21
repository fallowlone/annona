import { test, expect } from "bun:test";
import { openDb } from "../src/db/db";
import { insertDish, listDishes, getIngredients, seedDishes, DishSeedSchema } from "../src/recipes/recipeStore";
import type { Dish } from "../src/types";
import type { Llm } from "../src/llm/llm";

const borscht: Dish = {
  nameRu: "Борщ", nameUa: "Борщ", nameDe: "Borschtsch", cuisine: "ua",
  tags: ["soup"], servings: 4,
  ingredients: [
    { canonical: "свёкла", qty: 2, unit: "шт" },
    { canonical: "капуста", qty: 0.3, unit: "кг" },
    { canonical: "сметана", qty: 1, unit: "уп" },
  ],
};

const pelmeni: Dish = {
  nameRu: "Пельмени", nameUa: "Вареники", nameDe: "Pelmeni", cuisine: "ru",
  tags: ["main"], servings: 2,
  ingredients: [
    { canonical: "фарш", qty: 0.5, unit: "кг" },
    { canonical: "мука", qty: 0.3, unit: "кг" },
  ],
};

test("insertDish + listDishes roundtrip with ingredients", () => {
  const db = openDb(":memory:");
  const id = insertDish(db, borscht);
  expect(id).toBeGreaterThan(0);
  const all = listDishes(db);
  expect(all).toHaveLength(1);
  expect(all[0]!.nameRu).toBe("Борщ");
  expect(all[0]!.ingredients.map((i) => i.canonical)).toContain("сметана");
});

test("insertDish returns unique ids for multiple dishes", () => {
  const db = openDb(":memory:");
  const id1 = insertDish(db, borscht);
  const id2 = insertDish(db, pelmeni);
  expect(id1).toBeGreaterThan(0);
  expect(id2).toBeGreaterThan(id1);
});

test("listDishes returns all dishes with their ingredients", () => {
  const db = openDb(":memory:");
  insertDish(db, borscht);
  insertDish(db, pelmeni);
  const all = listDishes(db);
  expect(all).toHaveLength(2);
  const names = all.map((d) => d.nameRu);
  expect(names).toContain("Борщ");
  expect(names).toContain("Пельмени");
});

test("getIngredients returns a dish's ingredients", () => {
  const db = openDb(":memory:");
  const id = insertDish(db, borscht);
  const ings = getIngredients(db, id);
  expect(ings).toHaveLength(3);
  expect(ings.map((i) => i.canonical)).toContain("свёкла");
});

test("DishSeedSchema validates a well-formed LLM payload", () => {
  const parsed = DishSeedSchema.parse({ dishes: [borscht] });
  expect(parsed.dishes[0]!.ingredients).toHaveLength(3);
});

test("DishSeedSchema rejects payload with empty ingredients", () => {
  expect(() =>
    DishSeedSchema.parse({
      dishes: [{ ...borscht, ingredients: [] }],
    })
  ).toThrow();
});

test("seedDishes calls the injected Llm and inserts returned dishes", async () => {
  const db = openDb(":memory:");

  const fakeLlm: Llm = {
    structured: async () => ({
      dishes: [borscht, pelmeni],
    }),
  };

  const n = await seedDishes(db, fakeLlm, 2);
  expect(n).toBe(2);
  const all = listDishes(db);
  expect(all).toHaveLength(2);
  expect(all[0]!.nameRu).toBe("Борщ");
  expect(all[1]!.nameRu).toBe("Пельмени");
  expect(all[0]!.ingredients.map((i) => i.canonical)).toContain("свёкла");
  expect(all[1]!.ingredients.map((i) => i.canonical)).toContain("фарш");
});

test("seedDishes inserts all ingredients for seeded dishes", async () => {
  const db = openDb(":memory:");

  const fakeLlm: Llm = {
    structured: async () => ({ dishes: [borscht] }),
  };

  await seedDishes(db, fakeLlm, 1);
  const all = listDishes(db);
  expect(all[0]!.ingredients).toHaveLength(3);
});

test("transactional rollback: failed ingredient insert leaves no orphan dish", () => {
  const db = openDb(":memory:");
  db.run("DROP TABLE ingredients");
  expect(() => insertDish(db, borscht)).toThrow();
  const rows = db.query("SELECT * FROM dishes").all();
  expect(rows).toHaveLength(0);
});
