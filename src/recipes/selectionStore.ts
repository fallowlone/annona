import type { Database } from "bun:sqlite";

/** Persist the chosen dish ids for an ISO week (overwrites any existing row). */
export function saveSelection(db: Database, week: string, dishIds: number[]): void {
  db.run(
    "INSERT OR REPLACE INTO selection(week, dish_ids_json, updated_at) VALUES(?, ?, ?)",
    [week, JSON.stringify(dishIds), new Date().toISOString()]
  );
}

/** Return the chosen dish ids for an ISO week, or null if none saved. */
export function getSelection(db: Database, week: string): number[] | null {
  const row = db
    .query("SELECT dish_ids_json FROM selection WHERE week = ?")
    .get(week) as { dish_ids_json: string } | null;
  return row ? (JSON.parse(row.dish_ids_json) as number[]) : null;
}

/** Merge ids into the week's selection (union, dedupe, first-seen order). */
export function addToSelection(db: Database, week: string, dishIds: number[]): void {
  const current = getSelection(db, week) ?? [];
  const merged = [...current];
  for (const id of dishIds) {
    if (!merged.includes(id)) merged.push(id);
  }
  saveSelection(db, week, merged);
}

/** Remove ids from the week's selection. No-op if the week or ids are absent. */
export function removeFromSelection(db: Database, week: string, dishIds: number[]): void {
  const current = getSelection(db, week);
  if (!current) return;
  const remove = new Set(dishIds);
  saveSelection(db, week, current.filter((id) => !remove.has(id)));
}
