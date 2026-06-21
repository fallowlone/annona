import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS, applyColumnMigrations } from "./migrations";

export function openDb(path: string): Database {
  // Ensure the DB file's parent dir exists (e.g. data/ for a mounted volume).
  // Skipped for in-memory DBs used in tests.
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");
  for (const stmt of MIGRATIONS) db.run(stmt);
  applyColumnMigrations(db);
  return db;
}
