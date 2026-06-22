# Annona Phase 3 — Menu Editing, Portions, Custom Dishes, Scaling

**Date:** 2026-06-22
**Status:** Design (approved)
**Builds on:** Phase 2 (weekly menu planner, store-grouped shopping list, LLM intent router)

## 1. Overview

Phase 2 lets the family pick dishes in free text and get a 7-day menu plus a
store-grouped shopping list. Phase 3 makes the weekly menu *editable* and adds
quantity awareness:

- **Edit the week incrementally** — add or remove individual dishes without
  retyping the whole list (today `handleSelect` overwrites the selection wholesale).
- **Portion coverage** — show each dish's servings and how many days it covers
  for the household.
- **Custom dishes by text** — the user types a dish name, the LLM fills in its
  ingredients/quantities, and it is saved to the catalogue permanently.
- **Ingredient scaling calculator** — scale a dish's ingredient quantities to a
  desired number of portions, and surface real quantities in the shopping list.

No new database schema is required — all four features reuse existing tables and
config. This keeps Phase 3 the lowest-risk increment on top of Phase 2.

## 2. Goals / Non-Goals

### Goals
- Incremental selection edits: `добавь <блюдо>` merges, `убери <блюдо>` removes,
  leaving the rest of the week intact. Explicit comma-lists still replace.
- Display servings and `хватит ~K дн. (семья H)` coverage in `/menu` and `/digest`.
- Add a custom dish by name; the LLM generates its full record; it persists to
  the `dishes` catalogue and is available in future weeks. Idempotent by `name_ru`.
- A pure scaling function and a per-dish command (`<блюдо> на N порций`) returning
  scaled ingredient quantities.
- Surface scaled quantities in the shopping list (`/list`), aggregated per
  ingredient, never summing incompatible units.

### Non-Goals
- **Pantry** (what's already at home) — still not subtracted.
- **Scheduler / proactive push** — interaction stays pull-based.
- **Per-day pinning / manual day overrides** — `planWeek` layout is unchanged;
  editing operates on the *set* of dishes, not their day placement.
- **New offers provider / matcher / fetcher changes** — untouched.
- **Database schema changes** — selection stays a JSON id array; custom dishes
  use the existing `dishes`/`ingredients` tables.
- **Unit conversion** — quantities in mismatched units for the same ingredient are
  shown on separate lines, never converted or summed.

## 3. Architecture

Phase 3 is additive. New pure modules (`router.ts`, `scale.ts`, portion helper)
are I/O-free and unit-tested first. Bot wiring gains a deterministic prefilter in
front of the existing LLM intent router.

```
message:text
  └─ routeMessage(text)            ← NEW pure keyword prefilter
        ├─ matched → Intent {add_dishes | remove_dishes | add_custom_dish | scale_dish}
        └─ null    → classifyIntent (existing LLM router: suggest|select|menu|list|help)
  └─ switch(intent.kind)
        ├─ add_dishes       → handleAddDishes      → addToSelection
        ├─ remove_dishes    → handleRemoveDishes   → removeFromSelection
        ├─ add_custom_dish  → handleAddCustomDish  → generateDish → insertDish
        ├─ scale_dish       → handleScaleDish      → scaleIngredients
        ├─ select_dishes    → handleSelect (replace, unchanged)
        └─ show_menu | show_list | suggest | help (unchanged, + coverage display)
```

## 4. Components

### 4.1 Intent routing — `src/bot/router.ts` (new, pure)

`routeMessage(text: string): Intent | null` runs before any LLM call. Matching is
case-insensitive on the trimmed message; longer/more-specific prefixes are tested
first so `add_custom_dish` wins over `add_dishes`.

| Pattern (RU) | Intent kind | Extraction |
|---|---|---|
| `добавь блюдо …`, `новое блюдо …`, `/recipe …` | `add_custom_dish` | dish name = remainder |
| `добавь …`, `+ …` | `add_dishes` | names split on `,` |
| `убери …`, `удали …`, `минус …`, `- …` | `remove_dishes` | names split on `,` |
| `… на <N> порц[ий]` (trailing-number regex) | `scale_dish` | dishName + targetServings = N |
| anything else | `null` | fall through to `classifyIntent` |

`types.ts` changes:
- `IntentKind` gains `add_dishes | remove_dishes | add_custom_dish | scale_dish`.
- `Intent` gains optional `targetServings?: number` (used by `scale_dish`).

### 4.2 Selection editing — `src/recipes/selectionStore.ts` + `src/bot/handlers.ts`

`selectionStore.ts` (read-modify-write the JSON id array, immutable):
- `addToSelection(db, week, ids: number[]): void` — union with current, dedupe,
  preserve first-seen order. Seeds a new row if none exists.
- `removeFromSelection(db, week, ids: number[]): void` — filter out the ids.

`handlers.ts`:
- `handleSelect` — unchanged (explicit comma-list = replace).
- `handleAddDishes(deps, dishNames)` — `resolveDishes` → `addToSelection` →
  `"✅ добавил <names>. /menu — меню."`; report unmatched.
- `handleRemoveDishes(deps, dishNames)` — `resolveDishes` against the **current
  selection's** dishes → `removeFromSelection` → `"✅ убрал <names>."`; if a name
  isn't in the current selection, say so.

### 4.3 Portion coverage — `src/config.ts` + `src/portions.ts` (new, pure)

- `config.ts`: add `HOUSEHOLD_SIZE` (`z.coerce.number().int().positive().default(2)`),
  surfaced as `householdSize` on `Config`.
- `portions.ts`: `coverageDays(servings: number, householdSize: number): number`
  = `Math.max(1, Math.floor(servings / householdSize))` (1 portion/person/day).
- `handleMenu` and `handleRecommend` append `· N порц. · хватит ~K дн. (семья H)`
  to each dish line. `householdSize` is threaded through the handler deps and
  `bot.ts` from `Config`.

### 4.4 Custom dishes — `src/recipes/recipeStore.ts` + `handlers.ts`

- `generateDish(llm, name): Promise<Dish>` — one-dish structured LLM call reusing
  the single `DishSchema` (the element schema already inside `DishSeedSchema`). Same
  system/prompt shape as `seedDishes`, German-supermarket ingredients, RU canonical
  names. Returns a validated `Dish`.
- `handleAddCustomDish(deps, name)`:
  1. Idempotency: if `dishes.name_ru` already has `name` (case-insensitive),
     reply `"«<name>» уже в каталоге."` and stop.
  2. `generateDish` → `insertDish` (existing transaction).
  3. Reply `"✅ <nameRu> (<servings> порц., <n> ингр.) добавил в каталог."`
- The dish lives in `dishes` permanently and is available to future weeks. The
  in-memory `dishes` array passed to handlers is refreshed from the DB after insert
  (see 4.6).

### 4.5 Scaling — `src/scale.ts` (new, pure) + `src/shoppingList.ts`

- `scaleIngredients(ingredients, baseServings, targetServings): Ingredient[]`:
  - `qty` → `qty * targetServings / baseServings`, rounded: `≥10` → integer,
    else 1 decimal.
  - `qty === null` → stays `null` (rendered "по вкусу" / no quantity).
  - Guard: `baseServings <= 0` → return ingredients unchanged.
  - Pure, immutable (returns new array of new objects).
- `buildGroupedList(dishes, matcher, plz, targetServings = householdSize)`:
  - For each dish, `scaleIngredients(dish.ingredients, dish.servings, targetServings)`.
  - Aggregate per `canonical`: sum `qty` **only when `unit` matches**; ingredients
    with differing units for the same canonical are kept as separate aggregated
    entries. `qty === null` contributions don't force a number onto the line.
  - Existing store-grouping / cheapest-offer logic is unchanged; the rendered line
    now includes the aggregated quantity+unit when known.
- `handleScaleDish(deps, name, targetServings)` — `resolveDishes` for one dish →
  `scaleIngredients(dish.ingredients, dish.servings, N)` → reply with the scaled
  ingredient list (quantities only, no offers). Does **not** modify the selection.

### 4.6 Wiring — `src/bot/bot.ts`

- `message:text`: call `routeMessage(text)`; if `null`, call `classifyIntent`.
- `switch` gains `add_dishes`, `remove_dishes`, `add_custom_dish`, `scale_dish`.
- Optional thin slash commands: `/add`, `/remove`, `/recipe` mapping to the same
  handlers; `/list` output now carries quantities.
- After `handleAddCustomDish` inserts a dish, the handler returns the new `Dish`
  so `bot.ts` can append it to its in-memory `dishes` array (or re-`listDishes`),
  keeping the catalogue fresh within the running process.

## 5. Data Flow Examples

- **Add:** `"добавь плов"` → `routeMessage` → `add_dishes` → resolve → `addToSelection`
  → `"✅ добавил Плов. /menu"`. Existing dishes untouched.
- **Remove:** `"убери борщ"` → `remove_dishes` → resolve vs current selection →
  `removeFromSelection` → `"✅ убрал Борщ."`
- **Coverage:** `/menu` → `planWeek` → each line `🥣 Борщ — 6 порц. · хватит ~3 дн. (семья 2)`.
- **Custom:** `"добавь блюдо шакшука"` → `add_custom_dish` → `generateDish` →
  `insertDish` → `"✅ Шакшука (4 порц., 6 ингр.) добавил в каталог."`
- **Scale (dish):** `"плов на 8 порций"` → `scale_dish` → `scaleIngredients` →
  `"🍳 Плов ×8: рис 400г · морковь 600г · мясо 800г"`.
- **Scale (list):** `/list` → `buildGroupedList(..., householdSize)` → per-store
  lines with aggregated scaled quantities.

## 6. Error Handling & Edge Cases

- **select-vs-add ambiguity** — resolved by the deterministic prefilter; only
  explicit verbs route to add/remove, everything else falls to the LLM.
- **Duplicate custom dish** — idempotency check by `name_ru`, informs and stops.
- **`qty === null`** — preserved through scaling and aggregation; never coerced to 0.
- **Incompatible units** — same canonical with different units never summed; shown
  separately.
- **`baseServings <= 0`** — scaling returns unchanged input (no divide-by-zero).
- **Empty / missing selection** — existing `NO_SELECTION` messaging reused; removing
  a dish that isn't selected reports it as not found.
- **Unmatched names** — `resolveDishes` already returns `unmatched`; surfaced in
  add/remove replies.
- **LLM failure on custom dish** — handler wrapped by the existing `guard`; user
  gets the generic retry message, nothing is persisted.

## 7. Testing (TDD, pure-first)

Write tests before implementation for every pure unit:

- `router.test.ts` — each pattern, prefix precedence (`добавь блюдо` vs `добавь`),
  trailing-number scale regex, fallthrough → `null`.
- `scale.test.ts` — scale up/down, rounding bands (≥10 integer, <10 one decimal),
  `qty=null` passthrough, `baseServings=0` guard, immutability.
- `portions.test.ts` — `coverageDays` floor, min-1 clamp.
- `selectionStore.test.ts` — `addToSelection` union/dedupe/order, new-row seed;
  `removeFromSelection` removes only matching, no-op on missing.
- `shoppingList.test.ts` — aggregation sums same-unit, splits mismatched units,
  null-qty handling, target-servings scaling.
- Handler integration tests with a mock `Llm` for add/remove/custom/scale.

Verification: `bun test` green, `bunx tsc --noEmit` clean, manual smoke of the six
data-flow scenarios.

## 8. Files Touched

| File | Change |
|---|---|
| `src/bot/router.ts` | **new** — pure keyword prefilter |
| `src/scale.ts` | **new** — pure `scaleIngredients` |
| `src/portions.ts` | **new** — pure `coverageDays` |
| `src/types.ts` | extend `IntentKind`, `Intent.targetServings?` |
| `src/config.ts` | add `HOUSEHOLD_SIZE` / `householdSize` |
| `src/recipes/selectionStore.ts` | add `addToSelection`, `removeFromSelection` |
| `src/recipes/recipeStore.ts` | add `generateDish` |
| `src/shoppingList.ts` | scaled, unit-aware aggregation + quantities |
| `src/bot/handlers.ts` | add/remove/custom/scale handlers + coverage display |
| `src/bot/bot.ts` | prefilter wiring, new switch cases, slash commands |
| `tests/*` | new pure-unit + handler integration tests |

No migration files. No changes to `matcher`, `fetcher`, `providers/marktguru`,
`recommender` (beyond the display string in its handler).
