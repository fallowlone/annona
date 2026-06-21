# Annona Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a walking-skeleton family grocery-savings assistant: search German supermarket weekly deals for PLZ 30459, match Russian/Ukrainian dish ingredients to those deals via an LLM, and answer over a Telegram bot ("what to cook cheaply this week" + "where to buy it").

**Architecture:** Single Bun process. A `Fetcher` (anti-ban, proxy-ready) is the only network egress. A `marktguru` provider searches the unofficial marktguru API per ingredient term. An LLM service (Claude Haiku, structured tool-use output) handles ingredient→German-term translation and intent. SQLite stores dishes, ingredients, synonym/match caches. A `Recommender` ranks dishes by how cheaply they can be cooked now; a grammY bot exposes it to two whitelisted users.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, `bun:test`, grammY, `@anthropic-ai/sdk`, `zod`, `zod-to-json-schema`. Native `fetch` (no axios).

## Global Constraints

- Runtime is **Bun** (>= 1.1). Use `bun test`, `bun run`, `bun:sqlite`, `Bun.env`. No Node-only APIs.
- TypeScript strict mode on. No `any` in exported signatures.
- LLM model id is **`claude-haiku-4-5`** (override via `LLM_MODEL`). Set it once in config; never hardcode elsewhere.
- Location is **PLZ 30459, Hannover** (override via `LOCATION_PLZ`). Default zipCode in any marktguru call is `30459`.
- All external data (marktguru JSON, LLM output, Telegram input) is validated at the boundary with `zod` before use.
- Only `ALLOWED_USER_IDS` may use the bot. Every handler checks this first.
- Files stay focused and small (< 300 lines). One responsibility per file.
- Commit after every green test. Conventional commit messages (`feat:`, `test:`, `chore:`). No attribution trailer (disabled globally).
- Secrets come from env only. Never commit `.env`.

## File Structure

```
annona/
├── package.json, tsconfig.json, .env.example, .gitignore
├── src/
│   ├── config.ts            # typed env config (zod)
│   ├── types.ts             # Offer, Dish, Ingredient, RankedDish, ShoppingItem
│   ├── db/
│   │   ├── db.ts            # open bun:sqlite + run migrations
│   │   └── migrations.ts    # ordered SQL DDL
│   ├── net/
│   │   └── fetcher.ts       # anti-ban HTTP client, proxy-ready (mode 'none')
│   ├── providers/
│   │   └── marktguru.ts     # extractKeys, parseOffers, createMarktguruProvider
│   ├── llm/
│   │   └── llm.ts           # Anthropic wrapper, structured() tool-use + zod
│   ├── normalize.ts         # parseUnitPrice, cleanName, dedupeOffers
│   ├── recipes/
│   │   ├── recipeStore.ts   # insertDish, listDishes, getIngredients
│   │   └── seed.ts          # LLM-seed ~30 dishes (script entry)
│   ├── matcher.ts           # searchTerms (synonym cache + LLM), matchIngredient
│   ├── recommender.ts       # rankDishes, buildShoppingList
│   ├── bot/
│   │   ├── handlers.ts      # isAllowed, handleDigest, handleWhatToCook
│   │   └── bot.ts           # grammY wiring
│   └── main.ts              # compose deps, start bot
├── tests/                    # mirrors src/ ; bun:test
└── fixtures/                 # marktguru-home.html, marktguru-search.json
```

---

### Task 1: Project scaffold + typed config

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `loadConfig(env: Record<string,string|undefined>): Config` and the `Config` type:
  ```ts
  type ProxyMode = 'none' | 'pool' | 'service';
  type Config = {
    locationPlz: number;
    locationCity: string;
    telegramBotToken: string;
    allowedUserIds: number[];
    anthropicApiKey: string;
    llmModel: string;        // default 'claude-haiku-4-5'
    proxyMode: ProxyMode;    // default 'none'
  };
  ```

- [ ] **Step 1: Initialize the project and dependencies**

```bash
cd /Users/artemmac/dev/annona
bun init -y
bun add grammy @anthropic-ai/sdk zod zod-to-json-schema
```

- [ ] **Step 2: Set tsconfig strict and add scripts**

Edit `tsconfig.json` to ensure `"strict": true` and `"types": ["bun-types"]`. Edit `package.json` to add:

```json
{
  "type": "module",
  "scripts": {
    "test": "bun test",
    "start": "bun run src/main.ts",
    "seed": "bun run src/recipes/seed.ts"
  }
}
```

- [ ] **Step 3: Write `.gitignore` and `.env.example`**

`.gitignore`:
```
node_modules/
*.db
.env
```

`.env.example`:
```
LOCATION_PLZ=30459
LOCATION_CITY=Hannover
TELEGRAM_BOT_TOKEN=
ALLOWED_USER_IDS=
ANTHROPIC_API_KEY=
LLM_MODEL=claude-haiku-4-5
PROXY_MODE=none
```

- [ ] **Step 4: Write the failing test**

`tests/config.test.ts`:
```ts
import { test, expect } from "bun:test";
import { loadConfig } from "../src/config";

const base = {
  TELEGRAM_BOT_TOKEN: "tok",
  ALLOWED_USER_IDS: "111,222",
  ANTHROPIC_API_KEY: "sk-test",
};

test("parses csv user ids and applies defaults", () => {
  const cfg = loadConfig(base);
  expect(cfg.allowedUserIds).toEqual([111, 222]);
  expect(cfg.locationPlz).toBe(30459);
  expect(cfg.llmModel).toBe("claude-haiku-4-5");
  expect(cfg.proxyMode).toBe("none");
});

test("throws when a required secret is missing", () => {
  expect(() => loadConfig({ ALLOWED_USER_IDS: "1" })).toThrow();
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `bun test tests/config.test.ts`
Expected: FAIL — cannot find module `../src/config`.

- [ ] **Step 6: Implement `src/config.ts`**

```ts
import { z } from "zod";

const csvNumbers = z.string().transform((s) =>
  s.split(",").map((x) => x.trim()).filter(Boolean).map(Number)
).pipe(z.array(z.number().int()).min(1));

const schema = z.object({
  LOCATION_PLZ: z.coerce.number().int().default(30459),
  LOCATION_CITY: z.string().default("Hannover"),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ALLOWED_USER_IDS: csvNumbers,
  ANTHROPIC_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().default("claude-haiku-4-5"),
  PROXY_MODE: z.enum(["none", "pool", "service"]).default("none"),
});

export type ProxyMode = "none" | "pool" | "service";
export type Config = {
  locationPlz: number;
  locationCity: string;
  telegramBotToken: string;
  allowedUserIds: number[];
  anthropicApiKey: string;
  llmModel: string;
  proxyMode: ProxyMode;
};

export function loadConfig(env: Record<string, string | undefined>): Config {
  const p = schema.parse(env);
  return {
    locationPlz: p.LOCATION_PLZ,
    locationCity: p.LOCATION_CITY,
    telegramBotToken: p.TELEGRAM_BOT_TOKEN,
    allowedUserIds: p.ALLOWED_USER_IDS,
    anthropicApiKey: p.ANTHROPIC_API_KEY,
    llmModel: p.LLM_MODEL,
    proxyMode: p.PROXY_MODE,
  };
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `bun test tests/config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json .gitignore .env.example src/config.ts tests/config.test.ts bun.lockb
git commit -m "feat: project scaffold and typed config"
```

---

### Task 2: Domain types + Normalizer

**Files:**
- Create: `src/types.ts`, `src/normalize.ts`
- Test: `tests/normalize.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // src/types.ts
  export type Offer = {
    externalId: number;
    store: string;          // advertiser uniqueName, e.g. 'aldi-nord'
    storeName: string;      // advertiser display name
    product: string;        // human product text
    price: number;          // EUR
    oldPrice: number | null;
    referencePrice: number | null; // per-unit price, e.g. €/kg
    unit: string;           // unit shortName, e.g. 'kg', 'St'
    validFrom: string;      // ISO date
    validTo: string;        // ISO date
  };
  export type Ingredient = { canonical: string; qty: number | null; unit: string | null };
  export type Dish = {
    id?: number;
    nameRu: string;
    nameUa: string | null;
    nameDe: string | null;
    cuisine: string;        // 'ru' | 'ua'
    tags: string[];
    servings: number;
    ingredients: Ingredient[];
  };
  export type RankedDish = { dish: Dish; onOfferCount: number; estTotal: number };
  export type ShoppingItem = { ingredient: string; store: string; product: string; price: number };
  ```
- `cleanName(raw: string): string`
- `effectiveUnitPrice(o: Offer): number` — `referencePrice ?? price`
- `dedupeOffers(offers: Offer[]): Offer[]` — keep cheapest `effectiveUnitPrice` per `externalId`

- [ ] **Step 1: Write `src/types.ts`**

Paste the type block from the Interfaces section above into `src/types.ts`.

- [ ] **Step 2: Write the failing test**

`tests/normalize.test.ts`:
```ts
import { test, expect } from "bun:test";
import { cleanName, effectiveUnitPrice, dedupeOffers } from "../src/normalize";
import type { Offer } from "../src/types";

const mk = (over: Partial<Offer>): Offer => ({
  externalId: 1, store: "aldi-nord", storeName: "Aldi Nord", product: "X",
  price: 2, oldPrice: null, referencePrice: null, unit: "St",
  validFrom: "2026-06-22", validTo: "2026-06-28", ...over,
});

test("cleanName trims and collapses whitespace", () => {
  expect(cleanName("  Schmand   Saure  Sahne ")).toBe("Schmand Saure Sahne");
});

test("effectiveUnitPrice prefers referencePrice", () => {
  expect(effectiveUnitPrice(mk({ price: 2, referencePrice: 1.5 }))).toBe(1.5);
  expect(effectiveUnitPrice(mk({ price: 2, referencePrice: null }))).toBe(2);
});

test("dedupeOffers keeps cheapest per externalId", () => {
  const out = dedupeOffers([
    mk({ externalId: 7, referencePrice: 3 }),
    mk({ externalId: 7, referencePrice: 2 }),
    mk({ externalId: 8, referencePrice: 5 }),
  ]);
  expect(out).toHaveLength(2);
  expect(out.find((o) => o.externalId === 7)!.referencePrice).toBe(2);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/normalize.test.ts`
Expected: FAIL — cannot find module `../src/normalize`.

- [ ] **Step 4: Implement `src/normalize.ts`**

```ts
import type { Offer } from "./types";

export function cleanName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export function effectiveUnitPrice(o: Offer): number {
  return o.referencePrice ?? o.price;
}

export function dedupeOffers(offers: Offer[]): Offer[] {
  const best = new Map<number, Offer>();
  for (const o of offers) {
    const cur = best.get(o.externalId);
    if (!cur || effectiveUnitPrice(o) < effectiveUnitPrice(cur)) best.set(o.externalId, o);
  }
  return [...best.values()];
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/normalize.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/normalize.ts tests/normalize.test.ts
git commit -m "feat: domain types and offer normalizer"
```

---

### Task 3: Persistence (SQLite + migrations + repo helpers)

**Files:**
- Create: `src/db/migrations.ts`, `src/db/db.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  import { Database } from "bun:sqlite";
  export const MIGRATIONS: string[];               // ordered DDL statements
  export function openDb(path: string): Database;   // opens + migrates
  ```
  Tables created: `dishes`, `ingredients`, `synonyms`, `match_cache`, `offers`, `meta` (schema from the spec §6).

- [ ] **Step 1: Write `src/db/migrations.ts`**

```ts
export const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS dishes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name_ru TEXT NOT NULL, name_ua TEXT, name_de TEXT,
     cuisine TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
     servings INTEGER NOT NULL DEFAULT 4
   );`,
  `CREATE TABLE IF NOT EXISTS ingredients (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     dish_id INTEGER NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
     canonical_name TEXT NOT NULL, qty REAL, unit TEXT
   );`,
  `CREATE TABLE IF NOT EXISTS synonyms (
     canonical_name TEXT PRIMARY KEY,
     search_terms_de TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS match_cache (
     ingredient_canonical TEXT NOT NULL, week TEXT NOT NULL,
     offer_json TEXT, created_at TEXT NOT NULL,
     PRIMARY KEY (ingredient_canonical, week)
   );`,
  `CREATE TABLE IF NOT EXISTS offers (
     external_id INTEGER PRIMARY KEY, store TEXT, store_name TEXT,
     product TEXT, price REAL, old_price REAL, reference_price REAL,
     unit TEXT, valid_from TEXT, valid_to TEXT, fetched_at TEXT, is_stale INTEGER DEFAULT 0
   );`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`,
];
```

- [ ] **Step 2: Write the failing test**

`tests/db.test.ts`:
```ts
import { test, expect } from "bun:test";
import { openDb } from "../src/db/db";

test("openDb creates all tables and supports a roundtrip", () => {
  const db = openDb(":memory:");
  const tables = db.query(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all() as { name: string }[];
  const names = tables.map((t) => t.name);
  for (const t of ["dishes", "ingredients", "synonyms", "match_cache", "offers", "meta"]) {
    expect(names).toContain(t);
  }
  db.run("INSERT INTO meta(key,value) VALUES('k','v')");
  const row = db.query("SELECT value FROM meta WHERE key='k'").get() as { value: string };
  expect(row.value).toBe("v");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/db.test.ts`
Expected: FAIL — cannot find module `../src/db/db`.

- [ ] **Step 4: Implement `src/db/db.ts`**

```ts
import { Database } from "bun:sqlite";
import { MIGRATIONS } from "./migrations";

export function openDb(path: string): Database {
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");
  for (const stmt of MIGRATIONS) db.run(stmt);
  return db;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/db.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations.ts src/db/db.ts tests/db.test.ts
git commit -m "feat: sqlite persistence with migrations"
```

---

### Task 4: Fetcher (anti-ban HTTP client, proxy-ready)

**Files:**
- Create: `src/net/fetcher.ts`
- Test: `tests/fetcher.test.ts`

**Interfaces:**
- Consumes: `Config` (proxyMode) from Task 1.
- Produces:
  ```ts
  export interface Fetcher {
    getJson<T>(url: string, opts?: ReqOpts): Promise<T>;
    getText(url: string, opts?: ReqOpts): Promise<string>;
  }
  export type ReqOpts = {
    headers?: Record<string, string>;
    query?: Record<string, string | number>;
    retries?: number;     // default 3
  };
  export function createFetcher(opts?: {
    fetchImpl?: typeof fetch;     // injectable for tests
    sleep?: (ms: number) => Promise<void>;
    proxyMode?: "none" | "pool" | "service";
  }): Fetcher;
  ```
  Behavior: rotates a realistic `User-Agent`, retries on HTTP 429/403/5xx with exponential backoff (`sleep(2^n * 250ms)`) up to `retries`, throws after exhaustion. `proxyMode 'none'` adds no proxy (pool/service throw "not configured" for now).

- [ ] **Step 1: Write the failing test**

`tests/fetcher.test.ts`:
```ts
import { test, expect } from "bun:test";
import { createFetcher } from "../src/net/fetcher";

function fakeFetch(sequence: Array<{ status: number; body: string }>) {
  let i = 0;
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
    const r = sequence[Math.min(i, sequence.length - 1)];
    i++;
    return new Response(r.body, { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("retries on 429 then succeeds, sending a User-Agent", async () => {
  const { impl, calls } = fakeFetch([
    { status: 429, body: "" },
    { status: 200, body: JSON.stringify({ ok: true }) },
  ]);
  const f = createFetcher({ fetchImpl: impl, sleep: async () => {} });
  const out = await f.getJson<{ ok: boolean }>("https://x.test/a");
  expect(out.ok).toBe(true);
  expect(calls.length).toBe(2);
  expect(calls[0].headers["User-Agent"]).toBeTruthy();
});

test("throws after exhausting retries", async () => {
  const { impl } = fakeFetch([{ status: 503, body: "" }]);
  const f = createFetcher({ fetchImpl: impl, sleep: async () => {} });
  await expect(f.getJson("https://x.test/a", { retries: 2 })).rejects.toThrow();
});

test("appends query params", async () => {
  const { impl, calls } = fakeFetch([{ status: 200, body: "{}" }]);
  const f = createFetcher({ fetchImpl: impl, sleep: async () => {} });
  await f.getJson("https://x.test/s", { query: { q: "Cola", zipCode: 30459 } });
  expect(calls[0].url).toContain("q=Cola");
  expect(calls[0].url).toContain("zipCode=30459");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/fetcher.test.ts`
Expected: FAIL — cannot find module `../src/net/fetcher`.

- [ ] **Step 3: Implement `src/net/fetcher.ts`**

```ts
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
];

export type ReqOpts = {
  headers?: Record<string, string>;
  query?: Record<string, string | number>;
  retries?: number;
};
export interface Fetcher {
  getJson<T>(url: string, opts?: ReqOpts): Promise<T>;
  getText(url: string, opts?: ReqOpts): Promise<string>;
}

const RETRYABLE = new Set([403, 408, 429, 500, 502, 503, 504]);

export function createFetcher(opts?: {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  proxyMode?: "none" | "pool" | "service";
}): Fetcher {
  const doFetch = opts?.fetchImpl ?? fetch;
  const sleep = opts?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const mode = opts?.proxyMode ?? "none";
  if (mode !== "none") throw new Error(`proxy mode '${mode}' not configured yet`);

  let uaIdx = 0;
  const nextUa = () => USER_AGENTS[uaIdx++ % USER_AGENTS.length];

  function buildUrl(url: string, query?: ReqOpts["query"]): string {
    if (!query) return url;
    const u = new URL(url);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async function request(url: string, opts?: ReqOpts): Promise<Response> {
    const retries = opts?.retries ?? 3;
    const full = buildUrl(url, opts?.query);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await doFetch(full, {
          headers: { "User-Agent": nextUa(), Accept: "application/json", ...(opts?.headers ?? {}) },
        });
        if (RETRYABLE.has(res.status)) {
          lastErr = new Error(`HTTP ${res.status}`);
          await sleep(Math.pow(2, attempt) * 250 + Math.random() * 150);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res;
      } catch (e) {
        lastErr = e;
        await sleep(Math.pow(2, attempt) * 250 + Math.random() * 150);
      }
    }
    throw new Error(`request failed for ${url}: ${String(lastErr)}`);
  }

  return {
    async getJson<T>(url: string, o?: ReqOpts): Promise<T> {
      return (await (await request(url, o)).json()) as T;
    },
    async getText(url: string, o?: ReqOpts): Promise<string> {
      return await (await request(url, o)).text();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/fetcher.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/net/fetcher.ts tests/fetcher.test.ts
git commit -m "feat: anti-ban fetcher with retry/backoff, proxy-ready"
```

---

### Task 5: marktguru provider (key extraction + parser + search)

**Files:**
- Create: `src/providers/marktguru.ts`
- Create: `fixtures/marktguru-home.html`, `fixtures/marktguru-search.json`
- Test: `tests/marktguru.test.ts`

**Verified API facts (from community clients sydev/marktguru, manmal/marktguru-cli):**
- Base: `https://api.marktguru.de/api/v1`; search: `GET /offers/search?as=web&q=<term>&zipCode=30459&limit=&offset=0`
- Headers: `x-apikey`, `x-clientkey`
- Keys live in a `<script type="application/json">` block on `https://www.marktguru.de/` under `config.apiKey` / `config.clientKey`
- Offer fields used: `id, price, oldPrice, referencePrice, unit.shortName, product.name, brand.name, description, advertisers[].{name,uniqueName}, validityDates[].{from,to}`

**Interfaces:**
- Consumes: `Fetcher` (Task 4), `Offer` + `cleanName` (Task 2).
- Produces:
  ```ts
  export interface OfferProvider { search(query: string): Promise<Offer[]> }
  export function extractKeys(html: string): { apiKey: string; clientKey: string };
  export function parseOffers(json: unknown): Offer[];
  export async function loadKeys(fetcher: Fetcher): Promise<{ apiKey: string; clientKey: string }>;
  export function createMarktguruProvider(deps: {
    fetcher: Fetcher;
    zipCode: number;
    keys: { apiKey: string; clientKey: string };
  }): OfferProvider;
  ```

- [ ] **Step 1: Write fixtures**

`fixtures/marktguru-home.html`:
```html
<!doctype html><html><head>
<script type="application/json">{"config":{"apiKey":"AK_TEST","clientKey":"CK_TEST"}}</script>
</head><body>marktguru</body></html>
```

`fixtures/marktguru-search.json` (representative shape; replace with a real capture in Step 8):
```json
{
  "results": [
    {
      "id": 1001, "price": 1.49, "oldPrice": 1.99, "referencePrice": 1.49,
      "description": "Schmand 24% Fett", "unit": { "shortName": "St" },
      "product": { "name": "Schmand" }, "brand": { "name": "Gut & Günstig" },
      "advertisers": [{ "name": "Edeka", "uniqueName": "edeka" }],
      "validityDates": [{ "from": "2026-06-22T00:00:00", "to": "2026-06-28T00:00:00" }]
    },
    {
      "id": 1002, "price": 0.99, "oldPrice": null, "referencePrice": 0.99,
      "description": "Saure Sahne 10%", "unit": { "shortName": "St" },
      "product": { "name": "Saure Sahne" }, "brand": { "name": "K-Classic" },
      "advertisers": [{ "name": "Kaufland", "uniqueName": "kaufland" }],
      "validityDates": [{ "from": "2026-06-22T00:00:00", "to": "2026-06-28T00:00:00" }]
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

`tests/marktguru.test.ts`:
```ts
import { test, expect } from "bun:test";
import { extractKeys, parseOffers, createMarktguruProvider } from "../src/providers/marktguru";
import type { Fetcher } from "../src/net/fetcher";

const home = await Bun.file("fixtures/marktguru-home.html").text();
const search = JSON.parse(await Bun.file("fixtures/marktguru-search.json").text());

test("extractKeys reads apiKey/clientKey from the json script block", () => {
  expect(extractKeys(home)).toEqual({ apiKey: "AK_TEST", clientKey: "CK_TEST" });
});

test("parseOffers maps marktguru results to Offer", () => {
  const offers = parseOffers(search);
  expect(offers).toHaveLength(2);
  const o = offers[0];
  expect(o.externalId).toBe(1001);
  expect(o.store).toBe("edeka");
  expect(o.storeName).toBe("Edeka");
  expect(o.product).toBe("Schmand");
  expect(o.price).toBe(1.49);
  expect(o.validFrom).toBe("2026-06-22T00:00:00");
});

test("provider.search sends keys + zipCode and returns parsed offers", async () => {
  let seen: { url: string; headers: Record<string, string>; query?: Record<string, string | number> } | null = null;
  const fakeFetcher: Fetcher = {
    async getJson<T>(url: string, o?: { headers?: Record<string, string>; query?: Record<string, string | number> }) {
      seen = { url, headers: o?.headers ?? {}, query: o?.query };
      return search as T;
    },
    async getText() { return ""; },
  };
  const provider = createMarktguruProvider({
    fetcher: fakeFetcher, zipCode: 30459, keys: { apiKey: "AK", clientKey: "CK" },
  });
  const offers = await provider.search("Schmand");
  expect(offers).toHaveLength(2);
  expect(seen!.headers["x-apikey"]).toBe("AK");
  expect(seen!.query!.q).toBe("Schmand");
  expect(seen!.query!.zipCode).toBe(30459);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/marktguru.test.ts`
Expected: FAIL — cannot find module `../src/providers/marktguru`.

- [ ] **Step 4: Implement `src/providers/marktguru.ts`**

```ts
import type { Fetcher } from "../net/fetcher";
import type { Offer } from "../types";
import { cleanName } from "../normalize";

const BASE = "https://api.marktguru.de/api/v1";
const HOME = "https://www.marktguru.de/";

export interface OfferProvider {
  search(query: string): Promise<Offer[]>;
}

export function extractKeys(html: string): { apiKey: string; clientKey: string } {
  const re = /<script\s+type="application\/json">([\s\S]*?)<\/script>/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const data = JSON.parse(m[1]);
      const cfg = data?.config ?? data?.marktguruConfig?.config;
      if (cfg?.apiKey && cfg?.clientKey) {
        return { apiKey: String(cfg.apiKey), clientKey: String(cfg.clientKey) };
      }
    } catch { /* not the block we want */ }
  }
  throw new Error("marktguru: could not extract api/client keys from homepage");
}

type RawOffer = {
  id: number; price: number; oldPrice: number | null; referencePrice: number | null;
  description?: string; unit?: { shortName?: string };
  product?: { name?: string }; brand?: { name?: string };
  advertisers?: Array<{ name?: string; uniqueName?: string }>;
  validityDates?: Array<{ from?: string; to?: string }>;
};

export function parseOffers(json: unknown): Offer[] {
  const results = (json as { results?: RawOffer[] })?.results ?? [];
  return results.map((r) => {
    const adv = r.advertisers?.[0];
    const valid = r.validityDates?.[0];
    return {
      externalId: r.id,
      store: adv?.uniqueName ?? "unknown",
      storeName: adv?.name ?? "Unknown",
      product: cleanName(r.product?.name || r.brand?.name || r.description || ""),
      price: r.price,
      oldPrice: r.oldPrice ?? null,
      referencePrice: r.referencePrice ?? null,
      unit: r.unit?.shortName ?? "",
      validFrom: valid?.from ?? "",
      validTo: valid?.to ?? "",
    } satisfies Offer;
  });
}

export async function loadKeys(fetcher: Fetcher): Promise<{ apiKey: string; clientKey: string }> {
  const html = await fetcher.getText(HOME, { headers: { Accept: "text/html" } });
  return extractKeys(html);
}

export function createMarktguruProvider(deps: {
  fetcher: Fetcher;
  zipCode: number;
  keys: { apiKey: string; clientKey: string };
}): OfferProvider {
  return {
    async search(query: string): Promise<Offer[]> {
      const json = await deps.fetcher.getJson<unknown>(`${BASE}/offers/search`, {
        headers: { "x-apikey": deps.keys.apiKey, "x-clientkey": deps.keys.clientKey },
        query: { as: "web", q: query, limit: 80, offset: 0, zipCode: deps.zipCode },
      });
      return parseOffers(json);
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/marktguru.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/providers/marktguru.ts fixtures/marktguru-home.html fixtures/marktguru-search.json tests/marktguru.test.ts
git commit -m "feat: marktguru provider with key extraction and offer parsing"
```

- [ ] **Step 7: Manual live verification (network, one-off)**

Create `scripts/spike-marktguru.ts`:
```ts
import { createFetcher } from "../src/net/fetcher";
import { loadKeys, createMarktguruProvider } from "../src/providers/marktguru";

const f = createFetcher();
const keys = await loadKeys(f);
console.log("keys ok:", !!keys.apiKey, !!keys.clientKey);
const p = createMarktguruProvider({ fetcher: f, zipCode: 30459, keys });
const offers = await p.search("Kartoffeln");
console.log("offers:", offers.length, offers[0]);
await Bun.write("fixtures/marktguru-search.json", JSON.stringify({ results: [] }, null, 2)); // placeholder; see below
```

Run: `bun run scripts/spike-marktguru.ts`
Expected: prints non-zero offer count and a sample. **If the response wrapper key is not `results`**, inspect the printed object, update `parseOffers` accordingly, capture a real response into `fixtures/marktguru-search.json` (overwrite the synthetic one but keep the same field names the test asserts, or update the test to the real ids), and re-run `bun test tests/marktguru.test.ts`. Commit any fixup:

```bash
git add src/providers/marktguru.ts fixtures/marktguru-search.json tests/marktguru.test.ts
git commit -m "fix: align marktguru parser with live response shape"
```

---

### Task 6: LLM service (Anthropic wrapper, structured tool-use output)

**Files:**
- Create: `src/llm/llm.ts`
- Test: `tests/llm.test.ts`

**Interfaces:**
- Consumes: `Config` (anthropicApiKey, llmModel).
- Produces:
  ```ts
  import { z } from "zod";
  export interface Llm {
    structured<T>(args: {
      system?: string;
      prompt: string;
      toolName: string;
      description: string;
      schema: z.ZodType<T>;
    }): Promise<T>;
  }
  // client is injectable for tests (shape of Anthropic messages.create)
  export type LlmClient = { messages: { create: (req: unknown) => Promise<{ content: unknown[] }> } };
  export function createLlm(deps: { apiKey: string; model: string; client?: LlmClient }): Llm;
  ```
  Behavior: builds a single tool from the zod schema (via `zod-to-json-schema`), forces `tool_choice`, extracts the `tool_use` block's `input`, validates with the zod schema, retries once on validation failure.

- [ ] **Step 1: Write the failing test**

`tests/llm.test.ts`:
```ts
import { test, expect } from "bun:test";
import { z } from "zod";
import { createLlm, type LlmClient } from "../src/llm/llm";

function clientReturning(inputs: unknown[]): LlmClient {
  let i = 0;
  return {
    messages: {
      create: async () => ({ content: [{ type: "tool_use", name: "t", input: inputs[Math.min(i++, inputs.length - 1)] }] }),
    },
  };
}

test("structured returns validated tool input", async () => {
  const llm = createLlm({ apiKey: "x", model: "claude-haiku-4-5", client: clientReturning([{ terms: ["Schmand"] }]) });
  const out = await llm.structured({
    prompt: "translate сметана", toolName: "t", description: "d",
    schema: z.object({ terms: z.array(z.string()) }),
  });
  expect(out.terms).toEqual(["Schmand"]);
});

test("structured retries once on invalid output then succeeds", async () => {
  const llm = createLlm({
    apiKey: "x", model: "claude-haiku-4-5",
    client: clientReturning([{ wrong: true }, { terms: ["Dill"] }]),
  });
  const out = await llm.structured({
    prompt: "x", toolName: "t", description: "d",
    schema: z.object({ terms: z.array(z.string()) }),
  });
  expect(out.terms).toEqual(["Dill"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/llm.test.ts`
Expected: FAIL — cannot find module `../src/llm/llm`.

- [ ] **Step 3: Implement `src/llm/llm.ts`**

```ts
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export interface Llm {
  structured<T>(args: {
    system?: string;
    prompt: string;
    toolName: string;
    description: string;
    schema: z.ZodType<T>;
  }): Promise<T>;
}

export type LlmClient = {
  messages: { create: (req: unknown) => Promise<{ content: unknown[] }> };
};

export function createLlm(deps: { apiKey: string; model: string; client?: LlmClient }): Llm {
  const client: LlmClient = deps.client ?? (new Anthropic({ apiKey: deps.apiKey }) as unknown as LlmClient);

  async function once<T>(a: {
    system?: string; prompt: string; toolName: string; description: string; schema: z.ZodType<T>;
  }): Promise<T> {
    const inputSchema = zodToJsonSchema(a.schema, { target: "jsonSchema7" });
    const res = await client.messages.create({
      model: deps.model,
      max_tokens: 1024,
      system: a.system,
      tools: [{ name: a.toolName, description: a.description, input_schema: inputSchema }],
      tool_choice: { type: "tool", name: a.toolName },
      messages: [{ role: "user", content: a.prompt }],
    });
    const block = (res.content as Array<{ type: string; input?: unknown }>).find((b) => b.type === "tool_use");
    if (!block) throw new Error("llm: no tool_use block in response");
    return a.schema.parse(block.input);
  }

  return {
    async structured(a) {
      try {
        return await once(a);
      } catch {
        return await once(a); // one retry
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/llm.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/llm/llm.ts tests/llm.test.ts
git commit -m "feat: anthropic llm service with structured tool-use output"
```

---

### Task 7: Recipe store + LLM seed

**Files:**
- Create: `src/recipes/recipeStore.ts`, `src/recipes/seed.ts`
- Test: `tests/recipeStore.test.ts`

**Interfaces:**
- Consumes: `openDb` (Task 3), `Dish`/`Ingredient` (Task 2), `Llm` (Task 6).
- Produces:
  ```ts
  import { Database } from "bun:sqlite";
  import { z } from "zod";
  export function insertDish(db: Database, dish: Dish): number;   // returns dish id
  export function listDishes(db: Database): Dish[];                // includes ingredients
  export const DishSeedSchema: z.ZodType<{ dishes: Dish[] }>;      // for LLM seed validation
  export async function seedDishes(db: Database, llm: Llm, count: number): Promise<number>;
  ```

- [ ] **Step 1: Write the failing test**

`tests/recipeStore.test.ts`:
```ts
import { test, expect } from "bun:test";
import { openDb } from "../src/db/db";
import { insertDish, listDishes, DishSeedSchema } from "../src/recipes/recipeStore";
import type { Dish } from "../src/types";

const borscht: Dish = {
  nameRu: "Борщ", nameUa: "Борщ", nameDe: "Borschtsch", cuisine: "ua",
  tags: ["soup"], servings: 4,
  ingredients: [
    { canonical: "свёкла", qty: 2, unit: "шт" },
    { canonical: "капуста", qty: 0.3, unit: "кг" },
    { canonical: "сметана", qty: 1, unit: "уп" },
  ],
};

test("insertDish + listDishes roundtrip with ingredients", () => {
  const db = openDb(":memory:");
  const id = insertDish(db, borscht);
  expect(id).toBeGreaterThan(0);
  const all = listDishes(db);
  expect(all).toHaveLength(1);
  expect(all[0].nameRu).toBe("Борщ");
  expect(all[0].ingredients.map((i) => i.canonical)).toContain("сметана");
});

test("DishSeedSchema validates a well-formed LLM payload", () => {
  const parsed = DishSeedSchema.parse({ dishes: [borscht] });
  expect(parsed.dishes[0].ingredients).toHaveLength(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/recipeStore.test.ts`
Expected: FAIL — cannot find module `../src/recipes/recipeStore`.

- [ ] **Step 3: Implement `src/recipes/recipeStore.ts`**

```ts
import { Database } from "bun:sqlite";
import { z } from "zod";
import type { Dish } from "../types";
import type { Llm } from "../llm/llm";

const IngredientSchema = z.object({
  canonical: z.string().min(1),
  qty: z.number().nullable(),
  unit: z.string().nullable(),
});
const DishSchema = z.object({
  nameRu: z.string().min(1),
  nameUa: z.string().nullable(),
  nameDe: z.string().nullable(),
  cuisine: z.string().min(1),
  tags: z.array(z.string()),
  servings: z.number().int().positive(),
  ingredients: z.array(IngredientSchema).min(1),
});
export const DishSeedSchema: z.ZodType<{ dishes: Dish[] }> = z.object({
  dishes: z.array(DishSchema),
}) as unknown as z.ZodType<{ dishes: Dish[] }>;

export function insertDish(db: Database, dish: Dish): number {
  const info = db.query(
    `INSERT INTO dishes(name_ru,name_ua,name_de,cuisine,tags,servings)
     VALUES(?,?,?,?,?,?) RETURNING id`
  ).get(dish.nameRu, dish.nameUa, dish.nameDe, dish.cuisine, JSON.stringify(dish.tags), dish.servings) as { id: number };
  const ins = db.query(
    `INSERT INTO ingredients(dish_id,canonical_name,qty,unit) VALUES(?,?,?,?)`
  );
  for (const ing of dish.ingredients) ins.run(info.id, ing.canonical, ing.qty, ing.unit);
  return info.id;
}

export function listDishes(db: Database): Dish[] {
  const rows = db.query(`SELECT * FROM dishes ORDER BY id`).all() as Array<{
    id: number; name_ru: string; name_ua: string | null; name_de: string | null;
    cuisine: string; tags: string; servings: number;
  }>;
  const ingQ = db.query(`SELECT canonical_name, qty, unit FROM ingredients WHERE dish_id = ?`);
  return rows.map((r) => ({
    id: r.id, nameRu: r.name_ru, nameUa: r.name_ua, nameDe: r.name_de,
    cuisine: r.cuisine, tags: JSON.parse(r.tags), servings: r.servings,
    ingredients: (ingQ.all(r.id) as Array<{ canonical_name: string; qty: number | null; unit: string | null }>)
      .map((i) => ({ canonical: i.canonical_name, qty: i.qty, unit: i.unit })),
  }));
}

export async function seedDishes(db: Database, llm: Llm, count: number): Promise<number> {
  const out = await llm.structured({
    system: "You are a chef cataloguing Ukrainian and Russian home dishes makeable in Germany.",
    prompt: `Return ${count} popular Ukrainian/Russian dishes. For each: nameRu, nameUa, nameDe, cuisine ('ru'|'ua'), tags, servings, and ingredients with canonical Russian names, qty and unit. Use ingredients buyable in German supermarkets.`,
    toolName: "save_dishes",
    description: "Persist the generated dish catalogue",
    schema: DishSeedSchema,
  });
  let n = 0;
  for (const d of out.dishes) { insertDish(db, d); n++; }
  return n;
}
```

- [ ] **Step 4: Implement the seed script `src/recipes/seed.ts`**

```ts
import { loadConfig } from "../config";
import { openDb } from "../db/db";
import { createLlm } from "../llm/llm";
import { seedDishes } from "./recipeStore";

const cfg = loadConfig(Bun.env);
const db = openDb("annona.db");
const n = await seedDishes(db, createLlm({ apiKey: cfg.anthropicApiKey, model: cfg.llmModel }), 30);
console.log(`seeded ${n} dishes`);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/recipeStore.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/recipes/recipeStore.ts src/recipes/seed.ts tests/recipeStore.test.ts
git commit -m "feat: recipe store and llm dish seeding"
```

---

### Task 8: Matcher (ingredient → cheapest offer, with caches)

**Files:**
- Create: `src/matcher.ts`
- Test: `tests/matcher.test.ts`

**Interfaces:**
- Consumes: `Database` (Task 3), `Llm` (Task 6), `OfferProvider` (Task 5), `Offer`/`effectiveUnitPrice`/`dedupeOffers` (Task 2).
- Produces:
  ```ts
  export interface Matcher {
    searchTerms(canonical: string): Promise<string[]>;     // synonyms cache → LLM
    matchIngredient(canonical: string): Promise<Offer | null>; // cheapest, cached by week
  }
  export function createMatcher(deps: {
    db: Database; llm: Llm; provider: OfferProvider; week: string; // ISO week key injected
  }): Matcher;
  ```
  `searchTerms` reads/writes the `synonyms` table; `matchIngredient` reads/writes `match_cache` keyed by `(canonical, week)`.

- [ ] **Step 1: Write the failing test**

`tests/matcher.test.ts`:
```ts
import { test, expect } from "bun:test";
import { openDb } from "../src/db/db";
import { createMatcher } from "../src/matcher";
import type { Offer } from "../src/types";
import type { Llm } from "../src/llm/llm";
import type { OfferProvider } from "../src/providers/marktguru";

const offer = (over: Partial<Offer>): Offer => ({
  externalId: 1, store: "edeka", storeName: "Edeka", product: "Schmand",
  price: 1.49, oldPrice: null, referencePrice: 1.49, unit: "St",
  validFrom: "2026-06-22", validTo: "2026-06-28", ...over,
});

const llmStub = (terms: string[]): Llm => ({
  async structured() { return { terms } as never; },
});

test("searchTerms hits synonym cache without calling the LLM", async () => {
  const db = openDb(":memory:");
  db.run("INSERT INTO synonyms(canonical_name,search_terms_de,updated_at) VALUES(?,?,?)",
    ["сметана", JSON.stringify(["Schmand", "Saure Sahne"]), "2026-06-21"]);
  let called = false;
  const llm: Llm = { async structured() { called = true; return { terms: [] } as never; } };
  const provider: OfferProvider = { async search() { return []; } };
  const m = createMatcher({ db, llm, provider, week: "2026-W26" });
  expect(await m.searchTerms("сметана")).toEqual(["Schmand", "Saure Sahne"]);
  expect(called).toBe(false);
});

test("matchIngredient returns the cheapest offer across all terms", async () => {
  const db = openDb(":memory:");
  const provider: OfferProvider = {
    async search(q) {
      if (q === "Schmand") return [offer({ externalId: 1, referencePrice: 1.49, storeName: "Edeka" })];
      return [offer({ externalId: 2, referencePrice: 0.99, storeName: "Kaufland" })];
    },
  };
  const m = createMatcher({ db, llm: llmStub(["Schmand", "Saure Sahne"]), provider, week: "2026-W26" });
  const best = await m.matchIngredient("сметана");
  expect(best!.storeName).toBe("Kaufland");
  expect(best!.referencePrice).toBe(0.99);
  // second call served from match_cache (provider would throw if hit again)
  const m2 = createMatcher({
    db, llm: llmStub([]), week: "2026-W26",
    provider: { async search() { throw new Error("should be cached"); } },
  });
  const cached = await m2.matchIngredient("сметана");
  expect(cached!.storeName).toBe("Kaufland");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/matcher.test.ts`
Expected: FAIL — cannot find module `../src/matcher`.

- [ ] **Step 3: Implement `src/matcher.ts`**

```ts
import { Database } from "bun:sqlite";
import { z } from "zod";
import type { Llm } from "./llm/llm";
import type { OfferProvider } from "./providers/marktguru";
import type { Offer } from "./types";
import { dedupeOffers, effectiveUnitPrice } from "./normalize";

const TermsSchema = z.object({ terms: z.array(z.string()).min(1).max(6) });

export interface Matcher {
  searchTerms(canonical: string): Promise<string[]>;
  matchIngredient(canonical: string): Promise<Offer | null>;
}

export function createMatcher(deps: {
  db: Database; llm: Llm; provider: OfferProvider; week: string;
}): Matcher {
  const { db, llm, provider, week } = deps;

  async function searchTerms(canonical: string): Promise<string[]> {
    const row = db.query("SELECT search_terms_de FROM synonyms WHERE canonical_name = ?")
      .get(canonical) as { search_terms_de: string } | null;
    if (row) return JSON.parse(row.search_terms_de) as string[];
    const out = await llm.structured({
      system: "Translate a Russian/Ukrainian grocery ingredient into German supermarket search terms.",
      prompt: `Ingredient: "${canonical}". Return up to 4 German product search terms a shopper would use.`,
      toolName: "german_terms", description: "German search terms for the ingredient",
      schema: TermsSchema,
    });
    db.run("INSERT OR REPLACE INTO synonyms(canonical_name,search_terms_de,updated_at) VALUES(?,?,?)",
      [canonical, JSON.stringify(out.terms), week]);
    return out.terms;
  }

  async function matchIngredient(canonical: string): Promise<Offer | null> {
    const cached = db.query("SELECT offer_json FROM match_cache WHERE ingredient_canonical = ? AND week = ?")
      .get(canonical, week) as { offer_json: string | null } | null;
    if (cached) return cached.offer_json ? (JSON.parse(cached.offer_json) as Offer) : null;

    const terms = await searchTerms(canonical);
    const found: Offer[] = [];
    for (const t of terms) found.push(...(await provider.search(t)));
    const deduped = dedupeOffers(found);
    const best = deduped.length
      ? deduped.reduce((a, b) => (effectiveUnitPrice(b) < effectiveUnitPrice(a) ? b : a))
      : null;

    db.run("INSERT OR REPLACE INTO match_cache(ingredient_canonical,week,offer_json,created_at) VALUES(?,?,?,?)",
      [canonical, week, best ? JSON.stringify(best) : null, week]);
    return best;
  }

  return { searchTerms, matchIngredient };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/matcher.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/matcher.ts tests/matcher.test.ts
git commit -m "feat: ingredient matcher with synonym and weekly match caches"
```

---

### Task 9: Recommender (rank dishes + shopping list)

**Files:**
- Create: `src/recommender.ts`
- Test: `tests/recommender.test.ts`

**Interfaces:**
- Consumes: `Dish`/`Offer`/`RankedDish`/`ShoppingItem` (Task 2).
- Produces:
  ```ts
  export function rankDishes(dishes: Dish[], matches: Map<string, Offer | null>): RankedDish[];
  export function buildShoppingList(dish: Dish, matches: Map<string, Offer | null>): ShoppingItem[];
  ```
  `rankDishes`: `onOfferCount` = ingredients with a non-null match; `estTotal` = sum of matched `price`. Sort by `onOfferCount` desc, then `estTotal` asc. `buildShoppingList`: one `ShoppingItem` per matched ingredient (`store` = `storeName`).

- [ ] **Step 1: Write the failing test**

`tests/recommender.test.ts`:
```ts
import { test, expect } from "bun:test";
import { rankDishes, buildShoppingList } from "../src/recommender";
import type { Dish, Offer } from "../src/types";

const offer = (over: Partial<Offer>): Offer => ({
  externalId: 1, store: "edeka", storeName: "Edeka", product: "X",
  price: 1, oldPrice: null, referencePrice: 1, unit: "St",
  validFrom: "2026-06-22", validTo: "2026-06-28", ...over,
});
const dish = (nameRu: string, ings: string[]): Dish => ({
  nameRu, nameUa: null, nameDe: null, cuisine: "ru", tags: [], servings: 4,
  ingredients: ings.map((c) => ({ canonical: c, qty: 1, unit: "шт" })),
});

test("rankDishes orders by on-offer count then cost", () => {
  const matches = new Map<string, Offer | null>([
    ["сметана", offer({ price: 1, storeName: "Kaufland", product: "Schmand" })],
    ["картофель", offer({ price: 2, storeName: "Aldi", product: "Kartoffeln" })],
    ["укроп", null],
  ]);
  const ranked = rankDishes(
    [dish("Окрошка", ["укроп"]), dish("Пюре", ["сметана", "картофель"])],
    matches
  );
  expect(ranked[0].dish.nameRu).toBe("Пюре");
  expect(ranked[0].onOfferCount).toBe(2);
  expect(ranked[0].estTotal).toBe(3);
});

test("buildShoppingList lists matched ingredients with store", () => {
  const matches = new Map<string, Offer | null>([
    ["сметана", offer({ storeName: "Kaufland", product: "Schmand", price: 0.99 })],
    ["укроп", null],
  ]);
  const list = buildShoppingList(dish("X", ["сметана", "укроп"]), matches);
  expect(list).toHaveLength(1);
  expect(list[0]).toEqual({ ingredient: "сметана", store: "Kaufland", product: "Schmand", price: 0.99 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/recommender.test.ts`
Expected: FAIL — cannot find module `../src/recommender`.

- [ ] **Step 3: Implement `src/recommender.ts`**

```ts
import type { Dish, Offer, RankedDish, ShoppingItem } from "./types";

export function rankDishes(dishes: Dish[], matches: Map<string, Offer | null>): RankedDish[] {
  const ranked: RankedDish[] = dishes.map((dish) => {
    let onOfferCount = 0;
    let estTotal = 0;
    for (const ing of dish.ingredients) {
      const m = matches.get(ing.canonical);
      if (m) { onOfferCount++; estTotal += m.price; }
    }
    return { dish, onOfferCount, estTotal };
  });
  return ranked.sort((a, b) =>
    b.onOfferCount - a.onOfferCount || a.estTotal - b.estTotal
  );
}

export function buildShoppingList(dish: Dish, matches: Map<string, Offer | null>): ShoppingItem[] {
  const items: ShoppingItem[] = [];
  for (const ing of dish.ingredients) {
    const m = matches.get(ing.canonical);
    if (m) items.push({ ingredient: ing.canonical, store: m.storeName, product: m.product, price: m.price });
  }
  return items;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/recommender.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/recommender.ts tests/recommender.test.ts
git commit -m "feat: dish recommender and shopping list builder"
```

---

### Task 10: Bot handlers (whitelist + recommendation formatting)

**Files:**
- Create: `src/bot/handlers.ts`
- Test: `tests/handlers.test.ts`

**Interfaces:**
- Consumes: `Matcher` (Task 8), `rankDishes`/`buildShoppingList` (Task 9), `Dish` (Task 2).
- Produces:
  ```ts
  export function isAllowed(userId: number | undefined, allowed: number[]): boolean;
  export async function handleRecommend(deps: {
    dishes: Dish[]; matcher: Matcher; topN?: number;
  }): Promise<string>;   // Telegram-ready text
  ```
  `handleRecommend`: collects matches for every distinct ingredient via `matcher.matchIngredient`, ranks, and formats the top `topN` (default 3) dishes with their per-store shopping list.

- [ ] **Step 1: Write the failing test**

`tests/handlers.test.ts`:
```ts
import { test, expect } from "bun:test";
import { isAllowed, handleRecommend } from "../src/bot/handlers";
import type { Dish, Offer } from "../src/types";
import type { Matcher } from "../src/matcher";

test("isAllowed enforces the whitelist", () => {
  expect(isAllowed(111, [111, 222])).toBe(true);
  expect(isAllowed(999, [111, 222])).toBe(false);
  expect(isAllowed(undefined, [111])).toBe(false);
});

test("handleRecommend formats the cheapest dish with its shopping list", async () => {
  const offers: Record<string, Offer> = {
    "сметана": { externalId: 1, store: "kaufland", storeName: "Kaufland", product: "Schmand",
      price: 0.99, oldPrice: null, referencePrice: 0.99, unit: "St", validFrom: "", validTo: "" },
    "картофель": { externalId: 2, store: "aldi", storeName: "Aldi", product: "Kartoffeln 2,5kg",
      price: 1.99, oldPrice: null, referencePrice: 0.8, unit: "kg", validFrom: "", validTo: "" },
  };
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient(c) { return offers[c] ?? null; },
  };
  const dishes: Dish[] = [{
    nameRu: "Картофельное пюре", nameUa: null, nameDe: null, cuisine: "ru", tags: [], servings: 4,
    ingredients: [{ canonical: "картофель", qty: 1, unit: "кг" }, { canonical: "сметана", qty: 1, unit: "уп" }],
  }];
  const text = await handleRecommend({ dishes, matcher });
  expect(text).toContain("Картофельное пюре");
  expect(text).toContain("Kaufland");
  expect(text).toContain("Aldi");
  expect(text).toContain("Schmand");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/handlers.test.ts`
Expected: FAIL — cannot find module `../src/bot/handlers`.

- [ ] **Step 3: Implement `src/bot/handlers.ts`**

```ts
import type { Dish } from "../types";
import type { Matcher } from "../matcher";
import { rankDishes, buildShoppingList } from "../recommender";

export function isAllowed(userId: number | undefined, allowed: number[]): boolean {
  return userId !== undefined && allowed.includes(userId);
}

export async function handleRecommend(deps: {
  dishes: Dish[]; matcher: Matcher; topN?: number;
}): Promise<string> {
  const topN = deps.topN ?? 3;
  const canonicals = [...new Set(deps.dishes.flatMap((d) => d.ingredients.map((i) => i.canonical)))];
  const matches = new Map();
  for (const c of canonicals) matches.set(c, await deps.matcher.matchIngredient(c));

  const ranked = rankDishes(deps.dishes, matches).slice(0, topN);
  if (ranked.length === 0 || ranked[0].onOfferCount === 0) {
    return "На этой неделе выгодных совпадений по акциям не нашёл 😕";
  }

  const lines: string[] = ["🛒 Выгодно приготовить на этой неделе:\n"];
  for (const r of ranked) {
    lines.push(`🍲 *${r.dish.nameRu}* — ${r.onOfferCount} ингр. на акции, ~${r.estTotal.toFixed(2)}€`);
    for (const item of buildShoppingList(r.dish, matches)) {
      lines.push(`   • ${item.ingredient}: ${item.product} — ${item.price.toFixed(2)}€ (${item.store})`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/handlers.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bot/handlers.ts tests/handlers.test.ts
git commit -m "feat: bot handlers for whitelist and weekly recommendation"
```

---

### Task 11: Composition root + bot wiring + live smoke

**Files:**
- Create: `src/bot/bot.ts`, `src/main.ts`
- Create: `src/util/week.ts`
- Test: `tests/week.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `isoWeek(date: Date): string` (e.g. `"2026-W26"`); a `createBot(deps)` returning a configured grammY `Bot`; `main()` that wires config → db → fetcher → keys → provider → llm → matcher → dishes → bot and starts polling.

- [ ] **Step 1: Write the failing test for the week helper**

`tests/week.test.ts`:
```ts
import { test, expect } from "bun:test";
import { isoWeek } from "../src/util/week";

test("isoWeek formats ISO year-week", () => {
  expect(isoWeek(new Date("2026-06-21T12:00:00Z"))).toMatch(/^\d{4}-W\d{2}$/);
  expect(isoWeek(new Date("2026-01-01T12:00:00Z"))).toBe("2026-W01");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/week.test.ts`
Expected: FAIL — cannot find module `../src/util/week`.

- [ ] **Step 3: Implement `src/util/week.ts`**

```ts
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/week.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement `src/bot/bot.ts`**

```ts
import { Bot } from "grammy";
import type { Dish } from "../types";
import type { Matcher } from "../matcher";
import { isAllowed, handleRecommend } from "./handlers";

export function createBot(deps: {
  token: string; allowedUserIds: number[]; dishes: Dish[]; matcher: Matcher;
}): Bot {
  const bot = new Bot(deps.token);

  bot.use(async (ctx, next) => {
    if (!isAllowed(ctx.from?.id, deps.allowedUserIds)) return; // silently ignore strangers
    await next();
  });

  bot.command("start", (ctx) => ctx.reply("Привет! Напиши /digest или «что приготовить», и я подскажу выгодные блюда недели."));

  const recommend = async (ctx: { reply: (t: string, o?: unknown) => Promise<unknown> }) => {
    const text = await handleRecommend({ dishes: deps.dishes, matcher: deps.matcher });
    await ctx.reply(text, { parse_mode: "Markdown" });
  };

  bot.command("digest", recommend);
  bot.on("message:text", async (ctx) => {
    try { await recommend(ctx); }
    catch (e) { await ctx.reply("Упс, что-то пошло не так. Попробуй позже."); console.error(e); }
  });

  return bot;
}
```

- [ ] **Step 6: Implement `src/main.ts`**

```ts
import { loadConfig } from "./config";
import { openDb } from "./db/db";
import { createFetcher } from "./net/fetcher";
import { loadKeys, createMarktguruProvider } from "./providers/marktguru";
import { createLlm } from "./llm/llm";
import { createMatcher } from "./matcher";
import { listDishes } from "./recipes/recipeStore";
import { isoWeek } from "./util/week";
import { createBot } from "./bot/bot";

const cfg = loadConfig(Bun.env);
const db = openDb("annona.db");
const fetcher = createFetcher({ proxyMode: cfg.proxyMode });
const keys = await loadKeys(fetcher);
const provider = createMarktguruProvider({ fetcher, zipCode: cfg.locationPlz, keys });
const llm = createLlm({ apiKey: cfg.anthropicApiKey, model: cfg.llmModel });
const matcher = createMatcher({ db, llm, provider, week: isoWeek(new Date()) });
const dishes = listDishes(db);

if (dishes.length === 0) console.warn("No dishes yet — run `bun run seed` first.");

const bot = createBot({ token: cfg.telegramBotToken, allowedUserIds: cfg.allowedUserIds, dishes, matcher });
console.log("Annona bot starting…");
bot.start();
```

- [ ] **Step 7: Commit**

```bash
git add src/util/week.ts src/bot/bot.ts src/main.ts tests/week.test.ts
git commit -m "feat: week helper, grammy bot wiring, and composition root"
```

- [ ] **Step 8: Full suite + manual smoke**

```bash
bun test
```
Expected: ALL tests pass.

Then, with a real `.env` filled in:
```bash
bun run seed     # generates ~30 dishes via the LLM
bun run start    # starts the bot
```
From a **whitelisted** Telegram account, send `/digest`. Expected: a message listing the cheapest dishes to cook this week with a per-store shopping list. From a non-whitelisted account, the bot stays silent. Note any mismatch between matched products and intended ingredients — those feed the Phase 2 synonym-dictionary review.

---

## Self-Review

Checked against the spec (`docs/superpowers/specs/2026-06-21-annona-design.md`):

- **Spec coverage:** §5 components — Providers (T5), Fetcher/anti-ban/proxy-ready (T4), Normalizer (T2), Recipe store (T7), Matcher (T8), Recommender (T9), Telegram bot (T10–T11), LLM service (T6), Persistence (T3), Config (T1). §1 push+pull → Phase 1 ships the pull/`/digest` path; the weekly **push scheduler** is explicitly Phase 2 (spec §14), so it is intentionally absent here. **Pantry** is Phase 2 (spec §14) — intentionally absent. §8 caching → synonym + match caches (T8). §9 proxy modes → `none` live, `pool`/`service` guarded stubs (T4). §11 testing → unit/integration/E2E shapes present.
- **Placeholder scan:** no TBD/TODO. The one synthetic artifact — `fixtures/marktguru-search.json` — is explicitly flagged and replaced/confirmed against a live capture in T5 Step 7.
- **Type consistency:** `Offer`, `Dish`, `Ingredient`, `RankedDish`, `ShoppingItem` defined once (T2) and reused verbatim. `OfferProvider.search`, `Matcher.{searchTerms,matchIngredient}`, `Llm.structured`, `handleRecommend`, `rankDishes`/`buildShoppingList`, `isoWeek` signatures match across producing and consuming tasks. `effectiveUnitPrice` (T2) used by both T2 and T8.

## Risks called out for the implementer

- **marktguru is unofficial.** Keys are scraped from the homepage and the response wrapper key (`results`) is assumed; T5 Step 7 verifies both against live traffic before relying on it. If the homepage stops embedding keys, the provider throws a clear error and the bot alerts (Phase 2 wires alerts).
- **LLM output drift.** All LLM calls validate with zod and retry once; a second failure surfaces as an error rather than corrupt data.
- **`zod-to-json-schema` output:** for the simple object schemas here it yields a plain JSON-schema object Anthropic accepts. If a `$ref`/`definitions` wrapper appears, pass `{ $refStrategy: "none" }` to `zodToJsonSchema` in T6.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-21-annona-phase1.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
