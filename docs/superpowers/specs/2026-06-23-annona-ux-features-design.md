# Annona bot UX + features (Spec 1) — Design

**Date:** 2026-06-23
**Status:** Approved (brainstorming)
**Scope:** Bot UX overhaul + three feature additions. The "cheapest non-sale price via store scraping" request is **deferred to a separate Spec 2** (large independent scraping subsystem).

## Goal

Give the Annona meal-planning bot a button-driven menu UI, let the user browse recipes (with on-demand cooking steps), show an approximate per-dish cost, and drop the Kaufland store.

## Background (current state)

- grammY `1.44.0`, no plugins. Flat commands (`/menu /list /digest /recipe …`) + free-text routing + three hand-rolled confirm-button pairs. No menu tree, no pagination.
- `Dish` (`src/types.ts:22-33`) holds name(s), cuisine, course, keepsDays, tags, servings, ingredients. **No cooking steps stored anywhere.** `renderDishPreview` (`src/bot/handlers.ts:203-213`) shows only an ingredient line.
- Shopping list (`src/shoppingList.ts` → `handleList` `src/bot/handlers.ts:137`) merges all selected dishes' ingredients by `canonical`, scales to `HOUSEHOLD_SIZE`, groups by store, renders Markdown. No per-dish cost. `recommender.ts:16-20` computes a rough `estTotal` (sum of winning sale-offer prices) used only by `/digest`.
- Stores: `STORE_KEYS` (`src/stores.ts:4-13`, 8 stores incl. `kaufland`), `STORE_WHITELIST` env (`src/config.ts:23-27`, default = all 8) applied in `matcher.ts:58-63`.
- marktguru returns **only active sale offers**; non-matched ingredients fall into the "Докупить (не в акции)" tail with no price.

## Decisions (locked in brainstorming)

1. **Recipe viewing — hybrid lazy steps.** Card shows ingredients immediately; a "📖 Показать рецепт" button generates cooking steps via LLM **on demand**, persists them, and renders. No mass LLM backfill of the catalogue.
2. **Per-dish cost — approximate, labelled.** Sum of winning sale-offer prices for the dish's ingredients (non-sale ingredients count as 0). Shown in the recipe card, in `/menu` rows, and as a per-dish breakdown + grand total in `/list`. Labelled **"(по акциям)"** so the user understands it is a sale-only lower bound (true regular prices arrive in Spec 2).
3. **UI — full menu tree.** A main menu hub, a paginated recipe browser, and dish cards with action buttons; in-place navigation via `editMessageText`. Existing commands stay as shortcuts.
4. **Stack — `@grammyjs/menu`** (first-party plugin) for navigation/pagination/stale-menu handling. **HTML parse mode** for touched surfaces (less escaping pain than MarkdownV2), with an `esc()` helper. `<blockquote expandable>` for long recipe steps.
5. **Kaufland — soft removal:** drop `kaufland` from the default `STORE_WHITELIST` in `config.ts` (and seeds/docs). Prod `.env` is user-managed; if it lists kaufland explicitly the user removes it there.

## Global Constraints

- Default to Bun: `bun test`, `bun:sqlite`, grammY. No `node`.
- One new dependency allowed: `@grammyjs/menu` (first-party grammY plugin). No others.
- No external recipe/price API (that is Spec 2).
- DB change limited to a single additive, idempotent column (`dishes.steps TEXT` nullable) via the existing `COLUMN_MIGRATIONS` mechanism — no new tables.
- All user-facing strings in Russian.
- Recipe-step cost labelled "(по акциям)" wherever a per-dish/total € figure appears.
- Immutable update patterns; `bunx tsc --noEmit` clean and `bun test` green before every commit.
- TDD: failing test first, watch fail, implement minimally, watch pass, commit.
- Do not rewrite messages/surfaces the work does not touch; do not restructure unrelated code.

## Components

### 1. HTML rendering foundation
- A shared `esc(s: string): string` (escapes `& < >`) and a default `parse_mode: "HTML"` on the surfaces this spec touches (hub, recipe browser, dish card, `/menu`, `/list`).
- Convert touched renderers from Markdown (`*bold*`, `[text](url)`) to HTML (`<b>`, `<a href>`). Untouched messages keep their current mode.

### 2. Recipe steps (`src/recipes/recipeStore.ts` + `src/db/migrations.ts` + `src/types.ts`)
- Add `dishes.steps TEXT` (nullable) to `COLUMN_MIGRATIONS` (idempotent, mirrors the pantry column migration).
- `Dish.steps?: string | null`.
- `dishSteps(db, id): string | null` and `saveDishSteps(db, id, steps): void`.
- `generateSteps(llm, dish): Promise<string>` — LLM tool-use call producing numbered Russian cooking steps from the dish name + ingredients (reuse the `Llm.structured` pattern).
- New-dish creation (`generateDish`) is unchanged; `steps` stays null and is filled lazily on first "Показать рецепт".

### 3. Per-dish cost (`src/cost.ts`)
- Extract the `estTotal` logic from `recommender.ts` into a shared `estimateDishCost(deps: { matcher; week }, dish, servings): Promise<number>` (sum of winning sale-offer prices over the dish's scaled ingredients; reuses the match cache). `recommender` and the new surfaces both call it (DRY).
- Returns a number; callers render "~X.XX€ (по акциям)".

### 4. Store removal (`src/config.ts`, seeds/docs)
- Default `STORE_WHITELIST` becomes the 7-store list without `kaufland`.

### 5. Menu layer (`src/bot/menus/`, `@grammyjs/menu`)
- `mainMenu`: 📋 Меню недели · 🛒 Покупки · 📖 Рецепты · 🍳 Что приготовить · 🥫 Кладовка · ➕ Добавить.
- `recipesMenu`: dynamic, paginated (`menu.dynamic`) over `listDishes(db)` (~6–8 per page), ⬅️/➡️/🏠. Dish id carried via menu payload.
- `dishCard`: name · course · servings · "~cost (по акциям)" · ingredients; buttons 📖 Показать рецепт · ➕ В меню · 🗑 Удалить (confirm) · ⬅️ Назад. Actions mutate selection/catalogue via existing stores, then `ctx.menu.update()`.
- "Показать рецепт" lazily generates+persists steps (component 2) and renders them in an expandable blockquote.
- Hub shown on `/start` and `/menu`; all existing commands remain working shortcuts.

## Data flow

`/start` or `/menu` → render hub. Button tap → `editMessageText` swaps to the submenu in place. Recipe browser pages via payload-encoded offset. Dish card actions call `addToSelection` / `deleteDish` / lazy `generateSteps`, then `ctx.menu.update()` re-renders. Per-dish cost is computed via `estimateDishCost` (warm cache after `/list`).

## Error handling

- `generateSteps` failure → reply "Не получилось собрать рецепт, попробуй ещё раз"; menu stays intact, steps not persisted.
- `estimateDishCost` failure / no offers → render "~?" or omit the figure; never crash.
- Stale/expired menu taps → handled by `@grammyjs/menu`'s layout fingerprinting.
- Existing per-user in-memory pending maps (`pendingGen` etc.) untouched.

## Testing

- Unit (pure): `estimateDishCost`; `dishSteps`/`saveDishSteps` round-trip + lazy-generate-once; HTML dish-card render; `/list` per-dish breakdown + grand total; recipe-browser pagination slice helper; `esc()`.
- Integration (bot harness): a menu callback edits the message in place; existing `gen_yes`/`dish_save` flows still pass.
- `bun test` green, `bunx tsc --noEmit` clean, output pristine.

## Decomposition (for the plan, ~7 tasks)

1. HTML rendering foundation (`esc`, HTML parse mode on touched surfaces).
2. Remove Kaufland from default whitelist + seeds/docs.
3. `dishes.steps` column + `Dish.steps` + `dishSteps`/`saveDishSteps` + `generateSteps`.
4. `estimateDishCost` extracted into `src/cost.ts` (DRY with `recommender`).
5. `@grammyjs/menu` install + `mainMenu` hub wired to `/start` + `/menu`.
6. Recipe browser (paginated) + dish card + actions + lazy "Показать рецепт".
7. Per-dish cost surfaced in `/menu` rows, recipe card, and `/list` (breakdown + total).

## Non-goals (this spec)

- No store scraping / regular (non-sale) prices — **Spec 2**.
- No mass LLM backfill of recipe steps.
- No Mini App / web view.
- No new DB tables; no rewrite of untouched messages.
- No payments, checklists-API, or other bleeding-edge Bot API features (verify availability before any future use).
