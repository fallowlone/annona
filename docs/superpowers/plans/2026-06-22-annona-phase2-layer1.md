# Annona Phase 2 — Layer 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict deals to a configured store whitelist (with Apple Maps links), add `course`/`keeps_days` dish metadata behind an idempotent migration, and turn `/digest` into a compact coverage-ranked "cook-rarely" shortlist.

**Architecture:** Add one new pure module (`src/stores.ts`) for store canonicalization + Maps links. Filter offers to the whitelist inside the Matcher before cheapest-selection. Extend the `dishes` table and `Dish` type with two columns via a guarded, idempotent column migration. Change the Recommender to rank by coverage → keeping → cost, and the bot handler to render a short top-N digest. Wire it all through the composition root from config.

**Tech Stack:** Bun + TypeScript (strict), `bun:sqlite`, `bun:test`, zod `4.4.3` (native `z.toJSONSchema`), grammY `1.44.0`, `@anthropic-ai/sdk` `0.105.0`.

## Global Constraints

- Runtime is Bun: `bun test`, `bun:sqlite`, no Node test runner, no `dotenv` (Bun auto-loads `.env`).
- TypeScript strict; explicit types on exported functions; no `any` in app code.
- Store whitelist keys (canonical): `lidl, penny, kaufland, edeka, dm, aldi, netto, rewe`.
- Config defaults (verbatim): `STORE_WHITELIST=lidl,penny,kaufland,edeka,dm,aldi,netto,rewe`, `OFFER_COVERAGE_MIN=0.7`, `DIGEST_LIMIT=5`.
- Apple Maps link format: `https://maps.apple.com/?q=<DisplayName>%20<PLZ>` (chain display name + PLZ, URL-encoded — a single space encodes to `%20`).
- Offers are filtered to the whitelist BEFORE cheapest-selection. Cheapest-selection still uses `effectiveUnitPrice` (`referencePrice ?? price`, the €/kg Grundpreis comparison). Shopping/total still uses the shelf price `Offer.price`.
- Migrations are additive and idempotent: `CREATE TABLE IF NOT EXISTS` for tables; `ADD COLUMN` is guarded by a `PRAGMA table_info` existence check so re-running `openDb` on the already-deployed DB never throws "duplicate column".
- Coverage = `onOfferCount / ingredientCount` (a 0-ingredient dish has coverage 0, never NaN).
- Digest ranking order: coverage DESC, then `keeps_days` DESC (favour long-keeping), then `estTotal` ASC. Only dishes with coverage ≥ `OFFER_COVERAGE_MIN` are shown; at most `DIGEST_LIMIT`.
- All user-facing Telegram copy is in Russian.
- No `console.log` in production code (the existing `console.warn`/`console.error` operational logs in `bot.ts`/`main.ts` are the established pattern and may stay).

---

## File Structure

**New files**
- `src/stores.ts` — store registry: `STORE_KEYS`, `StoreKey`, `canonicalStore`, `mapsLink`. Pure, no I/O. (Task 1)
- `tests/stores.test.ts` — unit tests for the registry. (Task 1)

**Modified files**
- `src/config.ts` + `tests/config.test.ts` — new `STORE_WHITELIST` / `OFFER_COVERAGE_MIN` / `DIGEST_LIMIT` keys. (Task 2)
- `src/types.ts` — `Dish` gains `course?`/`keepsDays?`; `RankedDish` gains `coverage`. (Tasks 3 & 5)
- `src/db/migrations.ts` + `src/db/db.ts` + `tests/db.test.ts` — guarded column migration. (Task 3)
- `src/recipes/recipeStore.ts` + `tests/recipeStore.test.ts` — read/write `course`/`keeps_days`; idempotent 100+ seeder. (Tasks 3 & 7)
- `src/matcher.ts` + `tests/matcher.test.ts` — whitelist offer filter. (Task 4)
- `src/recommender.ts` + `tests/recommender.test.ts` — coverage + keeping-aware ranking. (Task 5)
- `src/bot/handlers.ts` + `tests/handlers.test.ts` — compact coverage digest. (Task 6)
- `src/bot/bot.ts` + `src/main.ts` + `src/recipes/seed.ts` — composition wiring. (Task 8)

---

## Pre-Flight Note

The deployed home-server DB already holds ~30 dishes in a `dishes` table that lacks `course`/`keeps_days`. Task 3's migration MUST add those columns to that existing table (not only to fresh DBs). The Task-3 migration test proves this against a pre-existing table. The Task-7 seeder then re-seeds toward 100+, idempotently skipping the dishes already present by `name_ru`.

---

### Task 1: Store registry (`src/stores.ts`)

**Files:**
- Create: `src/stores.ts`
- Test: `tests/stores.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces:
  - `export const STORE_KEYS: readonly ["lidl","penny","kaufland","edeka","dm","aldi","netto","rewe"]`
  - `export type StoreKey = (typeof STORE_KEYS)[number]`
  - `export function canonicalStore(raw: string | null | undefined): StoreKey | null`
  - `export function mapsLink(store: StoreKey, plz: number): string`

- [ ] **Step 1: Write the failing test**

Create `tests/stores.test.ts`:

```ts
import { test, expect } from "bun:test";
import { canonicalStore, mapsLink, STORE_KEYS } from "../src/stores";

test("canonicalStore maps marktguru advertiser slugs to whitelist keys", () => {
  expect(canonicalStore("aldi-nord")).toBe("aldi");
  expect(canonicalStore("Aldi Nord")).toBe("aldi");
  expect(canonicalStore("ALDI SÜD")).toBe("aldi");
  expect(canonicalStore("Lidl")).toBe("lidl");
  expect(canonicalStore("PENNY")).toBe("penny");
  expect(canonicalStore("Kaufland")).toBe("kaufland");
  expect(canonicalStore("EDEKA")).toBe("edeka");
  expect(canonicalStore("Edeka Center")).toBe("edeka");
  expect(canonicalStore("REWE")).toBe("rewe");
  expect(canonicalStore("netto-marken-discount")).toBe("netto");
  expect(canonicalStore("Netto Marken-Discount")).toBe("netto");
  expect(canonicalStore("dm-drogerie-markt")).toBe("dm");
  expect(canonicalStore("dm")).toBe("dm");
});

test("canonicalStore returns null for out-of-scope or empty stores", () => {
  expect(canonicalStore("Rossmann")).toBeNull();
  expect(canonicalStore("Real")).toBeNull();
  expect(canonicalStore("unknown")).toBeNull();
  expect(canonicalStore("")).toBeNull();
  expect(canonicalStore(null)).toBeNull();
  expect(canonicalStore(undefined)).toBeNull();
});

test("mapsLink builds a chain+PLZ Apple Maps search URL", () => {
  expect(mapsLink("lidl", 30459)).toBe("https://maps.apple.com/?q=Lidl%2030459");
  expect(mapsLink("edeka", 30459)).toBe("https://maps.apple.com/?q=Edeka%2030459");
  expect(mapsLink("dm", 30459)).toBe("https://maps.apple.com/?q=dm%2030459");
});

test("STORE_KEYS holds the eight whitelist chains", () => {
  expect([...STORE_KEYS]).toEqual([
    "lidl", "penny", "kaufland", "edeka", "dm", "aldi", "netto", "rewe",
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/stores.test.ts`
Expected: FAIL — cannot find module `../src/stores`.

- [ ] **Step 3: Write minimal implementation**

Create `src/stores.ts`:

```ts
// Store registry: canonicalize marktguru advertiser names into a fixed whitelist
// of chains the family shops at, and build Apple Maps search links. Pure, no I/O.

export const STORE_KEYS = [
  "lidl",
  "penny",
  "kaufland",
  "edeka",
  "dm",
  "aldi",
  "netto",
  "rewe",
] as const;

export type StoreKey = (typeof STORE_KEYS)[number];

// Human-facing chain names used in Maps links and digest output.
const DISPLAY: Record<StoreKey, string> = {
  lidl: "Lidl",
  penny: "Penny",
  kaufland: "Kaufland",
  edeka: "Edeka",
  dm: "dm",
  aldi: "Aldi",
  netto: "Netto",
  rewe: "Rewe",
};

// Normalized substrings that identify a chain inside an advertiser name.
// `dm` is intentionally absent here: it is too short for a loose substring
// test (false positives) and is matched by a strict prefix check instead.
const ALIASES: Record<StoreKey, string[]> = {
  lidl: ["lidl"],
  penny: ["penny"],
  kaufland: ["kaufland"],
  edeka: ["edeka"],
  dm: [],
  aldi: ["aldi"],
  netto: ["netto"],
  rewe: ["rewe"],
};

/**
 * Map a raw marktguru advertiser name (uniqueName slug or display name) to a
 * whitelist key, or null when the store is out of scope. Case/spacing/punctuation
 * insensitive ("Aldi Nord", "aldi-nord", "ALDI SÜD" all → "aldi").
 */
export function canonicalStore(raw: string | null | undefined): StoreKey | null {
  if (!raw) return null;
  const norm = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!norm) return null;
  if (norm.startsWith("dm")) return "dm";
  for (const key of STORE_KEYS) {
    if (ALIASES[key].some((t) => norm.includes(t))) return key;
  }
  return null;
}

/** Apple Maps search URL for a chain near a PLZ, e.g. ".../?q=Lidl%2030459". */
export function mapsLink(store: StoreKey, plz: number): string {
  return `https://maps.apple.com/?q=${encodeURIComponent(`${DISPLAY[store]} ${plz}`)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/stores.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stores.ts tests/stores.test.ts
git commit -m "feat: add store registry (canonicalStore + mapsLink)"
```

---

### Task 2: Config keys (whitelist, coverage, digest limit)

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: `STORE_KEYS`, `StoreKey` from `src/stores.ts` (Task 1).
- Produces: `Config` gains `storeWhitelist: StoreKey[]`, `offerCoverageMin: number`, `digestLimit: number`.

- [ ] **Step 1: Write the failing test**

Append to `tests/config.test.ts`:

```ts
test("applies Phase 2 defaults: whitelist, coverage, digest limit", () => {
  const cfg = loadConfig(base);
  expect(cfg.storeWhitelist).toEqual([
    "lidl", "penny", "kaufland", "edeka", "dm", "aldi", "netto", "rewe",
  ]);
  expect(cfg.offerCoverageMin).toBe(0.7);
  expect(cfg.digestLimit).toBe(5);
});

test("parses a custom STORE_WHITELIST and rejects unknown store keys", () => {
  const cfg = loadConfig({ ...base, STORE_WHITELIST: "lidl, aldi , rewe" });
  expect(cfg.storeWhitelist).toEqual(["lidl", "aldi", "rewe"]);
  expect(() => loadConfig({ ...base, STORE_WHITELIST: "lidl,tesco" })).toThrow();
});

test("parses custom coverage and digest limit", () => {
  const cfg = loadConfig({ ...base, OFFER_COVERAGE_MIN: "0.5", DIGEST_LIMIT: "3" });
  expect(cfg.offerCoverageMin).toBe(0.5);
  expect(cfg.digestLimit).toBe(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config.test.ts`
Expected: FAIL — `cfg.storeWhitelist` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/config.ts`, add the import at the top (below the zod import):

```ts
import { STORE_KEYS, type StoreKey } from "./stores";
```

Inside the `schema` object, add these three keys (alongside the existing ones):

```ts
  STORE_WHITELIST: z
    .string()
    .default("lidl,penny,kaufland,edeka,dm,aldi,netto,rewe")
    .transform((s) => s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean))
    .pipe(z.array(z.enum(STORE_KEYS)).min(1)),
  OFFER_COVERAGE_MIN: z.coerce.number().min(0).max(1).default(0.7),
  DIGEST_LIMIT: z.coerce.number().int().positive().default(5),
```

Extend the `Config` type with three fields:

```ts
  storeWhitelist: StoreKey[];
  offerCoverageMin: number;
  digestLimit: number;
```

In the `loadConfig` return object, add three mappings:

```ts
    storeWhitelist: p.STORE_WHITELIST,
    offerCoverageMin: p.OFFER_COVERAGE_MIN,
    digestLimit: p.DIGEST_LIMIT,
```

> Note: if `z.enum(STORE_KEYS)` raises a TS error about the readonly tuple under this zod version, change it to `z.enum(STORE_KEYS as unknown as [StoreKey, ...StoreKey[]])`. Do not loosen the validation.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/config.test.ts`
Expected: PASS (existing 2 tests + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add STORE_WHITELIST, OFFER_COVERAGE_MIN, DIGEST_LIMIT config"
```

---

### Task 3: Dish metadata + idempotent column migration

**Files:**
- Modify: `src/types.ts`
- Modify: `src/db/migrations.ts`
- Modify: `src/db/db.ts`
- Modify: `src/recipes/recipeStore.ts`
- Test: `tests/db.test.ts`, `tests/recipeStore.test.ts`

**Interfaces:**
- Consumes: nothing from earlier Layer-1 tasks.
- Produces:
  - `Dish` gains `course?: "first" | "second" | null` and `keepsDays?: number`.
  - `export function applyColumnMigrations(db: Database): void` in `src/db/migrations.ts`.
  - `insertDish` persists `course`/`keeps_days`; `listDishes` returns them; `DishSeedSchema` requires `course` (`"first"|"second"`) and `keepsDays` (positive int) on every seeded dish.

- [ ] **Step 1: Write the failing migration test**

Append to `tests/db.test.ts` (add `import { Database } from "bun:sqlite";` and `import { applyColumnMigrations } from "../src/db/migrations";` to the existing imports):

```ts
test("openDb adds course and keeps_days columns to the dishes table", () => {
  const db = openDb(":memory:");
  const cols = (db.query("PRAGMA table_info(dishes)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("course");
  expect(cols).toContain("keeps_days");
});

test("applyColumnMigrations upgrades a pre-existing dishes table and is idempotent", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE dishes (id INTEGER PRIMARY KEY, name_ru TEXT NOT NULL)");
  applyColumnMigrations(db);
  applyColumnMigrations(db); // second run must not throw "duplicate column"
  const cols = (db.query("PRAGMA table_info(dishes)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("course");
  expect(cols).toContain("keeps_days");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/db.test.ts`
Expected: FAIL — `applyColumnMigrations` is not exported / columns missing.

- [ ] **Step 3: Implement the migration**

In `src/db/migrations.ts`, add the import and the guarded column migration below the existing `MIGRATIONS` array:

```ts
import type { Database } from "bun:sqlite";

type ColumnMigration = { table: string; column: string; ddl: string };

// Additive column migrations applied after the CREATE TABLE statements.
// Each is guarded by a PRAGMA existence check so re-running on an already
// upgraded (e.g. deployed) DB never throws "duplicate column name".
export const COLUMN_MIGRATIONS: ColumnMigration[] = [
  {
    table: "dishes",
    column: "course",
    ddl: "ALTER TABLE dishes ADD COLUMN course TEXT CHECK(course IN ('first','second'))",
  },
  {
    table: "dishes",
    column: "keeps_days",
    ddl: "ALTER TABLE dishes ADD COLUMN keeps_days INTEGER NOT NULL DEFAULT 1",
  },
];

export function applyColumnMigrations(db: Database): void {
  for (const m of COLUMN_MIGRATIONS) {
    const cols = db.query(`PRAGMA table_info(${m.table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === m.column)) db.run(m.ddl);
  }
}
```

In `src/db/db.ts`, import and call it after the `MIGRATIONS` loop:

```ts
import { MIGRATIONS, applyColumnMigrations } from "./migrations";
```

```ts
  for (const stmt of MIGRATIONS) db.run(stmt);
  applyColumnMigrations(db);
  return db;
```

- [ ] **Step 4: Run the migration test to verify it passes**

Run: `bun test tests/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing metadata round-trip test**

In `tests/recipeStore.test.ts`, update the `borscht` and `pelmeni` fixtures to carry the new fields (add `course`/`keepsDays` after `cuisine`):

```ts
const borscht: Dish = {
  nameRu: "Борщ", nameUa: "Борщ", nameDe: "Borschtsch", cuisine: "ua",
  course: "first", keepsDays: 4,
  tags: ["soup"], servings: 4,
  ingredients: [
    { canonical: "свёкла", qty: 2, unit: "шт" },
    { canonical: "капуста", qty: 0.3, unit: "кг" },
    { canonical: "сметана", qty: 1, unit: "уп" },
  ],
};

const pelmeni: Dish = {
  nameRu: "Пельмени", nameUa: "Вареники", nameDe: "Pelmeni", cuisine: "ru",
  course: "second", keepsDays: 2,
  tags: ["main"], servings: 2,
  ingredients: [
    { canonical: "фарш", qty: 0.5, unit: "кг" },
    { canonical: "мука", qty: 0.3, unit: "кг" },
  ],
};
```

Then append this round-trip test:

```ts
test("insertDish + listDishes round-trips course and keepsDays", () => {
  const db = openDb(":memory:");
  insertDish(db, borscht);
  const all = listDishes(db);
  expect(all[0]!.course).toBe("first");
  expect(all[0]!.keepsDays).toBe(4);
});

test("insertDish defaults missing metadata to null course and keepsDays 1", () => {
  const db = openDb(":memory:");
  const bare: Dish = {
    nameRu: "Каша", nameUa: null, nameDe: null, cuisine: "ru",
    tags: [], servings: 2,
    ingredients: [{ canonical: "крупа", qty: 1, unit: "кг" }],
  };
  insertDish(db, bare);
  const all = listDishes(db);
  expect(all[0]!.course).toBeNull();
  expect(all[0]!.keepsDays).toBe(1);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test tests/recipeStore.test.ts`
Expected: FAIL — `listDishes` does not return `course`/`keepsDays`; the `DishSeedSchema` test may also fail once the schema is tightened.

- [ ] **Step 7: Extend the type and recipe store**

In `src/types.ts`, add two fields to `Dish` (after `cuisine`):

```ts
  course?: "first" | "second" | null; // soup/porridge = first, main = second
  keepsDays?: number; // days the cooked dish keeps; default 1
```

In `src/recipes/recipeStore.ts`:

Tighten `DishSchema` — add `course` and `keepsDays` (place them after `cuisine`):

```ts
const DishSchema = z.object({
  nameRu: z.string().min(1),
  nameUa: z.string().nullable(),
  nameDe: z.string().nullable(),
  cuisine: z.string().min(1),
  course: z.enum(["first", "second"]),
  keepsDays: z.number().int().positive(),
  tags: z.array(z.string()),
  servings: z.number().int().positive(),
  ingredients: z.array(IngredientSchema).min(1),
});
```

Update `insertDish` to persist the two columns:

```ts
    const row = db
      .query<{ id: number }, [string, string | null, string | null, string, string | null, number, string, number]>(
        `INSERT INTO dishes(name_ru, name_ua, name_de, cuisine, course, keeps_days, tags, servings)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(
        dish.nameRu,
        dish.nameUa ?? null,
        dish.nameDe ?? null,
        dish.cuisine,
        dish.course ?? null,
        dish.keepsDays ?? 1,
        JSON.stringify(dish.tags),
        dish.servings
      );
```

Update `DishRow` to include the columns:

```ts
type DishRow = {
  id: number;
  name_ru: string;
  name_ua: string | null;
  name_de: string | null;
  cuisine: string;
  course: "first" | "second" | null;
  keeps_days: number;
  tags: string;
  servings: number;
};
```

Update `listDishes` SELECT and mapping:

```ts
  const dishRows = db
    .query<DishRow, []>(
      `SELECT id, name_ru, name_ua, name_de, cuisine, course, keeps_days, tags, servings FROM dishes ORDER BY id`
    )
    .all();
```

```ts
  return dishRows.map((r) => ({
    id: r.id,
    nameRu: r.name_ru,
    nameUa: r.name_ua,
    nameDe: r.name_de,
    cuisine: r.cuisine,
    course: r.course,
    keepsDays: r.keeps_days,
    tags: JSON.parse(r.tags) as string[],
    servings: r.servings,
    ingredients: ingQ.all(r.id).map((i) => ({
      canonical: i.canonical_name,
      qty: i.qty,
      unit: i.unit,
    })),
  }));
```

- [ ] **Step 8: Run all touched tests to verify they pass**

Run: `bun test tests/db.test.ts tests/recipeStore.test.ts`
Expected: PASS (existing recipeStore tests still pass — the `DishSeedSchema` test now validates the metadata-carrying `borscht`; the two new round-trip tests pass).

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/db/migrations.ts src/db/db.ts src/recipes/recipeStore.ts tests/db.test.ts tests/recipeStore.test.ts
git commit -m "feat: add dishes.course/keeps_days behind a guarded idempotent migration"
```

---

### Task 4: Matcher whitelist filter

**Files:**
- Modify: `src/matcher.ts`
- Test: `tests/matcher.test.ts`

**Interfaces:**
- Consumes: `canonicalStore`, `StoreKey` from `src/stores.ts` (Task 1).
- Produces: `createMatcher` accepts an optional `whitelist?: ReadonlySet<StoreKey>`. When provided, offers whose store is not in the set are dropped before cheapest-selection. When omitted, behaviour is unchanged (no filtering).

- [ ] **Step 1: Write the failing test**

In `tests/matcher.test.ts`, add `import type { StoreKey } from "../src/stores";` to the imports, then append:

```ts
test("matchIngredient drops offers whose store is not in the whitelist", async () => {
  const db = openDb(":memory:");
  // Cheapest by effectiveUnitPrice is Metro (out of scope) and must be ignored.
  const provider: OfferProvider = {
    async search() {
      return [
        offer({ externalId: 20, store: "metro", storeName: "Metro", referencePrice: 0.5 }),
        offer({ externalId: 21, store: "aldi-nord", storeName: "Aldi Nord", referencePrice: 0.99 }),
      ];
    },
  };
  const whitelist = new Set<StoreKey>(["aldi", "lidl"]);
  const m = createMatcher({ db, llm: llmStub(["Schmand"]), provider, week: "2026-W26", whitelist });
  const best = await m.matchIngredient("сметана");
  expect(best!.storeName).toBe("Aldi Nord");
});

test("matchIngredient without a whitelist keeps all offers", async () => {
  const db = openDb(":memory:");
  const provider: OfferProvider = {
    async search() {
      return [offer({ externalId: 30, store: "metro", storeName: "Metro", referencePrice: 0.5 })];
    },
  };
  const m = createMatcher({ db, llm: llmStub(["Schmand"]), provider, week: "2026-W26" });
  const best = await m.matchIngredient("сметана");
  expect(best!.storeName).toBe("Metro");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/matcher.test.ts`
Expected: FAIL — `whitelist` is ignored, so Metro (cheapest) wins the first test.

- [ ] **Step 3: Implement the filter**

In `src/matcher.ts`, add the import:

```ts
import { canonicalStore, type StoreKey } from "./stores";
```

Add `whitelist` to the deps and destructuring:

```ts
export function createMatcher(deps: {
  db: Database;
  llm: Llm;
  provider: OfferProvider;
  week: string;
  whitelist?: ReadonlySet<StoreKey>;
}): Matcher {
  const { db, llm, provider, week, whitelist } = deps;
```

In `matchIngredient`, filter `found` to the whitelist before dedupe/cheapest (replace the `const deduped = dedupeOffers(found);` line):

```ts
    const inScope = whitelist
      ? found.filter((o) => {
          const key = canonicalStore(o.store) ?? canonicalStore(o.storeName);
          return key !== null && whitelist.has(key);
        })
      : found;
    const deduped = dedupeOffers(inScope);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/matcher.test.ts`
Expected: PASS (existing matcher tests still pass — they pass no whitelist; the two new tests pass).

- [ ] **Step 5: Commit**

```bash
git add src/matcher.ts tests/matcher.test.ts
git commit -m "feat: filter offers to the store whitelist in the matcher"
```

---

### Task 5: Recommender coverage + keeping-aware ranking

**Files:**
- Modify: `src/types.ts` (RankedDish)
- Modify: `src/recommender.ts`
- Test: `tests/recommender.test.ts`

**Interfaces:**
- Consumes: `Dish.keepsDays` from Task 3.
- Produces: `RankedDish` gains `coverage: number`. `rankDishes` computes coverage per dish and sorts by coverage DESC → `keepsDays` DESC → `estTotal` ASC. (No filtering here; the caller applies the threshold.)

- [ ] **Step 1: Write the failing test**

Append to `tests/recommender.test.ts` (the `dish()` helper there does not set `keepsDays`; these tests pass it explicitly via a small inline override):

```ts
const dishK = (nameRu: string, ings: string[], keepsDays: number): Dish => ({
  ...dish(nameRu, ings),
  keepsDays,
});

test("rankDishes ranks by coverage DESC over raw on-offer count", () => {
  const matches = new Map<string, Offer | null>([
    ["a", offer({ price: 1 })],
    ["b", offer({ price: 1 })],
    ["c", offer({ price: 1 })],
    ["d", offer({ price: 1 })],
    ["e", null],
  ]);
  // Full: 2/2 = 1.0 coverage. Partial: 3/4 = 0.75 coverage (more on offer, lower ratio).
  const ranked = rankDishes(
    [dish("Partial", ["a", "b", "c", "e"]), dish("Full", ["a", "b"])],
    matches
  );
  expect(ranked[0]!.dish.nameRu).toBe("Full");
  expect(ranked[0]!.coverage).toBe(1);
  expect(ranked[1]!.dish.nameRu).toBe("Partial");
  expect(ranked[1]!.coverage).toBe(0.75);
});

test("rankDishes breaks coverage ties by keepsDays DESC", () => {
  const matches = new Map<string, Offer | null>([["x", offer({ price: 5 })]]);
  const ranked = rankDishes(
    [dishK("Short", ["x"], 1), dishK("Long", ["x"], 5)],
    matches
  );
  expect(ranked[0]!.dish.nameRu).toBe("Long");
  expect(ranked[1]!.dish.nameRu).toBe("Short");
});

test("rankDishes coverage is 0 for a dish with no ingredients", () => {
  const ranked = rankDishes([dish("Empty", [])], new Map());
  expect(ranked[0]!.coverage).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/recommender.test.ts`
Expected: FAIL — `RankedDish` has no `coverage`; ordering tests fail.

- [ ] **Step 3: Implement coverage + ranking**

In `src/types.ts`, add `coverage` to `RankedDish`:

```ts
export type RankedDish = {
  dish: Dish;
  onOfferCount: number;
  estTotal: number;
  coverage: number; // onOfferCount / ingredientCount, 0..1
};
```

In `src/recommender.ts`, replace the body of `rankDishes`:

```ts
export function rankDishes(
  dishes: Dish[],
  matches: Map<string, Offer | null>
): RankedDish[] {
  const ranked: RankedDish[] = dishes.map((dish) => {
    let onOfferCount = 0;
    let estTotal = 0;
    for (const ing of dish.ingredients) {
      const m = matches.get(ing.canonical);
      if (m) {
        onOfferCount++;
        estTotal += m.price;
      }
    }
    const total = dish.ingredients.length;
    const coverage = total === 0 ? 0 : onOfferCount / total;
    return { dish, onOfferCount, estTotal, coverage };
  });
  // Favour fully-coverable dishes, then long-keeping ones (cook rarely), then cheap.
  return ranked.sort(
    (a, b) =>
      b.coverage - a.coverage ||
      (b.dish.keepsDays ?? 1) - (a.dish.keepsDays ?? 1) ||
      a.estTotal - b.estTotal
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/recommender.test.ts`
Expected: PASS (existing tests still pass — coverage ordering agrees with their on-offer-count assertions; 3 new tests pass).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/recommender.ts tests/recommender.test.ts
git commit -m "feat: rank dishes by coverage then keeps_days then cost"
```

---

### Task 6: Compact "cook-rarely" digest

**Files:**
- Modify: `src/bot/handlers.ts`
- Test: `tests/handlers.test.ts`

**Interfaces:**
- Consumes: `RankedDish.coverage` (Task 5), `Dish.keepsDays` (Task 3).
- Produces: `handleRecommend(deps: { dishes; matcher; coverageMin?; limit? }): Promise<string>` — filters to coverage ≥ `coverageMin` (default 0.7), takes the top `limit` (default 5), and renders one compact line per dish (no per-ingredient breakdown). Replaces the old `topN` parameter.

- [ ] **Step 1: Rewrite the failing test**

Replace the three existing `handleRecommend` tests in `tests/handlers.test.ts` with these (the `isAllowed` test stays unchanged):

```ts
test("handleRecommend renders a compact line per qualifying dish", async () => {
  const offers: Record<string, Offer> = {
    "картофель": { externalId: 1, store: "aldi", storeName: "Aldi", product: "Kartoffeln",
      price: 1.99, oldPrice: null, referencePrice: 0.8, unit: "kg", validFrom: "", validTo: "" },
    "сметана": { externalId: 2, store: "kaufland", storeName: "Kaufland", product: "Schmand",
      price: 0.99, oldPrice: null, referencePrice: 0.99, unit: "St", validFrom: "", validTo: "" },
  };
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient(c) { return offers[c] ?? null; },
  };
  const dishes: Dish[] = [{
    nameRu: "Картофельное пюре", nameUa: null, nameDe: null, cuisine: "ru",
    course: "second", keepsDays: 3, tags: [], servings: 4,
    ingredients: [{ canonical: "картофель", qty: 1, unit: "кг" }, { canonical: "сметана", qty: 1, unit: "уп" }],
  }];
  const text = await handleRecommend({ dishes, matcher });
  expect(text).toContain("Картофельное пюре");
  expect(text).toContain("2/2"); // both ingredients on offer
  expect(text).toContain("3"); // keeps_days surfaced
});

test("handleRecommend omits dishes below the coverage threshold", async () => {
  const offers: Record<string, Offer> = {
    "картофель": { externalId: 1, store: "aldi", storeName: "Aldi", product: "Kartoffeln",
      price: 1.0, oldPrice: null, referencePrice: 1.0, unit: "kg", validFrom: "", validTo: "" },
  };
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient(c) { return offers[c] ?? null; },
  };
  // 1 of 3 ingredients on offer → coverage 0.33 < 0.7 → omitted → fallback.
  const dishes: Dish[] = [{
    nameRu: "Борщ", nameUa: null, nameDe: null, cuisine: "ua",
    course: "first", keepsDays: 4, tags: [], servings: 4,
    ingredients: [
      { canonical: "картофель", qty: 1, unit: "кг" },
      { canonical: "свёкла", qty: 1, unit: "кг" },
      { canonical: "капуста", qty: 1, unit: "кг" },
    ],
  }];
  const text = await handleRecommend({ dishes, matcher });
  expect(text).toContain("70%");
  expect(text).not.toContain("Борщ");
});

test("handleRecommend respects the limit parameter", async () => {
  const offers: Record<string, Offer> = {
    "помидор": { externalId: 1, store: "kaufland", storeName: "Kaufland", product: "Tomaten",
      price: 1.99, oldPrice: null, referencePrice: 1.99, unit: "kg", validFrom: "", validTo: "" },
    "огурец": { externalId: 2, store: "aldi", storeName: "Aldi", product: "Gurken",
      price: 0.99, oldPrice: null, referencePrice: 0.99, unit: "kg", validFrom: "", validTo: "" },
  };
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient(c) { return offers[c] ?? null; },
  };
  const dishes: Dish[] = [
    { nameRu: "Салат", nameUa: null, nameDe: null, cuisine: "ru", course: "second", keepsDays: 1, tags: [], servings: 2,
      ingredients: [{ canonical: "помидор", qty: 1, unit: "шт" }] },
    { nameRu: "Окрошка", nameUa: null, nameDe: null, cuisine: "ru", course: "first", keepsDays: 1, tags: [], servings: 2,
      ingredients: [{ canonical: "огурец", qty: 1, unit: "шт" }] },
  ];
  const text = await handleRecommend({ dishes, matcher, limit: 1 });
  const shown = ["Салат", "Окрошка"].filter((n) => text.includes(n));
  expect(shown).toHaveLength(1);
});

test("handleRecommend returns a threshold-aware fallback when nothing qualifies", async () => {
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient() { return null; },
  };
  const dishes: Dish[] = [{
    nameRu: "Борщ", nameUa: null, nameDe: null, cuisine: "ua", course: "first", keepsDays: 4, tags: [], servings: 4,
    ingredients: [{ canonical: "свёкла", qty: 1, unit: "кг" }],
  }];
  const text = await handleRecommend({ dishes, matcher });
  expect(text).toContain("70%");
  expect(text).not.toEqual("");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/handlers.test.ts`
Expected: FAIL — old per-ingredient format / `topN` signature mismatch.

- [ ] **Step 3: Rewrite `handleRecommend`**

Replace the contents of `src/bot/handlers.ts` (keep `isAllowed` as-is; drop the now-unused `buildShoppingList` import):

```ts
import type { Dish, Offer } from "../types";
import type { Matcher } from "../matcher";
import { rankDishes } from "../recommender";

const DEFAULT_COVERAGE_MIN = 0.7;
const DEFAULT_DIGEST_LIMIT = 5;

export function isAllowed(userId: number | undefined, allowed: number[]): boolean {
  return userId !== undefined && allowed.includes(userId);
}

export async function handleRecommend(deps: {
  dishes: Dish[];
  matcher: Matcher;
  coverageMin?: number;
  limit?: number;
}): Promise<string> {
  const coverageMin = deps.coverageMin ?? DEFAULT_COVERAGE_MIN;
  const limit = deps.limit ?? DEFAULT_DIGEST_LIMIT;

  const canonicals = [
    ...new Set(deps.dishes.flatMap((d) => d.ingredients.map((i) => i.canonical))),
  ];
  const matches = new Map<string, Offer | null>();
  for (const c of canonicals) {
    matches.set(c, await deps.matcher.matchIngredient(c));
  }

  const top = rankDishes(deps.dishes, matches)
    .filter((r) => r.coverage >= coverageMin)
    .slice(0, limit);

  const pct = Math.round(coverageMin * 100);
  if (top.length === 0) {
    return `На этой неделе нет блюд, где хотя бы ${pct}% ингредиентов в акции 😕`;
  }

  const lines: string[] = ["🛒 Выгодно приготовить на этой неделе:\n"];
  for (const r of top) {
    const total = r.dish.ingredients.length;
    const keeps = r.dish.keepsDays ?? 1;
    lines.push(
      `🍲 *${r.dish.nameRu}* — ${r.onOfferCount}/${total} ингр. в акции, ~${r.estTotal.toFixed(2)}€, хранится ~${keeps} дн.`
    );
  }
  return lines.join("\n").trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bot/handlers.ts tests/handlers.test.ts
git commit -m "feat: compact coverage-thresholded cook-rarely digest"
```

---

### Task 7: Idempotent 100+ seeder

**Files:**
- Modify: `src/recipes/recipeStore.ts` (`seedDishes` only)
- Test: `tests/recipeStore.test.ts`

**Interfaces:**
- Consumes: `Dish.course`/`Dish.keepsDays` columns and `DishSeedSchema` from Task 3.
- Produces: `seedDishes(db, llm, target)` now treats `target` as the desired total catalogue size, primes its dedupe set from existing `name_ru` rows, adds only what's missing, returns the number of NEW dishes inserted. The prompt asks for CIS + popular world dishes with `course` and `keepsDays`.

- [ ] **Step 1: Write the failing test**

Append to `tests/recipeStore.test.ts`:

```ts
test("seedDishes is idempotent: a second run with the target already met adds nothing", async () => {
  const db = openDb(":memory:");
  const fakeLlm: Llm = {
    async structured<T>(): Promise<T> {
      return { dishes: [borscht, pelmeni] } as unknown as T;
    },
  };
  const first = await seedDishes(db, fakeLlm, 2);
  expect(first).toBe(2);
  const second = await seedDishes(db, fakeLlm, 2);
  expect(second).toBe(0);
  expect(listDishes(db)).toHaveLength(2);
});

test("seedDishes only adds dishes missing from the existing catalogue", async () => {
  const db = openDb(":memory:");
  insertDish(db, borscht); // already present
  const fakeLlm: Llm = {
    async structured<T>(): Promise<T> {
      return { dishes: [borscht, pelmeni] } as unknown as T;
    },
  };
  const added = await seedDishes(db, fakeLlm, 2);
  expect(added).toBe(1); // borscht skipped, pelmeni added
  expect(listDishes(db).map((d) => d.nameRu).sort()).toEqual(["Борщ", "Пельмени"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/recipeStore.test.ts`
Expected: FAIL — the current seeder counts toward `count` without consulting existing rows; second run re-adds.

- [ ] **Step 3: Rewrite `seedDishes`**

Replace the `seedDishes` function in `src/recipes/recipeStore.ts`:

```ts
/**
 * Grow the dish catalogue to `target` total dishes, idempotently. Existing
 * dishes (by name_ru) are never duplicated; only missing dishes are generated.
 * Seeds in small batches because one call for many dishes overflows the model's
 * output-token budget. Returns the number of NEW dishes inserted.
 */
export async function seedDishes(db: Database, llm: Llm, target: number): Promise<number> {
  const existing = db.query("SELECT name_ru FROM dishes").all() as { name_ru: string }[];
  const seen = new Set<string>(existing.map((r) => r.name_ru));
  const need = Math.max(0, target - seen.size);

  const BATCH = 8;
  let added = 0;
  while (added < need) {
    const want = Math.min(BATCH, need - added);
    const exclude =
      seen.size > 0
        ? ` Do NOT repeat any of these already-known dishes: ${[...seen].join(", ")}.`
        : "";
    const out = await llm.structured({
      system:
        "You are a chef cataloguing home dishes a CIS family can cook in Germany: mostly Ukrainian and Russian classics, plus globally popular dishes (lasagne, carbonara, etc.).",
      prompt:
        `Return ${want} popular dishes.${exclude} For each provide: nameRu, nameUa (or null), ` +
        `nameDe (or null), cuisine (short code like 'ru'|'ua'|'it'), course ('first' for soups/porridge, ` +
        `'second' for mains), keepsDays (integer 1-5: how many days the cooked dish keeps in a fridge), ` +
        `tags (array of strings), servings (integer), and ingredients with canonical Russian names, ` +
        `qty (number or null) and unit (string or null). Use ingredients buyable in German supermarkets.`,
      toolName: "save_dishes",
      description: "Persist the generated dish catalogue",
      schema: DishSeedSchema,
      maxTokens: 4096,
    });
    let batchAdded = 0;
    for (const dish of out.dishes) {
      if (seen.has(dish.nameRu)) continue;
      seen.add(dish.nameRu);
      insertDish(db, dish);
      added++;
      batchAdded++;
      if (added >= need) break;
    }
    if (batchAdded === 0) break; // model produced nothing new — stop rather than loop forever
  }
  return added;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/recipeStore.test.ts`
Expected: PASS (existing seeder tests still pass — empty DB with `target=2` adds 2, `target=1` adds 1; new idempotency/skip tests pass).

- [ ] **Step 5: Commit**

```bash
git add src/recipes/recipeStore.ts tests/recipeStore.test.ts
git commit -m "feat: idempotent catalogue seeding toward a total target with course/keepsDays"
```

---

### Task 8: Composition wiring + seed target

**Files:**
- Modify: `src/bot/bot.ts`
- Modify: `src/main.ts`
- Modify: `src/recipes/seed.ts`

**Interfaces:**
- Consumes: `Config.storeWhitelist`/`offerCoverageMin`/`digestLimit` (Task 2), `createMatcher` whitelist (Task 4), `handleRecommend` coverageMin/limit (Task 6), `seedDishes` target (Task 7), `StoreKey` (Task 1).
- Produces: the running bot filters offers to the configured whitelist and replies with the compact thresholded digest; `bun run seed` targets 110 dishes.

> This task has no unit test of its own — it is composition-root glue. Its deliverable is verified by `bun test` (whole suite green) plus `bun build`-clean compilation. The implementer MUST run both.

- [ ] **Step 1: Thread config into `createBot`**

In `src/bot/bot.ts`, add two optional deps and forward them to `handleRecommend`. Update the `createBot` signature:

```ts
export function createBot(deps: {
  token: string;
  allowedUserIds: number[];
  dishes: Dish[];
  matcher: Matcher;
  coverageMin?: number;
  digestLimit?: number;
}): Bot {
```

Update the `recommend` closure to pass them through:

```ts
  const recommend = async (ctx: Context) => {
    const text = await handleRecommend({
      dishes: deps.dishes,
      matcher: deps.matcher,
      coverageMin: deps.coverageMin,
      limit: deps.digestLimit,
    });
    await ctx.reply(text, { parse_mode: "Markdown" });
  };
```

- [ ] **Step 2: Wire the composition root**

In `src/main.ts`, build the whitelist set from config and pass everything through. Add the import:

```ts
import type { StoreKey } from "./stores";
```

Change the matcher construction to include the whitelist:

```ts
const whitelist = new Set<StoreKey>(cfg.storeWhitelist);
const matcher = createMatcher({ db, llm, provider, week: isoWeek(new Date()), whitelist });
```

Change the `createBot` call to pass the digest config:

```ts
const bot = createBot({
  token: cfg.telegramBotToken,
  allowedUserIds: cfg.allowedUserIds,
  dishes,
  matcher,
  coverageMin: cfg.offerCoverageMin,
  digestLimit: cfg.digestLimit,
});
```

- [ ] **Step 3: Raise the seed target**

In `src/recipes/seed.ts`, change the target and the log line:

```ts
  const n = await seedDishes(
    db,
    createLlm({ apiKey: cfg.anthropicApiKey, model: cfg.llmModel }),
    110
  );
  console.log(`seeded ${n} new dishes (catalogue target 110)`);
```

- [ ] **Step 4: Run the whole suite and a build check**

Run: `bun test`
Expected: PASS (all suites).

Run: `bun build src/main.ts --target=bun --outfile=/dev/null`
Expected: build succeeds with no type/resolution errors.

- [ ] **Step 5: Commit**

```bash
git add src/bot/bot.ts src/main.ts src/recipes/seed.ts
git commit -m "chore: wire whitelist + digest config through the composition root; seed target 110"
```

---

## Manual Verification (after all tasks, on the deployed server)

These are operator steps, not automated — run them after the branch merges and deploys (they hit the live marktguru API + LLM and the real DB):

1. Redeploy: `./deploy.sh home` (the guarded migration upgrades the existing 30-dish DB in place).
2. Seed to 100+: `ssh home 'cd ~/annona && docker compose run --rm annona bun run src/recipes/seed.ts'` then `ssh home 'cd ~/annona && docker compose restart annona'`. Confirm the log reports new dishes and the catalogue reaches ~110.
3. In Telegram, send `/digest`. Confirm a short list (≤5) of dishes, each one line with `N/M ингр. в акции`, an estimated total, and a "хранится ~N дн." hint.
4. Confirm offers come only from whitelist chains: a non-whitelist store should no longer surface. (Watch `docker compose logs` for the per-ingredient match behaviour.)

`mapsLink` is built and unit-tested in Task 1 but is not yet rendered into any reply — it is consumed by Layer 2's store-grouped shopping list (`/list`). That is intended layering, not a gap.

---

## Self-Review

**Spec coverage (Layer 1 deliverables from the Phase 2 spec §14):**
- Store registry + filter → Tasks 1 (registry) + 4 (filter). ✅
- Maps links → Task 1 (`mapsLink`, tested; rendered in Layer 2). ✅
- `dishes` metadata + migration → Task 3 (guarded idempotent ADD COLUMN). ✅
- Idempotent 100+ seeder → Task 7 + Task 8 (target 110). ✅
- Coverage threshold + keeping-aware ranking → Task 5 (rank) + Task 6 (threshold). ✅
- Compact `/digest` → Task 6. ✅
- New config keys → Task 2. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code; every command has an expected result.

**Type consistency:** `StoreKey`/`canonicalStore`/`mapsLink` (Task 1) are consumed with matching signatures in Tasks 2, 4, 8. `Dish.course`/`Dish.keepsDays` (Task 3) are read in Tasks 5, 6, 7. `RankedDish.coverage` (Task 5) is read in Task 6. `createMatcher` whitelist (Task 4) and `createBot` coverageMin/digestLimit (Task 6/8) are supplied in Task 8. `handleRecommend` drops `topN` in favour of `coverageMin`/`limit` (Task 6) and the sole caller (`bot.ts`) is updated in Task 8.
