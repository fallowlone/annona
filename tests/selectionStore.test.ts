import { test, expect } from "bun:test";
import { openDb } from "../src/db/db";
import {
  saveSelection,
  getSelection,
  addToSelection,
  removeFromSelection,
} from "../src/recipes/selectionStore";

test("saveSelection + getSelection round-trips dish ids for a week", () => {
  const db = openDb(":memory:");
  saveSelection(db, "2026-W26", [3, 7, 12]);
  expect(getSelection(db, "2026-W26")).toEqual([3, 7, 12]);
});

test("getSelection returns null for an unknown week", () => {
  const db = openDb(":memory:");
  expect(getSelection(db, "2026-W26")).toBeNull();
});

test("saveSelection overwrites the same week", () => {
  const db = openDb(":memory:");
  saveSelection(db, "2026-W26", [1, 2]);
  saveSelection(db, "2026-W26", [9]);
  expect(getSelection(db, "2026-W26")).toEqual([9]);
});

test("addToSelection seeds a new week when none exists", () => {
  const db = openDb(":memory:");
  addToSelection(db, "2026-W26", [3]);
  expect(getSelection(db, "2026-W26")).toEqual([3]);
});

test("addToSelection unions, dedupes, and preserves first-seen order", () => {
  const db = openDb(":memory:");
  saveSelection(db, "2026-W26", [1, 2]);
  addToSelection(db, "2026-W26", [2, 3]);
  expect(getSelection(db, "2026-W26")).toEqual([1, 2, 3]);
});

test("removeFromSelection removes only the matching ids", () => {
  const db = openDb(":memory:");
  saveSelection(db, "2026-W26", [1, 2, 3]);
  removeFromSelection(db, "2026-W26", [2]);
  expect(getSelection(db, "2026-W26")).toEqual([1, 3]);
});

test("removeFromSelection is a no-op for ids not in the selection", () => {
  const db = openDb(":memory:");
  saveSelection(db, "2026-W26", [1, 2]);
  removeFromSelection(db, "2026-W26", [9]);
  expect(getSelection(db, "2026-W26")).toEqual([1, 2]);
});

test("removeFromSelection on an unknown week is a no-op", () => {
  const db = openDb(":memory:");
  removeFromSelection(db, "2026-W26", [1]);
  expect(getSelection(db, "2026-W26")).toBeNull();
});
