import { test, expect } from "bun:test";
import { openDb } from "../src/db/db";
import {
  normalizePantryItem,
  getPantry,
  addToPantry,
  removeFromPantry,
} from "../src/recipes/pantryStore";

test("normalizePantryItem lowercases and trims", () => {
  expect(normalizePantryItem("  Рис ")).toBe("рис");
});

test("getPantry returns [] for an unknown week", () => {
  const db = openDb(":memory:");
  expect(getPantry(db, "2026-W26")).toEqual([]);
});

test("addToPantry normalizes, unions, dedupes and preserves order", () => {
  const db = openDb(":memory:");
  addToPantry(db, "2026-W26", ["Рис", "лук"]);
  addToPantry(db, "2026-W26", ["лук", "соль"]);
  expect(getPantry(db, "2026-W26")).toEqual(["рис", "лук", "соль"]);
});

test("removeFromPantry removes only matching items (normalized)", () => {
  const db = openDb(":memory:");
  addToPantry(db, "2026-W26", ["рис", "лук", "соль"]);
  removeFromPantry(db, "2026-W26", ["Лук"]);
  expect(getPantry(db, "2026-W26")).toEqual(["рис", "соль"]);
});

test("removeFromPantry on an unknown week is a no-op", () => {
  const db = openDb(":memory:");
  removeFromPantry(db, "2026-W26", ["рис"]);
  expect(getPantry(db, "2026-W26")).toEqual([]);
});
