import { test, expect } from "bun:test";
import { openDb } from "../src/db/db";
import { getPins, savePins, removePinsForDay } from "../src/recipes/pinsStore";

test("getPins returns [] when none saved", () => {
  const db = openDb(":memory:");
  expect(getPins(db, "2026-W26")).toEqual([]);
});

test("savePins round-trips and overwrites the week's pins", () => {
  const db = openDb(":memory:");
  savePins(db, "2026-W26", [{ day: 1, dishId: 5 }, { day: 2, dishId: 7 }]);
  expect(getPins(db, "2026-W26")).toEqual([{ day: 1, dishId: 5 }, { day: 2, dishId: 7 }]);
  savePins(db, "2026-W26", [{ day: 1, dishId: 9 }]);
  expect(getPins(db, "2026-W26")).toEqual([{ day: 1, dishId: 9 }]);
});

test("removePinsForDay drops only that day's pins", () => {
  const db = openDb(":memory:");
  savePins(db, "2026-W26", [{ day: 1, dishId: 5 }, { day: 2, dishId: 7 }]);
  removePinsForDay(db, "2026-W26", 1);
  expect(getPins(db, "2026-W26")).toEqual([{ day: 2, dishId: 7 }]);
});
