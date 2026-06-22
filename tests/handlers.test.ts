import { test, expect } from "bun:test";
import {
  isAllowed, handleRecommend, handleSelect, handleMenu, handleList,
  handleAddDishes, handleRemoveDishes, previewCustomDish, confirmCustomDish, handleScaleDish,
} from "../src/bot/handlers";
import type { Dish, Offer } from "../src/types";
import type { Matcher } from "../src/matcher";
import { openDb } from "../src/db/db";
import { insertDish, listDishes } from "../src/recipes/recipeStore";
import { saveSelection, getSelection } from "../src/recipes/selectionStore";
import type { Llm } from "../src/llm/llm";

const llmResolve = (matchedIds: number[], unmatched: string[] = []): Llm => ({
  async structured() { return { matchedIds, unmatched } as never; },
});

test("isAllowed enforces the whitelist", () => {
  expect(isAllowed(111, [111, 222])).toBe(true);
  expect(isAllowed(999, [111, 222])).toBe(false);
  expect(isAllowed(undefined, [111])).toBe(false);
});

test("handleRecommend renders a compact line per qualifying dish", async () => {
  const offers: Record<string, Offer> = {
    "картофель": { externalId: 1, store: "aldi", storeName: "Aldi", product: "Kartoffeln",
      price: 1.99, oldPrice: null, referencePrice: 0.8, unit: "kg", validFrom: "", validTo: "" },
    "сметана": { externalId: 2, store: "kaufland", storeName: "Kaufland", product: "Schmand",
      price: 0.99, oldPrice: null, referencePrice: 0.99, unit: "St", validFrom: "", validTo: "" },
  };
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient(c) { return offers[c] ?? null; },
  };
  const dishes: Dish[] = [{
    nameRu: "Картофельное пюре", nameUa: null, nameDe: null, cuisine: "ru",
    course: "second", keepsDays: 3, tags: [], servings: 4,
    ingredients: [{ canonical: "картофель", qty: 1, unit: "кг" }, { canonical: "сметана", qty: 1, unit: "уп" }],
  }];
  const text = await handleRecommend({ dishes, matcher });
  expect(text).toContain("Картофельное пюре");
  expect(text).toContain("2/2"); // both ingredients on offer
  expect(text).toContain("на 4 порц"); // servings surfaced
  expect(text).toContain("3 дн"); // keeps_days surfaced
});

test("handleRecommend omits dishes below the coverage threshold", async () => {
  const offers: Record<string, Offer> = {
    "картофель": { externalId: 1, store: "aldi", storeName: "Aldi", product: "Kartoffeln",
      price: 1.0, oldPrice: null, referencePrice: 1.0, unit: "kg", validFrom: "", validTo: "" },
  };
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient(c) { return offers[c] ?? null; },
  };
  // 1 of 3 ingredients on offer → coverage 0.33 < 0.7 → omitted → fallback.
  const dishes: Dish[] = [{
    nameRu: "Борщ", nameUa: null, nameDe: null, cuisine: "ua",
    course: "first", keepsDays: 4, tags: [], servings: 4,
    ingredients: [
      { canonical: "картофель", qty: 1, unit: "кг" },
      { canonical: "свёкла", qty: 1, unit: "кг" },
      { canonical: "капуста", qty: 1, unit: "кг" },
    ],
  }];
  const text = await handleRecommend({ dishes, matcher });
  expect(text).toContain("70%");
  expect(text).not.toContain("Борщ");
});

test("handleRecommend respects the limit parameter", async () => {
  const offers: Record<string, Offer> = {
    "помидор": { externalId: 1, store: "kaufland", storeName: "Kaufland", product: "Tomaten",
      price: 1.99, oldPrice: null, referencePrice: 1.99, unit: "kg", validFrom: "", validTo: "" },
    "огурец": { externalId: 2, store: "aldi", storeName: "Aldi", product: "Gurken",
      price: 0.99, oldPrice: null, referencePrice: 0.99, unit: "kg", validFrom: "", validTo: "" },
  };
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient(c) { return offers[c] ?? null; },
  };
  const dishes: Dish[] = [
    { nameRu: "Салат", nameUa: null, nameDe: null, cuisine: "ru", course: "second", keepsDays: 1, tags: [], servings: 2,
      ingredients: [{ canonical: "помидор", qty: 1, unit: "шт" }] },
    { nameRu: "Окрошка", nameUa: null, nameDe: null, cuisine: "ru", course: "first", keepsDays: 1, tags: [], servings: 2,
      ingredients: [{ canonical: "огурец", qty: 1, unit: "шт" }] },
  ];
  const text = await handleRecommend({ dishes, matcher, limit: 1 });
  const shown = ["Салат", "Окрошка"].filter((n) => text.includes(n));
  expect(shown).toHaveLength(1);
});

test("handleRecommend returns a threshold-aware fallback when nothing qualifies", async () => {
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient() { return null; },
  };
  const dishes: Dish[] = [{
    nameRu: "Борщ", nameUa: null, nameDe: null, cuisine: "ua", course: "first", keepsDays: 4, tags: [], servings: 4,
    ingredients: [{ canonical: "свёкла", qty: 1, unit: "кг" }],
  }];
  const text = await handleRecommend({ dishes, matcher });
  expect(text).toContain("70%");
  expect(text).not.toEqual("");
});

const borsch: Dish = { nameRu: "Борщ", nameUa: null, nameDe: null, cuisine: "ua", course: "first", keepsDays: 4, tags: [], servings: 4, ingredients: [{ canonical: "свёкла", qty: 1, unit: "кг" }] };
const plov: Dish = { nameRu: "Плов", nameUa: null, nameDe: null, cuisine: "ru", course: "second", keepsDays: 3, tags: [], servings: 4, ingredients: [{ canonical: "рис", qty: 1, unit: "кг" }] };

test("handleSelect resolves names, saves the selection, and confirms", async () => {
  const db = openDb(":memory:");
  const id1 = insertDish(db, borsch);
  const id2 = insertDish(db, plov);
  const dishes = [{ ...borsch, id: id1 }, { ...plov, id: id2 }];
  const llm: Llm = { async structured() { return { matchedIds: [id1, id2], unmatched: ["суши"] } as never; } };
  const text = await handleSelect({ llm, db, dishes, week: "2026-W26" }, ["борщ", "плов", "суши"]);
  expect(text).toContain("Борщ");
  expect(text).toContain("Плов");
  expect(text).toContain("суши"); // reported as not found
});

test("handleMenu renders a 7-day menu from the saved selection", () => {
  const db = openDb(":memory:");
  const id1 = insertDish(db, borsch);
  const id2 = insertDish(db, plov);
  const dishes = [{ ...borsch, id: id1 }, { ...plov, id: id2 }];
  saveSelection(db, "2026-W26", [id1, id2]);
  const text = handleMenu({ db, dishes, week: "2026-W26", menuDays: 7 });
  expect(text).toContain("Борщ"); // first course
  expect(text).toContain("Плов"); // second course
});

test("handleMenu asks for a selection when none is saved", () => {
  const db = openDb(":memory:");
  const text = handleMenu({ db, dishes: [], week: "2026-W26", menuDays: 7 });
  expect(text).toContain("выбери блюда");
});

test("handleList groups the selection's ingredients by store", async () => {
  const db = openDb(":memory:");
  const id1 = insertDish(db, borsch);
  const dishes = [{ ...borsch, id: id1 }];
  saveSelection(db, "2026-W26", [id1]);
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient() {
      return { externalId: 1, store: "aldi", storeName: "Aldi", product: "Rote Bete", price: 0.99, oldPrice: null, referencePrice: null, unit: "kg", validFrom: "", validTo: "" };
    },
  };
  const text = await handleList({ db, dishes, matcher, week: "2026-W26", plz: 30459 });
  expect(text).toContain("Aldi");
  expect(text).toContain("maps.apple.com");
});

test("handleAddDishes merges into the existing selection without replacing it", async () => {
  const db = openDb(":memory:");
  const id1 = insertDish(db, borsch);
  const id2 = insertDish(db, plov);
  const dishes = [{ ...borsch, id: id1 }, { ...plov, id: id2 }];
  saveSelection(db, "2026-W26", [id1]);
  const text = await handleAddDishes({ llm: llmResolve([id2]), db, dishes, week: "2026-W26" }, ["плов"]);
  expect(getSelection(db, "2026-W26")).toEqual([id1, id2]);
  expect(text).toContain("Плов");
});

test("handleRemoveDishes removes only the named dish", async () => {
  const db = openDb(":memory:");
  const id1 = insertDish(db, borsch);
  const id2 = insertDish(db, plov);
  const dishes = [{ ...borsch, id: id1 }, { ...plov, id: id2 }];
  saveSelection(db, "2026-W26", [id1, id2]);
  const text = await handleRemoveDishes({ llm: llmResolve([id1]), db, dishes, week: "2026-W26" }, ["борщ"]);
  expect(getSelection(db, "2026-W26")).toEqual([id2]);
  expect(text).toContain("Борщ");
});

const shakshuka: Dish = {
  nameRu: "Шакшука", nameUa: null, nameDe: null, cuisine: "il", course: "second",
  keepsDays: 1, tags: [], servings: 4,
  ingredients: [{ canonical: "яйца", qty: 4, unit: "шт" }, { canonical: "помидоры", qty: 400, unit: "г" }],
};
const llmDish = (d: Dish): Llm => ({ async structured() { return { dish: d } as never; } });

test("previewCustomDish returns a preview WITHOUT persisting", async () => {
  const db = openDb(":memory:");
  const res = await previewCustomDish({ llm: llmDish(shakshuka), db }, "шакшука");
  expect(res.status).toBe("preview");
  expect(res.text).toContain("Шакшука");
  expect(listDishes(db)).toHaveLength(0); // nothing saved until confirmed
});

test("previewCustomDish reports an already-catalogued dish (no preview)", async () => {
  const db = openDb(":memory:");
  insertDish(db, shakshuka);
  const res = await previewCustomDish({ llm: llmDish(shakshuka), db }, "шакшука");
  expect(res.status).toBe("exists");
  expect(res.text.toLowerCase()).toContain("уже");
});

test("confirmCustomDish persists the previewed dish", () => {
  const db = openDb(":memory:");
  const msg = confirmCustomDish({ db }, shakshuka);
  expect(listDishes(db).map((d) => d.nameRu)).toContain("Шакшука");
  expect(msg).toContain("Шакшука");
});

test("confirmCustomDish is idempotent by name_ru", () => {
  const db = openDb(":memory:");
  confirmCustomDish({ db }, shakshuka);
  const msg = confirmCustomDish({ db }, shakshuka);
  expect(listDishes(db).filter((d) => d.nameRu === "Шакшука")).toHaveLength(1);
  expect(msg.toLowerCase()).toContain("уже");
});

test("handleScaleDish scales a dish's ingredient quantities to the target", async () => {
  const db = openDb(":memory:");
  const ricePlov: Dish = { ...plov, ingredients: [{ canonical: "рис", qty: 1, unit: "кг" }] };
  const id = insertDish(db, ricePlov);
  const dishes = [{ ...ricePlov, id }];
  const text = await handleScaleDish({ llm: llmResolve([id]), db, dishes }, "плов", 8);
  expect(text).toContain("рис");
  expect(text).toContain("2"); // 1кг at 4 servings → 2кг at 8
});

test("handleMenu surfaces portion coverage for the household", () => {
  const db = openDb(":memory:");
  const id1 = insertDish(db, borsch);
  const dishes = [{ ...borsch, id: id1 }];
  saveSelection(db, "2026-W26", [id1]);
  const text = handleMenu({ db, dishes, week: "2026-W26", menuDays: 7, householdSize: 2 });
  expect(text).toContain("Борщ");
  expect(text).toContain("дн"); // coverage days shown
});
