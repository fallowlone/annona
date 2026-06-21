# Annona — Family Grocery Savings Assistant

**Date:** 2026-06-21
**Status:** Design approved (pending spec review)
**Working name:** Annona (Roman personification of the food/grain supply)

## 1. Overview

A self-hosted server that helps one family save money on food in Germany. Once a
week it scrapes **supermarket promotions (Angebote / weekly deals)** for the
family's location, keeps a database of **dishes** (Ukrainian / Russian cuisine
makeable in Germany) and a **home pantry**, and talks to the family through a
**Telegram bot** (both proactive weekly digests and on-demand answers). Its core
output: *"here is what is on sale this week → here are the cheapest dishes to
cook now → here is the shopping list, what to buy where."*

The "brains" — understanding free-form text and matching dish ingredients
(Russian/Ukrainian) to German promo products — run on **Claude Haiku**.

This mirrors the kaufDA model: value comes from **this week's deals**, not from
tracking every regular price forever.

## 2. Goals / Non-Goals

### Goals
- Surface weekly grocery deals relevant to the family's stores and turn them into
  concrete, affordable dish suggestions.
- Let two people (the user and spouse) interact in natural language via Telegram:
  report what they have / ran out of, ask what to cook, ask where to buy cheapest.
- Maintain a curated database of 100+ Ukrainian/Russian dishes with ingredients
  and quantities.
- Produce a weekly shopping list grouped by store (cheapest source per item).
- Run unattended on a home server with weekly scheduling.
- Be resilient to scraper failures and never get the family's IP/account banned.

### Non-Goals (YAGNI for now)
- Multi-tenant / public service (exactly two whitelisted users).
- Full regular-price catalog of every product (deals-first).
- Mobile/web UI (Telegram is the only client).
- Nutrition tracking, calorie counting, meal planning calendars.
- OCR of flyer images at the start (we begin with a structured-data source).

## 3. Users & Context

- **Users:** 2 family members, both Telegram, whitelisted by `user_id`.
- **Location:** Hannover, PLZ **30459** (Linden/Ricklingen area, near
  Schünemannplatz). This drives which stores' promotions are fetched. Stored in
  config, changeable.
- **Stores in scope:** whatever the promotion source returns for that location —
  typically REWE, EDEKA, Aldi (Nord), Lidl, Kaufland, Penny, Netto.
- **Runtime/host:** home server, always-on, 24/7.

## 4. Key Decisions (with rationale)

| # | Decision | Rationale |
|---|---|---|
| 1 | **Price source = weekly promotions aggregator** | No official German price API exists. Deals are where real savings live and one source covers many stores. Closest to kaufDA. |
| 2 | **LLM in the core (Claude Haiku)** | Free-text parsing + RU/UA→DE ingredient matching are natural-language problems. Cheap at 2-user volume. |
| 3 | **Host = home server, stack = Bun + SQLite** | Zero hosting cost, always-on cron + Telegram polling work without serverless workarounds; full control of headless scraping. `bun` per user convention. |
| 4 | **Interaction = push + pull** | Weekly proactive digest *and* on-demand questions. |
| 5 | **Dish DB = LLM-seeded, human-reviewed** | Fast to bootstrap 100+ dishes; user edits once; add more later via chat. |
| 6 | **Proxy/anti-ban = plugin-ready, off by default** | 2-user volume is tiny; start direct. Fetcher already supports a proxy pool / rotating service, toggled by config the moment blocking appears. |

## 5. Architecture

Single Bun process, organized into small, independently testable units that
communicate through explicit interfaces. Each unit answers: *what does it do, how
do you use it, what does it depend on.*

### Components

1. **Providers (offer ingestion)** — one pluggable module per source. Each fetches
   the week's promotions for the configured location and returns normalized
   `Offer` records. Phase 1 ships **one** structured-data provider (marktguru-style
   location API — structured product+price, avoids OCR). Adding a source = adding a
   module; nothing else changes.
   - *Depends on:* Fetcher, Normalizer, config (location).
2. **Fetcher (HTTP client + proxy/anti-ban)** — the single egress point all
   providers use (`fetcher.get(url, opts)`). Owns: rate limiting, randomized
   delays, realistic User-Agent rotation, exponential backoff on 429/403, and a
   **proxy layer** with modes `none` → `pool` (own list) → `service` (rotating
   provider), round-robin/random/sticky rotation, proxy health-check + quarantine.
   - *Depends on:* config (proxy mode, list/endpoint). Blocking alerts go through
     the bot's admin channel.
3. **Normalizer** — parses units (€/kg, €/piece, €/L), cleans product names,
   dedupes. Pure functions, no I/O.
4. **Recipe store** — persistence + queries for `dishes` and `ingredients`.
   Seeded by the LLM, edited by the user.
5. **Matcher** — given a canonical ingredient, finds matching in-promotion
   products. Uses the LLM **plus a cached synonym dictionary**
   (`сметана → [Schmand, Saure Sahne]`) so repeated lookups never re-hit the API.
   Returns best offer (store + unit price).
   - *Depends on:* LLM service, Recipe store, offers table, synonym cache.
6. **Pantry** — what the household has / is running low on. Updated from free text
   (LLM extracts items). Persistence + queries.
7. **Recommender** — combines offers + pantry + dishes, ranks dishes by
   *cost-to-cook-now* (cheap when ingredients are on sale and/or already at home),
   and produces the weekly digest and a **shopping list grouped by store**.
8. **Telegram bot (grammY, polling)** — whitelisted to 2 `user_id`s. Routes
   free-text messages through an **LLM intent router** into:
   `update pantry | what to cook | where cheapest | add dish`. Handles slash
   commands and the weekly push. Also the channel for admin/error alerts.
9. **LLM service** — thin wrapper over the Anthropic SDK. Claude Haiku default
   (Sonnet only for harder reasoning if needed). Enforces **structured output**
   (tool use / JSON schema with validation + retry), timeouts, retries, and a
   response cache. Single place where model IDs and prompts live.
10. **Scheduler** — cron jobs: weekly offer fetch, weekly digest send. Library:
    `croner` (Bun-compatible).
11. **Persistence** — `bun:sqlite` with a thin repository layer and SQL
    migrations. One DB file.
12. **Config** — `.env` + typed config: location (PLZ 30459), store whitelist,
    Telegram bot token + allowed `user_id`s, Anthropic API key, proxy mode.

### Dependency direction
Providers → Fetcher/Normalizer. Matcher/Pantry/Recommender → Recipe store /
Persistence / LLM service. Bot → Recommender/Pantry/Matcher/LLM service.
Nothing depends on the bot except the scheduler's push trigger.

## 6. Data Model (SQLite)

- `offers(id, provider, store, name_de, category, price, unit, unit_price,
  valid_from, valid_to, fetched_at, is_stale)`
- `dishes(id, name_ru, name_ua, name_de, cuisine, tags, servings, notes)`
- `ingredients(id, dish_id, canonical_name, qty, unit)`
- `synonyms(canonical_name, search_terms_de, updated_at)` — Matcher cache.
- `match_cache(ingredient_canonical, week, offer_id, store, unit_price, created_at)`
- `pantry(id, item_canonical, status['have'|'low'|'out'], qty, unit, updated_at)`
- `meta(key, value)` — last successful fetch, schema version, etc.

## 7. Data Flow

- **Cron (weekly):** Scheduler → each Provider → Fetcher → Normalizer →
  upsert `offers`. On a provider failure: log, alert via bot, keep last-good rows
  flagged `is_stale = true`.
- **Weekly digest:** Scheduler → Recommender (offers + pantry + dishes) → LLM
  ranks/explains → bot pushes digest + shopping list.
- **User message:** bot → LLM intent router → one of:
  - *update pantry* → LLM extracts items → Pantry upsert → confirm.
  - *what to cook* → Recommender → ranked dishes + why.
  - *where cheapest* → Matcher over a dish/ingredient → store + price.
  - *add dish* → LLM drafts dish+ingredients → user confirms → Recipe store.

## 8. LLM Usage & Cost Control

- Model: **Claude Haiku** (`claude-haiku-4-5`) by default.
- All structured tasks use **tool-use/JSON-schema output** with validation + one
  retry on malformed output.
- **Caching:** ingredient→product matches cached by `(ingredient, week)`;
  synonym dictionary persisted and reused. Re-calls only on cache miss.
- Tasks: intent routing, pantry extraction, ingredient↔product matching, dish
  seed generation. At 2-user volume cost is negligible; caching keeps it so.

## 9. Proxy / Anti-Ban (Fetcher detail)

- **Default `none`:** direct requests + polite scraping (rate limit, jitter, UA
  rotation, backoff). Sufficient for tiny volume.
- **`pool`:** user-supplied proxy list (HTTP/HTTPS/SOCKS5), rotated
  round-robin/random, sticky sessions where a source needs them, health-checked
  with quarantine of dead/blocked proxies.
- **`service`:** single rotating-proxy endpoint (paid residential service).
- Mode is config-only; **provider code never changes**. Blocking events
  (403/429 spikes, all-proxies-quarantined) alert the user via Telegram.

## 10. Error Handling

- Providers isolated: one failure never blocks others; keep last-good offers with
  a staleness flag; alert via bot.
- LLM: timeouts + retries; on outage, fall back to the cached synonym dictionary;
  validate structured output, retry once, then degrade gracefully with a clear
  message.
- Bot: respond only to whitelisted IDs; user-friendly error replies; never crash
  the process on a single bad message.
- Persistence: migrations are versioned; writes are transactional.

## 11. Testing Strategy

- **Unit:** unit parsing (€/kg etc.), Matcher logic (LLM mocked), Recommender
  ranking, pantry extraction parsing, proxy rotation/quarantine logic.
- **Integration:** providers against **recorded fixtures** (record real responses,
  replay), repository operations on a temp SQLite DB.
- **E2E:** simulate a Telegram update → assert the reply, with a stubbed LLM and a
  seeded DB.
- LLM-dependent paths tested with stubbed responses; a few manual "golden" checks
  against the real API.

## 12. Configuration

`.env` / typed config:
`LOCATION_PLZ=30459`, `LOCATION_CITY=Hannover`, `STORE_WHITELIST=...`,
`TELEGRAM_BOT_TOKEN=...`, `ALLOWED_USER_IDS=...`, `ANTHROPIC_API_KEY=...`,
`LLM_MODEL=claude-haiku-4-5`, `PROXY_MODE=none|pool|service`,
`PROXY_LIST=...` / `PROXY_ENDPOINT=...`.

## 13. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Promotion source changes format / blocks | Medium | Pluggable providers, recorded fixtures, last-good cache, proxy layer ready, bot alerts. |
| Unofficial source ToS / legality | Low (private, 2 users, tiny volume) | Minimal request rate; private use; easy to swap source. |
| Flyer data is image-only for some stores | Medium | Start with a structured-data source; OCR deferred to a later phase if needed. |
| Ingredient↔product mismatch (wrong product) | Medium | LLM + reviewed synonym dictionary; show the matched product name in replies so users can correct it. |
| LLM cost creep | Low | Aggressive caching by (ingredient, week); Haiku default. |
| Home server downtime / IP change | Low | Restart-on-boot service; weekly job catches up on next run. |

## 14. Phasing

- **Phase 1 — walking skeleton (end-to-end value):** one structured provider for
  PLZ 30459 → `offers` in SQLite; LLM seed of ~30 dishes; Matcher; Telegram bot
  with manual digest + "what to cook" pull; whitelist; Fetcher with default
  anti-ban (no proxy).
- **Phase 2:** pantry via free text; weekly push scheduler; shopping list grouped
  by store; full 100+ dish DB; synonym cache hardened.
- **Phase 3:** more providers (REWE/Aldi/Lidl direct); price history/trends; add
  dishes via chat; proxy `pool`/`service` enablement; optional OCR provider.

## 15. Open Questions

None blocking. Store whitelist and proxy provider choice are config decisions
deferred to setup/when needed.
