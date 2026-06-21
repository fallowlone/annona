import { test, expect } from "bun:test";
import { openDb } from "../src/db/db";
import { saveSelection, getSelection } from "../src/recipes/selectionStore";

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
