import { test, expect } from "bun:test";
import { fillCourse, planWeek } from "../src/planner";
import type { Dish } from "../src/types";

const dish = (nameRu: string, keepsDays: number, course: "first" | "second"): Dish => ({
  nameRu, nameUa: null, nameDe: null, cuisine: "ru", course, keepsDays,
  tags: [], servings: 4, ingredients: [{ canonical: "x", qty: 1, unit: "шт" }],
});

test("fillCourse repeats a dish for keepsDays then advances, cycling to fill the week", () => {
  const f = fillCourse([dish("Борщ", 4, "first"), dish("Гречка", 1, "first")], 7);
  expect(f.map((d) => d!.nameRu)).toEqual([
    "Борщ", "Борщ", "Борщ", "Борщ", "Гречка", "Борщ", "Борщ",
  ]);
});

test("fillCourse with an empty list yields all null", () => {
  expect(fillCourse([], 7)).toEqual([null, null, null, null, null, null, null]);
});

test("fillCourse with a single dish fills every day", () => {
  const f = fillCourse([dish("Плов", 3, "second")], 7);
  expect(f.every((d) => d!.nameRu === "Плов")).toBe(true);
  expect(f).toHaveLength(7);
});

test("planWeek lays out first and second courses independently", () => {
  const menu = planWeek(
    [dish("Борщ", 4, "first")],
    [dish("Карбонара", 2, "second")],
    7
  );
  expect(menu.days).toHaveLength(7);
  expect(menu.days[0]!.day).toBe(1);
  expect(menu.days[0]!.first!.nameRu).toBe("Борщ");
  expect(menu.days[0]!.second!.nameRu).toBe("Карбонара");
});

test("planWeek leaves a slot null when that course has no dishes", () => {
  const menu = planWeek([dish("Борщ", 2, "first")], [], 7);
  expect(menu.days.every((d) => d.first !== null)).toBe(true);
  expect(menu.days.every((d) => d.second === null)).toBe(true);
});
