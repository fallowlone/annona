# Annona — Improvements Backlog

Prioritized by impact / effort. Captured 2026-06-22 after the Phase 3 release
(menu editing, portions, custom dishes, scaling) and a security review.

## P0 — done (2026-06-22)

- [x] Cap `MAX_SERVINGS=100` on `targetServings` (`src/bot/router.ts`).
- [x] Cap `MAX_DISH_NAME_LEN=120` on names before any LLM call (`src/bot/router.ts`).
- [x] Strip quote-breakout in the `generateDish` prompt (`src/recipes/recipeStore.ts`).
- [x] `git remote` + push `main` to the private GitHub repo.
- [ ] Document `HOUSEHOLD_SIZE=2` in `.env.example` — **blocked** by local
      permission settings (`.env*` denied); default works without it.

## P1 — quality / reliability

| # | Item | Why | Effort | Status |
|---|------|-----|--------|--------|
| 6 | CI: GitHub Actions running `bun test` + `bunx tsc --noEmit` | 151 tests exist but never run automatically | S | ✅ done — `.github/workflows/ci.yml`, green |
| 7 | Deploy from a clean git checkout, not the working tree | `deploy.sh` rsyncs local files — uncommitted/dirty state can ship | S | ✅ done — `git archive HEAD` + clean/pushed guards |
| 8 | Structured logger with levels (replace `console.*`) | `console.error(e)` can leak prompt/user data into logs; no levels | S | ✅ done — `src/log.ts` (JSON, `errInfo` redacts) |
| 9 | Custom-dish confirm/preview before persisting to the catalogue | LLM dishes are saved unchecked — garbage accumulates forever | M | |
| 10 | "Remove dish from catalogue" command | Catalogue only grows; no delete path | M | |
| 11 | Integration test for `bot.ts` routing | Only file with no automated coverage (manual smoke only) | M | |

## P2 — features (deferred non-goals)

| # | Item | Why | Effort |
|---|------|-----|--------|
| 12 | Pantry: subtract what's at home from the shopping list | Top deferred non-goal; list currently includes everything | L |
| 13 | Per-day pinning (manual override of `planWeek`) | Raised during refine, scoped out of Phase 3 | M |
| 14 | Unit conversion (kg↔g, ml↔l) in list aggregation | Mismatched units currently stay on separate lines | M |
| 15 | Scheduler: weekly auto-push of menu/list | Interaction is pull-only today | L |
| 16 | Week budget: total cost of the shopping list | Per-item prices exist, no total | S |
| 17 | Cache `generateDish` / reuse synonyms for custom dishes | One LLM call per new dish | S |

## P3 — observability / ops

| # | Item | Effort |
|---|------|--------|
| 18 | Docker healthcheck (bot alive / last update age) | S |
| 19 | LLM cost metrics (call/token counters) | M |
| 20 | SQLite volume backup (cron dump) | S |

## Notes

- Threat model is a 2-user, Telegram-allowlisted home bot with no public HTTP
  surface; severity and priority are calibrated to that.
- No DB migrations were needed for Phase 3; selection stays a JSON id array and
  custom dishes reuse the existing `dishes`/`ingredients` tables.
