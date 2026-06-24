# Annona — Full Diagnostic Audit

Captured 2026-06-24. Read-only audit across security, correctness, reliability,
code quality, dependencies, and AI/LLM token economy. Produced by a 6-lens
fan-out with adversarial per-finding verification against the threat model.
**44 findings confirmed.** Severities below are post-verification (several were
adversarially downgraded — notably the prompt-caching items).

## Ground truth

- `bun test` → **218/218 pass** (446 assertions, 26 files).
- `bunx tsc --noEmit` → **clean, exit 0**.

## Threat model

Private 2-user Telegram bot (Bun + grammy + Anthropic Haiku + sqlite), gated by
an `ALLOWED_USER_IDS` allowlist, no public HTTP surface. Inputs: messages from 2
trusted users, untrusted **data** scraped from marktguru.de, and text
**generated** by the LLM. Classic "attacker sends payload" web threats are
de-rated; real weight is on secret leakage, Telegram-Markdown / prompt injection
from LLM/scraped strings, and reliability of external dependencies.

---

## HIGH

### REL-1 — Boot-time `loadKeys()` is an unguarded single point of failure
- **File:** `src/main.ts:16-18` (also BUG-3)
- **Impact:** `await loadKeys(fetcher)` runs at module top-level before
  `bot.start()`, no try/catch. Marktguru unreachable (no fetch timeout, BUG-2) →
  boot hangs forever. Homepage markup change → `extractKeys` throws → unhandled
  top-level rejection → non-zero exit → `restart: unless-stopped` crash-loops the
  container. A price-scraping dependency takes the whole bot offline, including
  menu/recipe/pantry reads off the cached DB. Keys never refreshed for process
  lifetime → in-session rotation silently breaks matching. Nuance: transient
  403/429/5xx are retried up to 3×, so the crash-loop trigger is a 200 with
  *changed markup*.
- **Fix:** wrap `loadKeys` in try/catch; on failure start degraded with matching
  disabled, lazily re-attempt on first search / 401-403. The degraded path must
  also guard `estimateDishCost`/`buildGroupedList`, which need a working matcher.
- **Effort:** M

---

## MEDIUM

### BUG-1 / ARCH-1 — Intent classifier schema covers only 5 of 13 IntentKind values
- **File:** `src/bot/intent.ts:5-23` (consumer `src/bot/bot.ts:230-269`)
- **Impact:** `IntentSchema.kind = z.enum(["suggest","select_dishes","show_menu","show_list","help"])`.
  `classifyIntent` can never emit add/remove dishes, add_custom/delete dish,
  add/remove/show pantry, or scale_dish. Those 8 switch arms are reachable only
  via the regex prefilter; any phrasing the regex misses falls through to the
  schema-limited classifier and is misclassified. `targetServings` is never
  exposed → scale impossible on the LLM path. Degraded UX on the fallback only;
  primary slash/verb surface works; no data loss.
- **Fix:** extend `IntentSchema.kind` to the full `IntentKind` union + optional
  `targetServings`, reuse the `IntentKind` type so schema and switch can't drift.
- **Effort:** S (schema) / M (full)

### TOK-3 — Regex router misses the most common positive intents
- **File:** `src/bot/router.ts:30-95` (consumer `bot.ts:229`)
- **Impact:** highest-frequency messages (bare dish lists, меню/список/что
  приготовить, greetings) pay a full LLM `classifyIntent` round-trip; select path
  = 2 LLM calls when 1 suffices.
- **Fix:** add deterministic regexes for menu/list/suggest/help and route bare
  comma/space lists straight to `select_dishes` via the existing `names()`.
- **Effort:** M

### BUG-2 / REL-3 — fetcher has no request timeout / AbortController
- **File:** `src/net/fetcher.ts:40-65`
- **Impact:** `doFetch` has no `signal`/timeout. If marktguru accepts the TCP
  connection but never responds, the await never settles, so the retry loop is
  never entered. Any `matchIngredient` hangs indefinitely; matching runs in a
  sequential loop (matcher.ts:57, cost.ts:17, handlers.ts:47), so one stuck
  ingredient stalls the whole `/list` or `/menu` — no reply, no error. With REL-1
  it also hangs boot.
- **Fix:** `signal: AbortSignal.timeout(8_000–10_000)`; treat AbortError as a
  retryable network failure so backoff engages.
- **Effort:** S

### BUG-4 / SEC-1 — Unescaped LLM/scraped/user strings in `parse_mode:"Markdown"`
- **File:** `src/bot/bot.ts:66-68` + `src/bot/handlers.ts:65,102-103,130,166,200,210-211,296`
- **Impact:** `reply()` uses `parse_mode:"Markdown"` while interpolating raw dish
  names (LLM/user) and the scraped `offer.product` (handlers.ts:166). Telegram
  legacy Markdown treats `* _ \` [` as delimiters; an unbalanced metacharacter
  from model/scraped data makes Telegram reject the whole `sendMessage` with HTTP
  400 "can't parse entities". The throw is swallowed by `guard()` → user sees a
  generic error and the real menu/list/confirmation is undeliverable — a
  data-driven intermittent denial-of-functionality. `esc()` in format.ts is
  HTML-only, used only on the recipeView path.
- **Fix:** add `escapeMd()` applied to every interpolated dynamic string, OR move
  these reply paths to HTML `parse_mode` + the existing `esc()`.
- **Effort:** M

### REL-6 — No SQLite backup or WAL checkpoint
- **File:** `docker-compose.yml:8-13` + `db.ts:11`
- **Impact:** all state (generated dishes, synonyms, selections, pantry,
  match_cache) lives in one Docker named volume with no dump/snapshot. Volume
  loss permanently destroys token-expensive generated recipes. (WAL-unbounded
  sub-claim overstated — Bun/SQLite auto-checkpoints; the backup gap is the issue.)
- **Fix:** host cron `sqlite3 annona.db .backup` to a timestamped file outside the
  volume; at minimum document the command in deploy.sh.
- **Effort:** S

---

## LOW

- **REL-2** — No graceful shutdown (SIGTERM/SIGINT → `bot.stop()`+`db.close()`).
  Real cost: in-memory `pending*` confirm Maps lost on redeploy → dead button.
  `src/main.ts:38-42`. (S)
- **REL-4** — HTTP 403 in `RETRYABLE` escalates anti-bot blocks. Drop 403 / single
  long-backoff; surface repeated 403s as a stale-keys signal. `fetcher.ts:18,49-53`. (S)
- **REL-5** — No process-level `unhandledRejection`/`uncaughtException` net for
  floating promises / non-update-cycle errors. `main.ts`. (S)
- **REL-7** — No Docker HEALTHCHECK / last-update-age; a wedged-but-not-crashed
  bot shows "up" and never recovers. `Dockerfile`, `docker-compose.yml`. (M)
- **REL-8** — CI does not gate deploy; a red-CI commit can ship.
  `deploy.sh:21-30,49-50`. (S)
- **REL-9** — `Promise.all` over chosen dishes (+ double estimateDishCost) fans
  out concurrent matcher calls on cold cache. Note: `bot.start()` long-polling
  serializes cross-message bursts, so the fan-out is intra-`/list`. `handlers.ts:171-176`. (M)
- **BUG-5** — `match_cache.created_at` stores the ISO-week string, not a
  timestamp; latent for any future TTL logic. `matcher.ts:69-72`. (S)
- **BUG-7 / TOK-5** — `structured()` retry swallows the first error and re-sends a
  byte-identical request; persistent schema mismatch doubles round-trips.
  `llm.ts:51-58`. (S)
- **BUG-8** — In-memory `pending*` Maps lost on restart, keyed only by userId; a
  second flow of the same kind clobbers the slot. `bot.ts:105,134,156-157`. (M)
- **TOK-1** — No prompt caching (see Token Economy). Cacheable prefix below
  haiku's 4096 floor; gate behind TOK-6. `llm.ts:34-42`. (M)
- **TOK-2** — `seedDishes` O(n²) exclude-list growth; rare one-shot CLI seed.
  Omit exclude, rely on existing dedup. `recipeStore.ts:196-217`. (S)
- **TOK-4 / BUG-6** — handleList computes estimateDishCost twice; NOT a token win
  (both passes are warm SQLite reads). Cleanliness only. `handlers.ts:171-176`. (S)
- **TOK-6** — No token-usage telemetry; prerequisite for every other token claim.
  `llm.ts:35-48`. (S)
- **TOK-7** — resolveDishes re-sends ~110-dish catalogue uncached; already a
  single batched call. ~80-90% warm savings only if catalogue moves into a cached
  prefix + within 5-min TTL bursts. `resolve.ts:20-34`. (M)
- **SEC-2** — Partial prompt-delimiter sanitization across 5 call sites; blast
  radius contained by forced structured output + zod. `recipeStore.ts:166,273`. (S)
- **SEC-4** — Unbounded dish-name count per message; mostly mitigated by per-item
  confirm + match_cache. Cap ~20. `router.ts:8-13`. (S)
- **SEC-5** — `extractKeys` uses `String()` on untrusted homepage JSON (fail-open
  → garbage keys). Validate with zod `string().min(1)`. `marktguru.ts:29-32`. (S)
- **TYPE-1** — `as unknown as z.ZodType` casts; only real mismatch is `course`.
  Derive `type Dish = z.infer<...>`. `recipeStore.ts:27-33`. (M)
- **TYPE-2** — Pervasive `d.id as number`. Introduce `SavedDish = Dish & {id:number}`
  returned by `listDishes`/`dishIdByName`. `handlers.ts` etc. (M)
- **ARCH-2** — Mutable module-level `dishes` + two divergent freshness strategies
  (bot.ts re-SELECTs, menus.ts re-reads). menus.ts delete can't reassign bot.ts's
  `dishes` → stale command path (root of the recent "repaint on delete" churn).
  `bot.ts:56,130,282,310,330`. (M)
- **DRY-1** — Per-dish cost computed at 4 sites, no per-request memo; handleMenu/
  handleList rebuild identical byId/chosen. Extract `loadChosenDishes`. `handlers.ts`. (S)
- **DRY-2** — Name-parsing duplicated across 5 sites with divergent rules. Make
  `router.names()` canonical. `handlers.ts:327,335` etc. (S)
- **TEST-1** — `menus.ts` (2nd-largest interactive surface) has no direct
  coverage; the delete-then-repaint flow (last 2 commits) untested. Extract card
  closures and unit-test. `menus.ts:45-130`. (M)
- **DEP-1** — CI runs non-frozen `bun install`; mismatch with Dockerfile's
  `--frozen-lockfile`. `ci.yml:19-20`. (S)
- **DEP-2** — Bun version unpinned/inconsistent (CI `latest`, Docker `1`, local
  1.3.11). Add `.bun-version`. `ci.yml:16-17`. (S)
- **DEP-3** — Docker base `oven/bun:1` no patch pin / digest → non-reproducible
  build. `Dockerfile:2`. (S)
- **DEP-5** — `@types/bun: "latest"` defeats lockfile reproducibility. Pin exact.
  `package.json:11-13`. (S)

---

## INFO

- **SEC-3** — Plaintext `.env` shipped to / persisted on the home server (kept out
  of git + image). Optional: `chmod 600` / Docker secrets. `deploy.sh:44-47`. (S)
- **TOK-8** — `max_tokens` is a ceiling, not billed output; trimming yields
  nothing unless truncating. Defer until TOK-6. Don't lower seedDishes 4096. (S)
- **DEP-4** — Container runs as root; `USER bun` for defense-in-depth. `Dockerfile`. (S)
- **DEP-6** — No CI dependency/build caching. `ci.yml`. (S)
- **DEAD-1** — Orphaned `scripts/spike-marktguru.ts` (excluded from image). Delete
  or document. (S)

---

## Token economy (deep dive)

Honest headline: **most "big caching wins" do not hold on this stack, the one real
recurring waste is an avoidable LLM classify call, and the topic is currently
unmeasurable.** Model tiering is already optimal (`claude-haiku-4-5`); no LLM call
is gratuitous.

1. **TOK-3 (real win, M)** — regex-route the highest-frequency intents + bare dish
   lists; removes ~1 LLM classify on most messages (select: 2→1).
2. **TOK-6 (prerequisite, S)** — log `res.usage` (input/output/cache_read/
   cache_creation). Every other estimate is unverified until this lands.
3. **TOK-1 / TOK-7 (downgraded)** — haiku min cacheable prefix = 4096 tokens; the
   static prefix is below it and the catalogue lives in the user prompt. Naive
   `cache_control` caches ~nothing; the 1.25× write premium + 5-min TTL can be a
   net cost at 2-user volume. Only worth it if the catalogue moves into a cached
   system prefix AND measurement (TOK-6) shows `cache_read_input_tokens > 0`.
4. **TOK-2 (S)** — drop seedDishes exclude list; ~85-90% of exclude tokens, kills
   O(n²). Rare one-shot.
5. **TOK-5 (S)** — don't double the transient retry; discriminate validation vs
   API error.
6. **TOK-8 (info)** — caps are ceilings; measure before trimming.
7. **TOK-4 (not a token win)** — double estimateDishCost is warm SQLite reads.

**Bottom line:** TOK-3 + TOK-6 first; treat caching as a measured experiment.

---

## Roadmap

**P0 — now:** REL-1+BUG-3 (loadKeys non-fatal) · BUG-2/REL-3 (fetch timeout) ·
BUG-1 (full IntentSchema) · BUG-4/SEC-1 (escape Markdown).

**P1 — soon:** TOK-6 (telemetry) → TOK-3 (regex routing) → REL-6 (sqlite backup)
→ REL-2 (shutdown) → TOK-2 → DEP-1 → REL-4 → BUG-5.

**P2 — later:** TOK-7 (gated on TOK-6) · BUG-7 · REL-5 · REL-9/DRY-1 · ARCH-2 ·
TYPE-1/2 · DEP-2/3/4/5 · REL-7/8 · TEST-1 · DRY-2/DEAD-1/SEC-2/SEC-5/TOK-8/SEC-3.

---

## Not covered

- No live runtime run; REL-1/BUG-2/BUG-4 reasoned from code, not reproduced.
- No real token-usage data (that is TOK-6); all percentages are estimates; the
  haiku 4096 floor / 1.25× premium taken from spec, not measured here.
- No fresh git-history secret scan; no `bun audit`/SCA — DEP findings are about
  pinning discipline, not known CVEs.
- 218 tests pass, but coverage % / assertion strength not audited.
