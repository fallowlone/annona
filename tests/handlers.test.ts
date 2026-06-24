import { test, expect } from "bun:test";
import {
  isAllowed, handleRecommend, handleSelect, handleMenu, handleList,
  handleAddDishes, handleRemoveDishes, previewCustomDish, confirmCustomDish,
  previewDeleteDish, confirmDeleteDish, handleScaleDish, handlePinDish, handleUnpinDay,
  generateForSelection, saveDishToWeek,
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

const noOffers: Matcher = { async searchTerms() { return []; }, async matchIngredient() { return null; } };

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

test("handleRecommend HTML-escapes dish names so model output can't break formatting", async () => {
  const offers: Record<string, Offer> = {
    "рис": { externalId: 1, store: "aldi", storeName: "Aldi", product: "Reis",
      price: 0.99, oldPrice: null, referencePrice: 0.99, unit: "kg", validFrom: "", validTo: "" },
  };
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient(c) { return offers[c] ?? null; },
  };
  const dishes: Dish[] = [{
    nameRu: 'Café <b>X</b> & Co', nameUa: null, nameDe: null, cuisine: "ru",
    course: "second", keepsDays: 1, tags: [], servings: 2,
    ingredients: [{ canonical: "рис", qty: 1, unit: "кг" }],
  }];
  const text = await handleRecommend({ dishes, matcher });
  expect(text).toContain("Café &lt;b&gt;X&lt;/b&gt; &amp; Co"); // escaped
  expect(text).not.toContain("Café <b>X</b>"); // raw injection neutralized
});

test("handleList HTML-escapes scraped product names", async () => {
  const db = openDb(":memory:");
  const dish: Dish = {
    nameRu: "Тест", nameUa: null, nameDe: null, cuisine: "ru", course: "second",
    keepsDays: 1, tags: [], servings: 2, ingredients: [{ canonical: "картофель", qty: 1, unit: "кг" }],
  };
  const id = insertDish(db, dish);
  saveSelection(db, "2026-W26", [id]);
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient() {
      return { externalId: 1, store: "aldi", storeName: "Aldi", product: 'Kartoffeln <b>&"x"',
        price: 1.99, oldPrice: null, referencePrice: null, unit: "kg", validFrom: "", validTo: "" };
    },
  };
  const text = await handleList({ db, dishes: listDishes(db), matcher, week: "2026-W26", plz: 30459 });
  expect(text).toContain("Kartoffeln &lt;b&gt;&amp;&quot;x&quot;"); // scraped product escaped (incl. quote)
  expect(text).not.toContain("Kartoffeln <b>"); // raw injection neutralized
});

const borsch: Dish = { nameRu: "Борщ", nameUa: null, nameDe: null, cuisine: "ua", course: "first", keepsDays: 4, tags: [], servings: 4, ingredients: [{ canonical: "свёкла", qty: 1, unit: "кг" }] };
const plov: Dish = { nameRu: "Плов", nameUa: null, nameDe: null, cuisine: "ru", course: "second", keepsDays: 3, tags: [], servings: 4, ingredients: [{ canonical: "рис", qty: 1, unit: "кг" }] };

test("handleSelect resolves names, saves the selection, and reports unmatched separately", async () => {
  const db = openDb(":memory:");
  const id1 = insertDish(db, borsch);
  const id2 = insertDish(db, plov);
  const dishes = [{ ...borsch, id: id1 }, { ...plov, id: id2 }];
  const llm: Llm = { async structured() { return { matchedIds: [id1, id2], unmatched: ["суши"] } as never; } };
  const res = await handleSelect({ llm, db, dishes, week: "2026-W26" }, ["борщ", "плов", "суши"]);
  expect(res.text).toContain("Борщ");
  expect(res.text).toContain("Плов");
  expect(res.text).not.toContain("суши");
  expect(res.unmatched).toEqual(["суши"]);
});

test("handleMenu renders a 7-day menu from the saved selection", async () => {
  const db = openDb(":memory:");
  const id1 = insertDish(db, borsch);
  const id2 = insertDish(db, plov);
  const dishes = [{ ...borsch, id: id1 }, { ...plov, id: id2 }];
  saveSelection(db, "2026-W26", [id1, id2]);
  const text = await handleMenu({ db, dishes, matcher: noOffers, week: "2026-W26", menuDays: 7 });
  expect(text).toContain("Борщ"); // first course
  expect(text).toContain("Плов"); // second course
});

test("handleMenu asks for a selection when none is saved", async () => {
  const db = openDb(":memory:");
  const text = await handleMenu({ db, dishes: [], matcher: noOffers, week: "2026-W26", menuDays: 7 });
  expect(text).toContain("выбери блюда");
});

test("handlePinDish pins a dish to a day; handleMenu shows it there with 📌", async () => {
  const db = openDb(":memory:");
  const id1 = insertDish(db, borsch);
  const dishes = [{ ...borsch, id: id1 }];
  const msg = await handlePinDish({ llm: llmResolve([id1]), db, dishes, week: "2026-W26" }, "борщ", 2);
  expect(msg).toContain("Закрепил");
  const menu = await handleMenu({ db, dishes, matcher: noOffers, week: "2026-W26", menuDays: 7 });
  const tue = menu.split("\n").find((l) => l.includes("Вт"));
  expect(tue).toContain("📌");
  expect(tue).toContain("Борщ"); // pinned dish lands on Tuesday's first-course slot
});

test("handleUnpinDay clears a day's pin", async () => {
  const db = openDb(":memory:");
  const id1 = insertDish(db, borsch);
  const dishes = [{ ...borsch, id: id1 }];
  await handlePinDish({ llm: llmResolve([id1]), db, dishes, week: "2026-W26" }, "борщ", 2);
  expect(handleUnpinDay({ db, week: "2026-W26" }, 2)).toContain("Открепил");
  const menu = await handleMenu({ db, dishes, matcher: noOffers, week: "2026-W26", menuDays: 7 });
  expect(menu).not.toContain("📌");
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
  const res = await handleAddDishes({ llm: llmResolve([id2]), db, dishes, week: "2026-W26" }, ["плов"]);
  expect(getSelection(db, "2026-W26")).toEqual([id1, id2]);
  expect(res.text).toContain("Плов");
  expect(res.unmatched).toEqual([]);
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

test("previewDeleteDish resolves a catalogue dish and previews it without deleting", async () => {
  const db = openDb(":memory:");
  const id = insertDish(db, borsch);
  const dishes = [{ ...borsch, id }];
  const res = await previewDeleteDish({ llm: llmResolve([id]), db, dishes }, "борщ");
  expect(res.status).toBe("confirm");
  expect(res.text).toContain("Борщ");
  expect(listDishes(db)).toHaveLength(1); // not deleted until confirmed
});

test("previewDeleteDish reports not found when nothing matches", async () => {
  const db = openDb(":memory:");
  const res = await previewDeleteDish({ llm: llmResolve([]), db, dishes: [] }, "суши");
  expect(res.status).toBe("notfound");
});

test("confirmDeleteDish removes the dish from the catalogue", () => {
  const db = openDb(":memory:");
  const id = insertDish(db, borsch);
  const msg = confirmDeleteDish({ db }, id);
  expect(listDishes(db)).toHaveLength(0);
  expect(msg).toContain("Удалил");
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

test("handleMenu surfaces portion coverage for the household", async () => {
  const db = openDb(":memory:");
  const id1 = insertDish(db, borsch);
  const dishes = [{ ...borsch, id: id1 }];
  saveSelection(db, "2026-W26", [id1]);
  const text = await handleMenu({ db, dishes, matcher: noOffers, week: "2026-W26", menuDays: 7, householdSize: 2 });
  expect(text).toContain("Борщ");
  expect(text).toContain("дн"); // coverage days shown
});

import {
  handleAddPantry, handleRemovePantry, handleShowPantry,
} from "../src/bot/handlers";
import { getPantry } from "../src/recipes/pantryStore";

test("handleAddPantry stores normalized items and confirms", () => {
  const db = openDb(":memory:");
  const text = handleAddPantry({ db, week: "2026-W26" }, ["Рис", "лук"]);
  expect(getPantry(db, "2026-W26")).toEqual(["рис", "лук"]);
  expect(text).toContain("рис");
});

test("handleAddPantry prompts when given no items", () => {
  const db = openDb(":memory:");
  const text = handleAddPantry({ db, week: "2026-W26" }, []);
  expect(getPantry(db, "2026-W26")).toEqual([]);
  expect(text.toLowerCase()).toContain("что");
});

test("handleRemovePantry removes the named item", () => {
  const db = openDb(":memory:");
  handleAddPantry({ db, week: "2026-W26" }, ["рис", "лук"]);
  const text = handleRemovePantry({ db, week: "2026-W26" }, ["рис"]);
  expect(getPantry(db, "2026-W26")).toEqual(["лук"]);
  expect(text).toContain("рис");
});

test("handleShowPantry lists items or reports empty", () => {
  const db = openDb(":memory:");
  expect(handleShowPantry({ db, week: "2026-W26" }).toLowerCase()).toContain("ничего");
  handleAddPantry({ db, week: "2026-W26" }, ["рис"]);
  expect(handleShowPantry({ db, week: "2026-W26" })).toContain("рис");
});

import { addToPantry } from "../src/recipes/pantryStore";

test("generateForSelection previews a brand-new dish without persisting", async () => {
  const db = openDb(":memory:");
  const sol: Dish = { nameRu: "Солянка", nameUa: null, nameDe: null, cuisine: "ru", course: "first", keepsDays: 3, tags: [], servings: 6, ingredients: [{ canonical: "колбаса", qty: 300, unit: "г" }] };
  const res = await generateForSelection({ llm: llmDish(sol), db, week: "2026-W26" }, "солянка");
  expect(res.status).toBe("preview");
  if (res.status === "preview") expect(res.text).toContain("Солянка");
  expect(listDishes(db)).toHaveLength(0);
  expect(getSelection(db, "2026-W26")).toBeNull();
});

test("generateForSelection adds an already-catalogued dish to the week", async () => {
  const db = openDb(":memory:");
  const id = insertDish(db, borsch); // "Борщ"
  const res = await generateForSelection({ llm: llmDish({ ...borsch }), db, week: "2026-W26" }, "борщец");
  expect(res.status).toBe("added");
  if (res.status === "added") expect(res.nameRu).toBe("Борщ");
  expect(getSelection(db, "2026-W26")).toEqual([id]);
  expect(listDishes(db)).toHaveLength(1); // no duplicate inserted
});

test("saveDishToWeek inserts a new dish and adds it to the week", () => {
  const db = openDb(":memory:");
  const sol: Dish = { nameRu: "Солянка", nameUa: null, nameDe: null, cuisine: "ru", course: "first", keepsDays: 3, tags: [], servings: 6, ingredients: [{ canonical: "колбаса", qty: 300, unit: "г" }] };
  saveDishToWeek({ db }, sol, "2026-W26");
  const id = listDishes(db).find((d) => d.nameRu === "Солянка")!.id!;
  expect(getSelection(db, "2026-W26")).toEqual([id]);
});

test("saveDishToWeek is idempotent on name_ru", () => {
  const db = openDb(":memory:");
  const id = insertDish(db, borsch);
  saveDishToWeek({ db }, { ...borsch }, "2026-W26");
  expect(listDishes(db).filter((d) => d.nameRu === "Борщ")).toHaveLength(1);
  expect(getSelection(db, "2026-W26")).toEqual([id]);
});

test("handleList hides pantry ingredients and shows an 'Уже дома' footer", async () => {
  const db = openDb(":memory:");
  const dish: Dish = {
    nameRu: "Плов", nameUa: null, nameDe: null, cuisine: "ru", course: "second",
    keepsDays: 3, tags: [], servings: 4,
    ingredients: [{ canonical: "рис", qty: 1, unit: "кг" }, { canonical: "мясо", qty: 1, unit: "кг" }],
  };
  const id = insertDish(db, dish);
  saveSelection(db, "2026-W26", [id]);
  addToPantry(db, "2026-W26", ["рис"]);
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient(c) {
      return { externalId: 1, store: "aldi", storeName: "Aldi", product: c, price: 1, oldPrice: null, referencePrice: null, unit: "kg", validFrom: "", validTo: "" };
    },
  };
  const text = await handleList({ db, dishes: [{ ...dish, id }], matcher, week: "2026-W26", plz: 30459 });
  expect(text).toContain("Уже дома");
  expect(text).toContain("рис");
  expect(text).toContain("мясо");
});

test("handleMenu shows an approximate per-dish cost", async () => {
  const db = openDb(":memory:");
  const id1 = insertDish(db, borsch);
  const dishes = [{ ...borsch, id: id1 }];
  saveSelection(db, "2026-W26", [id1]);
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient() {
      return { externalId: 1, store: "aldi", storeName: "Aldi", product: "Rote Bete", price: 1.5, oldPrice: null, referencePrice: null, unit: "kg", validFrom: "", validTo: "" };
    },
  };
  const text = await handleMenu({ db, dishes, matcher, week: "2026-W26", menuDays: 7 });
  expect(text).toContain("1.50€");
  expect(text.toLowerCase()).toContain("по акциям");
});

test("handleList shows a per-dish breakdown and grand total", async () => {
  const db = openDb(":memory:");
  const id1 = insertDish(db, borsch); // 1 ingredient
  const dishes = [{ ...borsch, id: id1 }];
  saveSelection(db, "2026-W26", [id1]);
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient() {
      return { externalId: 1, store: "aldi", storeName: "Aldi", product: "Rote Bete", price: 2.0, oldPrice: null, referencePrice: null, unit: "kg", validFrom: "", validTo: "" };
    },
  };
  const text = await handleList({ db, dishes, matcher, week: "2026-W26", plz: 30459 });
  expect(text).toContain("Борщ — ~2.00€");
  expect(text).toContain("Итого");
});
