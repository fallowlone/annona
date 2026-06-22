import type { Database } from "bun:sqlite";

/** Normalize a pantry term so matching is case/space-insensitive. */
export function normalizePantryItem(s: string): string {
  return s.trim().toLowerCase();
}

/** Return the normalized pantry items for an ISO week, or [] if none. */
export function getPantry(db: Database, week: string): string[] {
  const row = db
    .query("SELECT items_json FROM pantry WHERE week = ?")
    .get(week) as { items_json: string } | null;
  return row ? (JSON.parse(row.items_json) as string[]) : [];
}

function save(db: Database, week: string, items: string[]): void {
  db.run(
    "INSERT OR REPLACE INTO pantry(week, items_json, updated_at) VALUES(?, ?, ?)",
    [week, JSON.stringify(items), new Date().toISOString()]
  );
}

/** Merge normalized items into the week's pantry (union, dedupe, first-seen order). */
export function addToPantry(db: Database, week: string, items: string[]): void {
  const merged = [...getPantry(db, week)];
  for (const raw of items) {
    const item = normalizePantryItem(raw);
    if (item && !merged.includes(item)) merged.push(item);
  }
  save(db, week, merged);
}

/** Remove normalized items from the week's pantry. No-op if absent. */
export function removeFromPantry(db: Database, week: string, items: string[]): void {
  const current = getPantry(db, week);
  if (current.length === 0) return;
  const remove = new Set(items.map(normalizePantryItem));
  save(db, week, current.filter((i) => !remove.has(i)));
}
