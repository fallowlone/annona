import { test, expect } from "bun:test";
import { paginate, renderDishCard } from "../src/bot/recipeView";
import type { Dish } from "../src/types";

test("paginate clamps the page into range and slices", () => {
  const items = [1, 2, 3, 4, 5];
  expect(paginate(items, 0, 2)).toEqual({ slice: [1, 2], page: 0, pages: 3 });
  expect(paginate(items, 2, 2)).toEqual({ slice: [5], page: 2, pages: 3 });
  expect(paginate(items, 9, 2).page).toBe(2); // clamped to last page
  expect(paginate(items, -1, 2).page).toBe(0); // clamped to first page
});

test("paginate reports 1 page for an empty list", () => {
  expect(paginate([], 0, 6)).toEqual({ slice: [], page: 0, pages: 1 });
});

const dish: Dish = {
  nameRu: "Карбонара",
  nameUa: null,
  nameDe: null,
  cuisine: "it",
  course: "second",
  keepsDays: 1,
  tags: [],
  servings: 4,
  ingredients: [
    { canonical: "спагетти", qty: 400, unit: "г" },
    { canonical: "бекон", qty: 150, unit: "г" },
  ],
};

test("renderDishCard shows name, meta, ingredients; steps only when present", () => {
  const noSteps = renderDishCard(dish, "~6.40€ (по акциям)", null);
  expect(noSteps).toContain("Карбонара");
  expect(noSteps).toContain("~6.40€");
  expect(noSteps).toContain("спагетти");
  expect(noSteps).not.toContain("blockquote");

  const withSteps = renderDishCard(dish, "~6.40€ (по акциям)", "1. Свари пасту.");
  expect(withSteps).toContain("blockquote");
  expect(withSteps).toContain("Свари пасту");
});

test("renderDishCard renders the course and servings meta", () => {
  const out = renderDishCard(dish, "~6.40€ (по акциям)", null);
  expect(out).toContain("второе");
  expect(out).toContain("4 порц");
});

test("renderDishCard renders первое for a first-course dish", () => {
  const soup: Dish = { ...dish, course: "first" };
  expect(renderDishCard(soup, "~1.00€", null)).toContain("первое");
});

test("renderDishCard renders an ingredient with no qty as just its name", () => {
  const saltOnly: Dish = {
    ...dish,
    ingredients: [{ canonical: "соль", qty: null, unit: null }],
  };
  const out = renderDishCard(saltOnly, "~0.50€", null);
  expect(out).toContain("соль");
  expect(out).not.toContain("null");
});

test("renderDishCard escapes HTML-significant characters in the name", () => {
  const danger: Dish = { ...dish, nameRu: "Соус <острый>" };
  expect(renderDishCard(danger, "~1.00€", null)).toContain("Соус &lt;острый&gt;");
});
