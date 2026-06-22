# Annona — Pantry (P2 #12)

**Date:** 2026-06-22
**Status:** Design (approved)
**Builds on:** Phase 3 (menu editing, scaled shopping list, logger). Independent of other P2 items.

## 1. Overview

Today the shopping list (`/list`) names every ingredient of the week's dishes,
matched to the cheapest store offer. It does not know what the family already has
at home, so staples (salt, oil, rice) appear every week. Pantry lets the family
declare what they already have; those ingredients are removed from the list.

Scope decisions (from brainstorming):

- **Binary, not quantity-aware** — an ingredient is either at home or not. If it is,
  it is removed from the list entirely (no partial "buy 300g more").
- **Per-week** — pantry is scoped to the ISO week (like `selection`); it resets
  each week and is re-declared. No cross-week persistence.
- **Hidden + footer** — pantry ingredients are removed from store groups and from
  the "докупить" section, with a short `✅ Уже дома: …` footer for transparency.

## 2. Goals / Non-Goals

### Goals
- Declare pantry in free text (`у меня есть рис, лук`) or `/pantry рис, лук`.
- Remove from pantry (`закончился рис`, `убери из дома рис`).
- View the pantry (`/pantry`, `что дома`).
- `/list` excludes pantry ingredients from buy lines and the missing section, and
  shows an `✅ Уже дома: …` footer.

### Non-Goals
- **Quantity-aware subtraction** — binary only; no unit math (that is P2 #14/quantity work).
- **Cross-week persistence** — pantry resets per ISO week by design.
- **LLM normalization of pantry terms** — v1 matches on lowercased canonical strings;
  synonyms/typos are out of scope (a later enhancement could reuse the synonym/LLM path).
- **Auto-decrement on cooking** — there is no "cooked" signal; pantry changes only
  via explicit user messages.
- **Pantry affecting `/digest` or the menu** — pantry only affects the shopping list.

## 3. Architecture

Additive, mirroring the existing `selection(week)` model. A new per-week store, three
new intents behind the deterministic prefilter, three handlers, and a `pantry` filter
threaded into the shopping-list builder.

```
message:text
  └─ routeMessage(text)                    ← extended prefilter
        ├─ add_pantry      → handleAddPantry      → addToPantry
        ├─ remove_pantry   → handleRemovePantry   → removeFromPantry
        ├─ show_pantry     → handleShowPantry     → getPantry
        └─ (existing intents unchanged)
/list → getPantry(week) → buildGroupedList(dishes, matcher, plz, target, pantrySet)
        → store groups + missing EXCLUDE pantry; reply appends "✅ Уже дома: …"
```

## 4. Components

### 4.1 Data model — migration + `src/recipes/pantryStore.ts` (new)

`db/migrations.ts` gains one `CREATE TABLE IF NOT EXISTS` (idempotent, ordered):

```sql
CREATE TABLE IF NOT EXISTS pantry (
  week TEXT PRIMARY KEY,
  items_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`pantryStore.ts` (RMW JSON array of normalized canonical strings, mirrors
`selectionStore`):
- `getPantry(db, week): string[]` — returns `[]` if none.
- `addToPantry(db, week, items: string[]): void` — normalize each, union, dedupe, preserve order.
- `removeFromPantry(db, week, items: string[]): void` — normalize, filter out.

Normalization: lowercase + trim (a small `normalizePantryItem` helper; reuse
`normalize.ts` if its existing function fits, otherwise local).

### 4.2 Intent routing — `router.ts` + `types.ts`

`types.ts`: `IntentKind` gains `add_pantry | remove_pantry | show_pantry`.

`router.ts` patterns (case-insensitive; pantry-remove checked **before** the
week-removal verbs, like `delete_dish` precedes `remove_dishes`):

| Pattern | Intent | Extraction |
|---|---|---|
| `у меня есть X`, `есть дома X`, `дома есть X`, `/pantry X` | `add_pantry` | names split on `,` |
| `закончился X`, `закончилась X`, `закончились X`, `убери из дома X` | `remove_pantry` | names |
| `/pantry`, `что дома`, `что есть дома` (no item) | `show_pantry` | — |

Names pass through the existing `names()` cap (length-limited).

### 4.3 Handlers — `handlers.ts`

- `handleAddPantry(deps: { db; week }, names: string[]): string` — `addToPantry` →
  `"✅ Дома есть: <names>. Учту в /list."`; empty names → gentle prompt.
- `handleRemovePantry(deps: { db; week }, names: string[]): string` →
  `removeFromPantry` → `"✅ Убрал из дома: <names>."`
- `handleShowPantry(deps: { db; week }): string` → `getPantry`; non-empty →
  `"🏠 Дома есть: <items>"`, empty → `"Дома пока ничего не отмечено."`

### 4.4 Shopping-list integration — `shoppingList.ts` + `handleList`

`buildGroupedList(dishes, matcher, plz, targetServings?, pantry?: Set<string>)`:
- An ingredient whose normalized `canonical` is in `pantry` is skipped during
  aggregation — it never enters a store group or `missing`.
- Returns an added `inPantry: string[]` — the distinct catalogued ingredients that
  were skipped because they are in the pantry (for the footer). `GroupedShoppingList`
  type gains `inPantry: string[]`.

`handleList`:
- Reads `getPantry(deps.db, deps.week)` → `new Set(...)`, passes it in.
- Appends `\n✅ Уже дома: <inPantry joined>` when `inPantry` is non-empty.

## 5. Data Flow Examples

- **Declare:** `"у меня есть рис, лук"` → `add_pantry` → `addToPantry(week, [рис, лук])`
  → `"✅ Дома есть: рис, лук. Учту в /list."`
- **List:** `/list` → `getPantry` = {рис, лук} → builder skips рис/лук → reply has
  store groups without them + footer `✅ Уже дома: рис, лук`.
- **Deplete:** `"закончился рис"` → `remove_pantry` → `removeFromPantry(week, [рис])`
  → рис reappears on the next `/list`.
- **View:** `/pantry` → `🏠 Дома есть: лук`.

## 6. Error Handling & Edge Cases

- **Pantry-remove vs week-remove ambiguity** — resolved by prefilter precedence
  (`закончился`/`убери из дома` matched before `убери X`).
- **Empty names** — handlers reply with a gentle prompt; nothing stored.
- **Unknown ingredient** — pantry stores any normalized term; if it matches no dish
  ingredient this week it simply has no effect on the list (and is not echoed in the
  footer, since the footer lists only skipped *catalogued* ingredients).
- **Case / spacing** — normalization (lowercase+trim) makes "Рис " == "рис".
- **No selection / empty list** — unchanged behavior; pantry just filters whatever
  the list would contain.

## 7. Testing (TDD, pure-first)

- `pantryStore.test.ts` — add union/dedupe/normalize, remove only-matching, empty week.
- `router.test.ts` — each pantry pattern; `закончился X`/`убери из дома X` route to
  `remove_pantry` not `remove_dishes`; `/pantry` (no arg) → `show_pantry`.
- `shoppingList.test.ts` — pantry Set excludes matching ingredients from groups and
  missing; `inPantry` lists the skipped catalogued ingredients; case-insensitive match.
- `handlers.test.ts` — add/remove/show pantry replies; `handleList` footer.
- `bot.test.ts` — one integration: `"у меня есть рис"` persists; subsequent `/list`
  excludes it.

Verification: `bun test` green, `bunx tsc --noEmit` clean, manual smoke of §5.

## 8. Files Touched

| File | Action |
|---|---|
| `src/recipes/pantryStore.ts` | **new** — per-week pantry store |
| `src/db/migrations.ts` | add `pantry` table (idempotent) |
| `src/types.ts` | extend `IntentKind`; `GroupedShoppingList.inPantry` |
| `src/bot/router.ts` | pantry add/remove/show patterns |
| `src/bot/handlers.ts` | `handleAddPantry`/`handleRemovePantry`/`handleShowPantry` + `/list` footer |
| `src/shoppingList.ts` | `pantry` Set filter + `inPantry` output |
| `src/bot/bot.ts` | 3 switch cases + `/pantry` command |
| `tests/*` | pantryStore + router + shoppingList + handlers + bot |

No changes to `matcher`, `fetcher`, `providers`, `planner`, `recommender`.
