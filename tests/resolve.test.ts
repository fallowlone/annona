import { test, expect } from "bun:test";
import { resolveDishes } from "../src/bot/resolve";
import type { Llm } from "../src/llm/llm";
import type { Dish } from "../src/types";

const cat: Dish[] = [
  { id: 1, nameRu: "Борщ", nameUa: "Борщ", nameDe: null, cuisine: "ua", course: "first", keepsDays: 4, tags: [], servings: 4, ingredients: [{ canonical: "свёкла", qty: 1, unit: "кг" }] },
  { id: 2, nameRu: "Карбонара", nameUa: null, nameDe: null, cuisine: "it", course: "second", keepsDays: 1, tags: [], servings: 2, ingredients: [{ canonical: "паста", qty: 0.5, unit: "кг" }] },
];

test("resolveDishes maps returned ids to catalogue dishes and passes unmatched through", async () => {
  const llm: Llm = { async structured() { return { matchedIds: [1, 2], unmatched: ["пельмени"] } as never; } };
  const r = await resolveDishes(llm, cat, ["борщ", "карбонара", "пельмени"]);
  expect(r.matched.map((d) => d.nameRu)).toEqual(["Борщ", "Карбонара"]);
  expect(r.unmatched).toEqual(["пельмени"]);
});

test("resolveDishes drops ids that are not in the catalogue", async () => {
  const llm: Llm = { async structured() { return { matchedIds: [1, 999], unmatched: [] } as never; } };
  const r = await resolveDishes(llm, cat, ["борщ"]);
  expect(r.matched.map((d) => d.id)).toEqual([1]);
});

test("resolveDishes short-circuits with no LLM call when names is empty", async () => {
  let called = false;
  const llm: Llm = { async structured() { called = true; return {} as never; } };
  const r = await resolveDishes(llm, cat, []);
  expect(called).toBe(false);
  expect(r).toEqual({ matched: [], unmatched: [] });
});
