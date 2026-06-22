import type { Database } from "bun:sqlite";

type ColumnMigration = { table: string; column: string; ddl: string };

// Additive column migrations applied after the CREATE TABLE statements.
// Each is guarded by a PRAGMA existence check so re-running on an already
// upgraded (e.g. deployed) DB never throws "duplicate column name".
export const COLUMN_MIGRATIONS: ColumnMigration[] = [
  {
    table: "dishes",
    column: "course",
    ddl: "ALTER TABLE dishes ADD COLUMN course TEXT CHECK(course IN ('first','second'))",
  },
  {
    table: "dishes",
    column: "keeps_days",
    ddl: "ALTER TABLE dishes ADD COLUMN keeps_days INTEGER NOT NULL DEFAULT 1",
  },
];

export function applyColumnMigrations(db: Database): void {
  for (const m of COLUMN_MIGRATIONS) {
    const cols = db.query(`PRAGMA table_info(${m.table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === m.column)) db.run(m.ddl);
  }
}

export const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS dishes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name_ru TEXT NOT NULL, name_ua TEXT, name_de TEXT,
     cuisine TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
     servings INTEGER NOT NULL DEFAULT 4
   );`,
  `CREATE TABLE IF NOT EXISTS ingredients (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     dish_id INTEGER NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
     canonical_name TEXT NOT NULL, qty REAL, unit TEXT
   );`,
  `CREATE TABLE IF NOT EXISTS synonyms (
     canonical_name TEXT PRIMARY KEY,
     search_terms_de TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS match_cache (
     ingredient_canonical TEXT NOT NULL, week TEXT NOT NULL,
     offer_json TEXT, created_at TEXT NOT NULL,
     PRIMARY KEY (ingredient_canonical, week)
   );`,
  `CREATE TABLE IF NOT EXISTS offers (
     external_id INTEGER PRIMARY KEY, store TEXT, store_name TEXT,
     product TEXT, price REAL, old_price REAL, reference_price REAL,
     unit TEXT, valid_from TEXT, valid_to TEXT, fetched_at TEXT, is_stale INTEGER DEFAULT 0
   );`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`,
  `CREATE TABLE IF NOT EXISTS selection (
     week TEXT PRIMARY KEY,
     dish_ids_json TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS pantry (
     week TEXT PRIMARY KEY,
     items_json TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
];
