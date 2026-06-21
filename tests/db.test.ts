import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb } from "../src/db/db";
import { applyColumnMigrations } from "../src/db/migrations";

test("openDb creates all tables and supports a roundtrip", () => {
  const db = openDb(":memory:");
  const tables = db.query(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all() as { name: string }[];
  const names = tables.map((t) => t.name);
  for (const t of ["dishes", "ingredients", "synonyms", "match_cache", "offers", "meta"]) {
    expect(names).toContain(t);
  }
  db.run("INSERT INTO meta(key,value) VALUES('k','v')");
  const row = db.query("SELECT value FROM meta WHERE key='k'").get() as { value: string };
  expect(row.value).toBe("v");
});

test("foreign keys are enforced", () => {
  const db = openDb(":memory:");
  expect(() =>
    db.run("INSERT INTO ingredients(dish_id, canonical_name) VALUES(999, 'salt')")
  ).toThrow();
});

test("openDb adds course and keeps_days columns to the dishes table", () => {
  const db = openDb(":memory:");
  const cols = (db.query("PRAGMA table_info(dishes)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("course");
  expect(cols).toContain("keeps_days");
});

test("applyColumnMigrations upgrades a pre-existing dishes table and is idempotent", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE dishes (id INTEGER PRIMARY KEY, name_ru TEXT NOT NULL)");
  applyColumnMigrations(db);
  applyColumnMigrations(db); // second run must not throw "duplicate column"
  const cols = (db.query("PRAGMA table_info(dishes)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("course");
  expect(cols).toContain("keeps_days");
});
