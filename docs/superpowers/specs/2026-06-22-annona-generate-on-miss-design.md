# Annona — Generate-on-miss dish recognition + CIS classics seed

Date: 2026-06-22
Status: Design approved, pending spec review

## 1. Overview

Today the bot recognizes a dish the user names only if it already exists in the
`dishes` catalogue. The weekly-selection path (`select_dishes` / `add_dishes`)
calls `resolveDishes(llm, catalogue, names)`, which matches names to catalogue
ids (LLM-assisted, RU/UA synonyms included). Names with no catalogue match are
reported back verbatim as `Не нашёл: <name>` and dropped — even though the bot
already has an LLM path (`generateDish`) that can produce a full recipe for any
dish, including CIS classics like *солянка*.

The user hit this with «мясная/сборная солянка» listed among the week's dishes:
the bot replied «Не нашёл», because солянка was not seeded and the selection path
has no fallback to generation.

This change closes that gap two ways:

- **A — generate-on-miss:** when the selection path returns unmatched names, the
  bot offers to generate each via the existing `generateDish` + confirm flow.
  Confirmed dishes persist to the catalogue (so future synonyms resolve) **and**
  are added to the current week.
- **C — CIS classics seed:** guarantee a curated list of CIS staples (incl.
  солянка) in the default catalogue so the most common dishes never miss.

We explicitly rejected wiring an external public recipe API (Spoonacular /
Edamam / TheMealDB): weak CIS coverage, English-centric, no RU synonym handling,
ingredient names that need re-translation to RU canonical names and re-mapping to
German-supermarket products, plus API keys, rate limits, network failure modes,
and cost. For this product the Haiku LLM is strictly the better recipe source.

## 2. Goals / Non-Goals

### Goals
- Any dish the user lists in the weekly-selection path that is not in the
  catalogue triggers an offer to generate it (confirm with ✅/❌, reusing the
  existing preview flow).
- A confirmed generated dish is persisted to the catalogue and added to the
  current ISO week's selection.
- Multiple unmatched names in one message are handled **one at a time via a
  queue**: confirm/cancel one, then the next is offered.
- The default seed guarantees a curated `CIS_CLASSICS` list (idempotent).

### Non-Goals
- No external recipe API.
- No new database schema or tables.
- No new dependencies.
- No auto-generation without confirmation (the user chose confirm-first to guard
  against typos / non-dishes).
- No change to the standalone `/recipe` custom-dish flow's existing semantics
  (it stays as-is; we only add a week-aware variant of the confirm step).

## 3. Affected components

- `src/bot/handlers.ts` — `handleSelect` / `handleAddDishes`: stop folding
  `unmatched` into a `Не нашёл:` text tail; instead return the matched-save
  result **plus** the list of unmatched names so the caller can drive generation.
- `src/bot/bot.ts` — orchestrate the confirm flow with a per-user **queue** of
  unmatched names and a "add to week" flag.
- `src/recipes/recipeStore.ts` — `seedDishes`: ensure every `CIS_CLASSICS` entry
  is present (generate only the missing ones; idempotent by `name_ru`).

No DB schema change. No new dependency.

## 4. Data flow — selection path

1. `resolveDishes(names)` → `{ matched, unmatched }`.
2. Save / merge `matched` into the week's selection (unchanged behavior:
   `handleSelect` replaces, `handleAddDishes` merges).
3. Reply confirms what was saved. If `unmatched` is non-empty:
   - Reply: `Не нашёл в каталоге: X, Y. Сгенерировать рецепт?`
   - Generate a preview for the **first** unmatched name (`generateDish` →
     ingredients + ✅/❌ keyboard). Remaining names go into the queue (generated
     lazily when reached, never all at once).
4. On ✅ (`dish_save`): persist the dish → refresh in-memory `dishes` → if the
   pending state carries a week, `addToSelection(week, dishId)` → if the queue
   has more names, generate and show the next preview; else send a final summary
   («Готово: добавил солянка, рассольник в неделю и каталог.»).
5. On ❌ (`dish_cancel`): skip this name → if the queue has more, show the next;
   else final summary listing what was skipped.

## 5. Per-user state

Extend the existing in-memory pending mechanism (sibling of `pendingDish` /
`pendingDelete` maps in `bot.ts` — no persistence):

- `pendingDish: Dish` — the currently previewed generated dish (exists today).
- `pendingQueue: string[]` — remaining unmatched names to offer next.
- `pendingAddWeek?: string` — ISO week to add confirmed dishes to. Set when the
  flow originates from `select`/`add`; unset for the plain `/recipe` flow, which
  keeps its current catalogue-only behavior.

A small helper advances the queue: pop the next name, run `generateDish`, set
`pendingDish`, and emit the next preview. Used by both `dish_save` and
`dish_cancel` callbacks and by the initial selection reply.

The `dishExists(nameRu)` idempotency guard already prevents duplicates: if a
generated dish's canonical name collides with an existing catalogue entry, we do
not insert a duplicate — we add the existing dish to the week instead.

## 6. Error handling

- `generateDish` failure (LLM / network): caught so it does not abort the queue.
  Skip the failing name, advance to the next, and report in the final summary
  («Не получилось сгенерировать «X», попробуй позже.»). The existing `guard`
  wrapper remains the outer safety net.
- Empty / whitespace name: skipped (already guarded; `MAX_DISH_NAME_LEN` caps
  length, mirroring the `/recipe` path).
- Concurrency: pending state is keyed per Telegram user id, consistent with the
  current `pendingDish` / `pendingDelete` design. Starting a new selection flow
  while one is pending replaces the prior pending state for that user.

## 7. Approach C — CIS_CLASSICS seed

- Add `CIS_CLASSICS: string[]` to `recipeStore.ts`: a curated list of CIS staples.
  Working list (final list refined in the plan): солянка мясная сборная,
  рассольник, окрошка, борщ, плов, голубцы, вареники с картошкой, пельмени,
  гречка с грибами, оливье, винегрет, котлеты с пюре.
- `seedDishes(db, llm, target)` first ensures each `CIS_CLASSICS` name is present
  (generate via the existing single/batch path only for those missing by
  `name_ru`), then tops up to `target` as today. Fully idempotent: a second run
  adds nothing.
- Applied to prod with a one-off `seed.ts` run after deploy. Pre-existing
  catalogues gain only the missing classics.

## 8. Testing (TDD, `bun test`)

- `tests/handlers.test.ts`:
  - `handleSelect` / `handleAddDishes` with all-matched names behave as today.
  - With unmatched names: matched are still saved/merged, and the result exposes
    the unmatched names for the caller to drive generation (no silent
    `Не нашёл:` drop).
- `tests/bot.test.ts` (or a focused harness around the callbacks):
  - Select with one unmatched → one preview; ✅ adds the dish to both catalogue
    and the week's selection.
  - Select with two unmatched → previews offered in sequence; ✅/❌ advance the
    queue; final summary reflects added vs skipped.
  - `generateDish` throwing for a queued name skips it without crashing and is
    reported in the summary.
- `tests/recipeStore.test.ts`:
  - `seedDishes` guarantees every `CIS_CLASSICS` entry exists after a run.
  - Idempotent: running `seedDishes` twice does not duplicate classics.

## 9. Rollout

1. Implement on branch `generate-on-miss` (TDD, tsc clean, `bun test` green).
2. PR → review (subagent-driven: implementer + reviewer, final opus) → merge.
3. `./deploy.sh` to `home`.
4. One-off `seed.ts` run to top up prod catalogue with CIS classics.
5. Telegram smoke: list «борщ, солянка, гречка» → confirm солянка preview → ✅ →
   `/menu` and `/list` include солянка; re-listing «сборная солянка» resolves to
   the now-cataloged dish without a new prompt.
