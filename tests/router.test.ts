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

test("returns null for an open question", () => {
  expect(routeMessage("что приготовить?")).toBeNull();
});

test("returns null for an empty message", () => {
  expect(routeMessage("")).toBeNull();
});

test("returns null when a verb has no dish name", () => {
  expect(routeMessage("добавь")).toBeNull();
});
