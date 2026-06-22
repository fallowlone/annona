import { test, expect } from "bun:test";
import { scaleIngredients } from "../src/scale";
import type { Ingredient } from "../src/types";

const ing = (canonical: string, qty: number | null, unit: string | null): Ingredient => ({
  canonical,
  qty,
  unit,
});

test("scales quantities up by target/base ratio", () => {
  const out = scaleIngredients([ing("рис", 200, "г")], 4, 8);
  expect(out).toEqual([ing("рис", 400, "г")]);
});

test("scales quantities down", () => {
  const out = scaleIngredients([ing("рис", 200, "г")], 4, 2);
  expect(out).toEqual([ing("рис", 100, "г")]);
});

test("rounds scaled value >= 10 to an integer", () => {
  // 100 * 4/3 = 133.33 -> 133
  const out = scaleIngredients([ing("мука", 100, "г")], 3, 4);
  expect(out[0]!.qty).toBe(133);
});

test("rounds scaled value < 10 to one decimal", () => {
  // 1 * 4/3 = 1.333 -> 1.3
  const out = scaleIngredients([ing("морковь", 1, "шт")], 3, 4);
  expect(out[0]!.qty).toBe(1.3);
});

test("preserves null qty (по вкусу)", () => {
  const out = scaleIngredients([ing("соль", null, null)], 4, 8);
  expect(out[0]!.qty).toBeNull();
});

test("guards base <= 0 by returning quantities unchanged", () => {
  const input = [ing("рис", 200, "г")];
  const out = scaleIngredients(input, 0, 8);
  expect(out[0]!.qty).toBe(200);
});

test("does not mutate the input ingredients", () => {
  const input = [ing("рис", 200, "г")];
  scaleIngredients(input, 4, 8);
  expect(input[0]!.qty).toBe(200);
});

test("keeps canonical and unit intact while scaling", () => {
  const out = scaleIngredients([ing("молоко", 250, "мл")], 2, 4);
  expect(out[0]).toEqual(ing("молоко", 500, "мл"));
});
