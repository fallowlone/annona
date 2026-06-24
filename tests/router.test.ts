import { test, expect } from "bun:test";
import { routeMessage } from "../src/bot/router";

test("routes 'добавь блюдо X' to add_custom_dish (beats add_dishes)", () => {
  expect(routeMessage("добавь блюдо шакшука")).toEqual({
    kind: "add_custom_dish",
    dishNames: ["шакшука"],
  });
});

test("routes 'новое блюдо X' to add_custom_dish", () => {
  expect(routeMessage("новое блюдо рагу")).toEqual({
    kind: "add_custom_dish",
    dishNames: ["рагу"],
  });
});

test("routes '/recipe X' to add_custom_dish", () => {
  expect(routeMessage("/recipe шакшука")).toEqual({
    kind: "add_custom_dish",
    dishNames: ["шакшука"],
  });
});

test("routes 'добавь X' to add_dishes", () => {
  expect(routeMessage("добавь плов")).toEqual({
    kind: "add_dishes",
    dishNames: ["плов"],
  });
});

test("splits multiple names on commas for add_dishes", () => {
  expect(routeMessage("добавь плов, борщ")).toEqual({
    kind: "add_dishes",
    dishNames: ["плов", "борщ"],
  });
});

test("routes '+ X' to add_dishes", () => {
  expect(routeMessage("+ плов")).toEqual({ kind: "add_dishes", dishNames: ["плов"] });
});

test("routes 'убери X' to remove_dishes", () => {
  expect(routeMessage("убери борщ")).toEqual({
    kind: "remove_dishes",
    dishNames: ["борщ"],
  });
});

test("routes 'удали X, Y' to remove_dishes with split", () => {
  expect(routeMessage("удали борщ, плов")).toEqual({
    kind: "remove_dishes",
    dishNames: ["борщ", "плов"],
  });
});

test("routes 'минус X' and '- X' to remove_dishes", () => {
  expect(routeMessage("минус борщ")).toEqual({ kind: "remove_dishes", dishNames: ["борщ"] });
  expect(routeMessage("- борщ")).toEqual({ kind: "remove_dishes", dishNames: ["борщ"] });
});

test("routes '<dish> на N порций' to scale_dish with targetServings", () => {
  expect(routeMessage("плов на 8 порций")).toEqual({
    kind: "scale_dish",
    dishNames: ["плов"],
    targetServings: 8,
  });
});

test("accepts the shorter 'порц' suffix for scaling", () => {
  expect(routeMessage("борщ на 6 порц")).toEqual({
    kind: "scale_dish",
    dishNames: ["борщ"],
    targetServings: 6,
  });
});

test("is case-insensitive on the leading verb", () => {
  expect(routeMessage("Добавь плов")).toEqual({ kind: "add_dishes", dishNames: ["плов"] });
});

test("returns null for a plain dish list (defers to the LLM router)", () => {
  expect(routeMessage("борщ, карбонара")).toBeNull();
});

test("routes navigation phrases without paying for an LLM classify", () => {
  expect(routeMessage("меню")).toEqual({ kind: "show_menu", dishNames: [] });
  expect(routeMessage("/menu")).toEqual({ kind: "show_menu", dishNames: [] });
  expect(routeMessage("список")).toEqual({ kind: "show_list", dishNames: [] });
  expect(routeMessage("покупки")).toEqual({ kind: "show_list", dishNames: [] });
  expect(routeMessage("что приготовить?")).toEqual({ kind: "suggest", dishNames: [] });
  expect(routeMessage("выгодно")).toEqual({ kind: "suggest", dishNames: [] });
  expect(routeMessage("привет")).toEqual({ kind: "help", dishNames: [] });
  expect(routeMessage("/start")).toEqual({ kind: "help", dishNames: [] });
});

test("navigation routes do not swallow edit verbs that share a word", () => {
  // "добавь меню" is still an add, not show_menu (anchored navigation regex).
  expect(routeMessage("добавь меню")).toEqual({ kind: "add_dishes", dishNames: ["меню"] });
});

test("returns null for an empty message", () => {
  expect(routeMessage("")).toBeNull();
});

test("returns null when a verb has no dish name", () => {
  expect(routeMessage("добавь")).toBeNull();
});

test("rejects an absurd serving count (over the cap) instead of routing scale", () => {
  expect(routeMessage("плов на 99999 порций")).toBeNull();
});

test("still routes a sane serving count", () => {
  expect(routeMessage("плов на 12 порций")).toMatchObject({ kind: "scale_dish", targetServings: 12 });
});

test("drops a pathologically long dish name (defers to the LLM)", () => {
  expect(routeMessage("добавь блюдо " + "я".repeat(300))).toBeNull();
});

test("routes 'удали блюдо X' to delete_dish (catalogue), not remove_dishes", () => {
  expect(routeMessage("удали блюдо борщ")).toEqual({ kind: "delete_dish", dishNames: ["борщ"] });
});

test("routes 'убери блюдо X' to delete_dish", () => {
  expect(routeMessage("убери блюдо плов")).toEqual({ kind: "delete_dish", dishNames: ["плов"] });
});

test("routes '/delrecipe X' to delete_dish", () => {
  expect(routeMessage("/delrecipe борщ")).toEqual({ kind: "delete_dish", dishNames: ["борщ"] });
});

test("'удали X' (no 'блюдо') still means remove from the week", () => {
  expect(routeMessage("удали борщ")).toEqual({ kind: "remove_dishes", dishNames: ["борщ"] });
});

test("routes 'у меня есть X, Y' to add_pantry", () => {
  expect(routeMessage("у меня есть рис, лук")).toEqual({
    kind: "add_pantry",
    dishNames: ["рис", "лук"],
  });
});

test("routes 'есть дома X' to add_pantry", () => {
  expect(routeMessage("есть дома масло")).toEqual({ kind: "add_pantry", dishNames: ["масло"] });
});

test("routes 'закончился X' to remove_pantry (not remove_dishes)", () => {
  expect(routeMessage("закончился рис")).toEqual({ kind: "remove_pantry", dishNames: ["рис"] });
});

test("routes 'убери из дома X' to remove_pantry (before remove_dishes)", () => {
  expect(routeMessage("убери из дома лук")).toEqual({ kind: "remove_pantry", dishNames: ["лук"] });
});

test("routes bare '/pantry' and 'что дома' to show_pantry", () => {
  expect(routeMessage("/pantry")).toEqual({ kind: "show_pantry", dishNames: [] });
  expect(routeMessage("что дома")).toEqual({ kind: "show_pantry", dishNames: [] });
});

test("'убери борщ' (no 'из дома') still routes to remove_dishes", () => {
  expect(routeMessage("убери борщ")).toEqual({ kind: "remove_dishes", dishNames: ["борщ"] });
});
