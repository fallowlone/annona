import { Database } from "bun:sqlite";
import { MIGRATIONS } from "./migrations";

export function openDb(path: string): Database {
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");
  for (const stmt of MIGRATIONS) db.run(stmt);
  return db;
}
