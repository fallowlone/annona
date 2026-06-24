import type { Database } from "bun:sqlite";

/** A dish pinned to a 1-based day of the week's menu. */
export type StoredPin = { day: number; dishId: number };

/** Return the week's day-pins, or [] if none. */
export function getPins(db: Database, week: string): StoredPin[] {
  const row = db.query("SELECT pins_json FROM day_pins WHERE week = ?").get(week) as
    | { pins_json: string }
    | null;
  return row ? (JSON.parse(row.pins_json) as StoredPin[]) : [];
}

/** Overwrite the week's day-pins. */
export function savePins(db: Database, week: string, pins: StoredPin[]): void {
  db.run(
    "INSERT OR REPLACE INTO day_pins(week, pins_json, updated_at) VALUES(?, ?, ?)",
    [week, JSON.stringify(pins), new Date().toISOString()]
  );
}

/** Drop every pin on `day` (used by "открепи <день>"). */
export function removePinsForDay(db: Database, week: string, day: number): void {
  savePins(db, week, getPins(db, week).filter((p) => p.day !== day));
}
