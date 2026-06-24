import { test, expect } from "bun:test";
import { openDb } from "../src/db/db";
import { insertDish, dishSteps } from "../src/recipes/recipeStore";
import { loadDishSteps } from "../src/bot/menus";
import type { Dish } from "../src/types";
import type { Llm } from "../src/llm/llm";

const dish: Dish = {
  nameRu: "Борщ", nameUa: null, nameDe: null, cuisine: "ua", course: "first",
  keepsDays: 4, tags: [], servings: 4, ingredients: [{ canonical: "свёкла", qty: 1, unit: "кг" }],
};
const stepsLlm = (steps: string): Llm => ({ async structured() { return { steps } as never; } });
const throwingLlm: Llm = { async structured() { throw new Error("llm down"); } };

test("loadDishSteps generates steps on first view and persists them", async () => {
  const db = openDb(":memory:");
  const id = insertDish(db, dish);
  const out = await loadDishSteps({ db, llm: stepsLlm("1. Свари.") }, { ...dish, id });
  expect(out).toBe("1. Свари.");
  expect(dishSteps(db, id)).toBe("1. Свари."); // cached for next time
});

test("loadDishSteps returns cached steps without calling the LLM", async () => {
  const db = openDb(":memory:");
  const id = insertDish(db, dish);
  await loadDishSteps({ db, llm: stepsLlm("первый") }, { ...dish, id }); // warm the cache
  const out = await loadDishSteps({ db, llm: throwingLlm }, { ...dish, id }); // throws if LLM is hit
  expect(out).toBe("первый");
});

test("loadDishSteps propagates a generation failure (card shows an error, no crash)", async () => {
  const db = openDb(":memory:");
  const id = insertDish(db, dish);
  await expect(loadDishSteps({ db, llm: throwingLlm }, { ...dish, id })).rejects.toThrow("llm down");
});
