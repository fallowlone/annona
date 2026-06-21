import { test, expect } from "bun:test";
import { openDb } from "../src/db/db";

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
