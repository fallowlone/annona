# Annona Phase 2 — Store-Filtered Deals, 100+ Dishes, and a Weekly Menu Planner

**Date:** 2026-06-21
**Status:** Design approved (pending spec review)
**Builds on:** Phase 1 (walking skeleton, merged to `main`). See `2026-06-21-annona-design.md`.

## 1. Overview

Phase 1 ships a deal-driven *recommender*: the bot looks at this week's German
supermarket promotions and suggests the cheapest dishes to cook. Phase 2 turns
Annona into a *weekly menu planner* the family drives:

- deals are restricted to a fixed set of stores the family actually shops at,
  each shown with an Apple Maps link;
- the dish catalogue grows to 100+ (CIS-heavy plus popular world dishes);
- the family picks dishes in plain text; the bot lays out a 7-day menu (a first
  and a second course each day, repeating long-keeping dishes to fill the week)
  and produces one shopping list grouped by store.

The work is two layers. **Layer 1 (Foundation)** — store filtering, Maps links,
the 100+ catalogue with course/keeping metadata, the coverage threshold, and
compact "cook-rarely" suggestions — is independently shippable and improves the
existing `/digest`. **Layer 2 (Planner)** — text dish selection, the weekly menu,
the grouped shopping list, and an LLM intent router — is built on top. Each layer
gets its own implementation plan.

## 2. Goals / Non-Goals

### Goals
- Restrict offers to a configured store whitelist; show each store with an Apple
  Maps search link.
- Grow the dish catalogue to 100+, tagged by course (first/second) and keeping
  duration; make seeding idempotent (re-running never duplicates).
- Rank/suggest only dishes whose ingredients are ≥70% on offer (configurable),
  favouring long-keeping dishes and keeping the suggestion list short.
- Let the family select dishes in free text and receive a 7-day menu plus one
  store-grouped shopping list.

### Non-Goals (deferred to a later phase)
- **Pantry** (what's already at home) — not subtracted from the shopping list yet.
- **Automatic scheduler / proactive weekly push** — interaction stays pull
  (on-demand); the weekly offer cache from Phase 1 is reused.
- **Precise quantities / package math** — the shopping list names ingredients and
  which dishes need them, not grams or pack counts.
- **Per-store geolocation / walking distance to Schünemannplatz** — the whitelist
  chains in PLZ 30459 are the proxy; Maps links are chain+area searches.

## 3. Key Decisions (with rationale)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Store whitelist (config), offers filtered before ranking** | The family shops at a known set; filtering removes noise and irrelevant chains. |
| 2 | **Apple Maps = chain+PLZ search URL** | No address/geocoding needed; `maps.apple.com/?q=Lidl+30459` opens the nearest branch on the phone. |
| 3 | **Coverage threshold by ratio (≥0.7)** | Adapts to dishes with different ingredient counts (better than a fixed "N missing"). Configurable. |
| 4 | **Dish selection via free text + LLM mapping** | Fits the existing LLM core; no stateful keyboard UI. Buttons can come later. |
| 5 | **Bot auto-arranges the 7-day menu; long-keeping dishes repeat** | Matches "cook rarely": a few dishes (borscht for ~4 days) cover the week. |
| 6 | **Idempotent seeding (dedupe by nameRu)** | Lets the catalogue grow to 100+ in batches and be re-run safely; fixes the Phase-1 re-seed-duplicates caveat. |
| 7 | **Layered build (Foundation, then Planner)** | The planner depends on the catalogue + filtered offers; Layer 1 ships value on its own. |

## 4. Users & Context

Unchanged from Phase 1: two whitelisted Telegram users, PLZ 30459 Hannover,
self-hosted on the home server (Docker). They cook infrequently and batch-cook
long-keeping dishes.

## 5. Architecture

Phase 2 extends existing Phase-1 units and adds three new ones. Dependency
direction is unchanged (providers → fetcher/normalizer; matcher/recommender →
store/LLM; bot → recommender/planner/LLM).

### Layer 1 — Foundation
1. **Store registry** (`src/stores.ts`, new) — the canonical whitelist
   (`Lidl, Penny, Kaufland, Edeka, DM, Aldi, Netto, Rewe`), a normalizer
   `canonicalStore(rawName): StoreKey | null` mapping marktguru advertiser names
   to a whitelist key (null = not in scope), and `mapsLink(storeKey): string`
   producing the Apple Maps search URL. Pure functions, no I/O.
2. **Offer filtering** — the matcher/provider drops offers whose store is not in
   the whitelist (`canonicalStore` returns null) before choosing the cheapest.
3. **Recipe metadata** — `dishes` gains `course` and `keeps_days`; the recipe
   store reads/writes them; types extended.
4. **Seeder (idempotent, 100+)** — the existing batched seeder gains a target of
   100+, the new metadata in its schema/prompt, and a skip-existing check
   (`SELECT 1 FROM dishes WHERE name_ru = ?`) so re-runs only add what's missing.
5. **Coverage + ranking** — the recommender computes `coverage = onOfferCount /
   ingredientCount`, filters by `coverage >= OFFER_COVERAGE_MIN`, and ranks the
   survivors by coverage desc, then `keeps_days` desc (favour long-keeping), then
   estTotal asc. `/digest` returns the top `DIGEST_LIMIT` (default 5).

### Layer 2 — Planner
6. **Intent router** (`src/bot/intent.ts`, new) — an LLM call classifying a
   message into `suggest | select_dishes | show_menu | show_list | help` and, for
   `select_dishes`, extracting dish names. Structured output via the Phase-1 LLM
   service. Unknown/ambiguous → `help`.
7. **Dish resolver** — maps extracted names to catalogue dish ids (LLM-assisted,
   course-aware; reuses the synonym idea). Unmatched names are reported back.
8. **Menu planner** (`src/planner.ts`, new) — given selected dish ids split by
   course, lays out 7 days × `{first, second}`, repeating each dish across up to
   `keeps_days` consecutive days before moving to the next, cycling to fill the
   week. Returns a `WeeklyMenu`. Pure function (no I/O), fully unit-testable.
9. **Shopping list builder (grouped)** — aggregates the distinct ingredients of
   all menu dishes, matches each to its cheapest whitelist offer, groups by store,
   and renders an Apple Maps link per store. Ingredients with no whitelist offer
   go under "докупить (не в акции)".
10. **Selection persistence** — the chosen dish ids for the current ISO week are
    stored so menu and list are reproducible across messages.
11. **Bot wiring** — `message:text` now routes through the intent router instead
    of always calling `/digest`. Slash commands (`/digest`, `/menu`, `/list`)
    remain as direct entry points.

## 6. Data Model (SQLite) changes

- `dishes`: **add** `course TEXT CHECK(course IN ('first','second'))`,
  `keeps_days INTEGER NOT NULL DEFAULT 1`. (New migration appended; existing rows
  get defaults — but the catalogue is re-seeded for 100+ anyway.)
- **New** `selection(week TEXT PRIMARY KEY, dish_ids_json TEXT NOT NULL,
  updated_at TEXT NOT NULL)` — the family's chosen dishes for an ISO week
  (e.g. `"2026-W26"`), as a JSON array of dish ids.
- No change to `offers`, `ingredients`, `synonyms`, `match_cache`, `meta`.

Migrations stay ordered and idempotent (`CREATE TABLE IF NOT EXISTS`,
`ALTER TABLE ADD COLUMN` guarded — see Risks).

## 7. Data Flow

- **Suggest (`/digest` or "что приготовить"):** offers (whitelist-filtered) →
  matcher per ingredient → recommender computes coverage, filters ≥0.7, ranks by
  keeping+cost → compact top-5 reply.
- **Select ("борщ, карбонара, гречка"):** intent router → dish resolver maps to
  catalogue ids (split by course) → persist `selection(week)` → confirm what was
  understood (and any unmatched names).
- **Menu (`/menu`):** read `selection(week)` → planner lays out 7 days → table
  reply.
- **List (`/list`):** read `selection(week)` → aggregate ingredients → cheapest
  whitelist offer each → group by store with Maps links → reply.

## 8. Threshold, Stores & Maps (detail)

- `OFFER_COVERAGE_MIN` config, default `0.7`. A dish qualifies when
  `onOfferCount / ingredientCount >= OFFER_COVERAGE_MIN`. Dishes below threshold
  are omitted from suggestions; if the family explicitly selects one, the list
  flags its missing ingredients under "докупить".
- `STORE_WHITELIST` config (default the 8 chains). `canonicalStore` normalizes
  case/spacing and known aliases (e.g. "EDEKA", "Edeka Center" → `edeka`).
- `mapsLink('lidl')` → `https://maps.apple.com/?q=Lidl%2030459` (chain display
  name + PLZ, URL-encoded).

## 9. LLM Usage & Cost Control

- New calls: intent routing and dish-name resolution. Both Haiku, structured
  output, validated with zod (Phase-1 `Llm.structured`, now with `maxTokens`).
- Intent routing is one short call per free-text message; dish resolution one call
  per selection. At 2-user volume, negligible. Synonym/match caches from Phase 1
  still cover ingredient→offer matching.
- The seeder uses batched generation (existing) with the larger `maxTokens`.

## 10. Error Handling

- Intent router failure → fall back to `help` text, never crash (bot keeps the
  Phase-1 try/catch around handlers).
- Dish resolver: unmatched names are reported ("не нашёл: X"), matched ones still
  processed.
- Empty / zero-coverage week → friendly "ничего выгодного на этой неделе" message.
- Store filter removing all offers for an ingredient → that ingredient is "not on
  offer" (same as Phase 1 null match).
- Migrations: additive and guarded; a failed `ADD COLUMN` on an existing column is
  tolerated (see Risks).

## 11. Testing Strategy

- **Unit (offline, no network/LLM):** `canonicalStore`/`mapsLink`; coverage
  filter + new ranking (favour keeps_days); the planner's 7-day layout incl.
  long-keeping repeats and cycling; grouped shopping-list aggregation; intent
  router and dish resolver with a stubbed `Llm`; idempotent seeder skip-existing.
- **Integration:** recipe store round-trips with `course`/`keeps_days`; selection
  persistence by week; migration adds columns on an existing DB.
- **E2E:** stubbed-LLM bot flow: select → menu → list produces the expected
  grouped output with Maps links.
- Manual: one live seed to ~100 dishes; one live `/list` confirming real store
  names map into the whitelist (validates `canonicalStore` against real data).

## 12. Configuration (new keys)

`STORE_WHITELIST=lidl,penny,kaufland,edeka,dm,aldi,netto,rewe`,
`OFFER_COVERAGE_MIN=0.7`, `DIGEST_LIMIT=5`, `MENU_DAYS=7`. Existing keys unchanged.

## 13. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| marktguru advertiser names don't match whitelist keys | Medium | `canonicalStore` alias table; the manual live `/list` check validates against real names; unknown names log a warning so we can extend aliases. |
| `ALTER TABLE ADD COLUMN` re-runs on an existing DB | Medium | Use a `schema_version`/`meta` guard or catch "duplicate column" and continue; the catalogue is re-seeded anyway. |
| LLM dish-name resolution mis-maps a dish | Medium | Echo back what was understood + unmatched names so the family can correct. |
| Menu layout feels arbitrary | Low | Deterministic rule (keeps_days-driven repeats), shown as a table the family can re-pick from. |
| Scope creep (pantry, scheduler) | Medium | Explicitly deferred (Non-Goals); each layer is its own plan. |

## 14. Phasing (decomposition)

- **Layer 1 — Foundation:** store registry + filter, Maps links, `dishes`
  metadata + migration, idempotent 100+ seeder, coverage threshold + keeping-aware
  ranking, compact `/digest`. Independently shippable; verified via `/digest`.
- **Layer 2 — Planner:** intent router, dish resolver, selection persistence,
  weekly menu planner, grouped shopping list, bot routing + `/menu` `/list`.

Each layer is brainstormed-approved here and gets its **own implementation plan**
(`writing-plans`), built and reviewed before the next.

## 15. Open Questions

None blocking. The store-alias table and the exact "world dishes" mix are content
decisions refined during seeding. Quantity math and pantry are deferred by design.
