import { test, expect } from "bun:test";
import { coverageDays } from "../src/portions";

test("divides servings by household size, floored", () => {
  expect(coverageDays(6, 2)).toBe(3);
});

test("floors a fractional result", () => {
  expect(coverageDays(7, 2)).toBe(3);
});

test("clamps to a minimum of 1 day when servings < household", () => {
  expect(coverageDays(1, 2)).toBe(1);
});

test("household of 1 yields one day per serving", () => {
  expect(coverageDays(6, 1)).toBe(6);
});

test("exact one-day coverage", () => {
  expect(coverageDays(4, 4)).toBe(1);
});
