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
];
