# Annona Phase 2 — Layer 2 (Weekly Menu Planner) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the family pick dishes in free text, then lay out a 7-day menu (a first + second course per day, long-keeping dishes repeating) and produce one shopping list grouped by store with Apple Maps links.

**Architecture:** A new pure `src/planner.ts` lays out the week. A `selection` table + `src/recipes/selectionStore.ts` persist the chosen dish ids per ISO week. New LLM-backed `src/bot/intent.ts` (intent router) + `src/bot/resolve.ts` (dish-name → catalogue id) sit on the Phase-1 `Llm` service. A new `src/shoppingList.ts` aggregates ingredients into store-grouped offers. The bot's `message:text` routes through the intent router; `/digest`, `/menu`, `/list` are direct commands. Builds entirely on Layer 1 (whitelist matcher, `course`/`keepsDays`, `mapsLink`).

**Tech Stack:** Bun + TypeScript (strict), `bun:sqlite`, `bun:test`, zod `4.4.3` (native `z.toJSONSchema`), grammY `1.44.0`, `@anthropic-ai/sdk` `0.105.0` (Haiku via the Phase-1 `Llm.structured`).

## Global Constraints

- Runtime is Bun: `bun test`, `bun:sqlite`, no Node test runner, no `dotenv`.
- TypeScript strict; explicit types on exports; no `any`; no `console.log` in production (existing `console.warn`/`console.error` in bot/main may stay).
- All user-facing Telegram copy is Russian.
- Build on Layer 1 — do NOT change Layer 1 behavior. Reuse: `Matcher.matchIngredient` (already whitelist-filtered), `Dish.course`/`Dish.keepsDays`/`Dish.servings`, `canonicalStore`/`mapsLink`/`StoreKey` from `src/stores.ts`, `Llm.structured` from `src/llm/llm.ts`, `isoWeek` from `src/util/week.ts`, `listDishes` from `src/recipes/recipeStore.ts`.
- Config default (new): `MENU_DAYS=7`.
- New table: `selection(week TEXT PRIMARY KEY, dish_ids_json TEXT NOT NULL, updated_at TEXT NOT NULL)` — added as an idempotent `CREATE TABLE IF NOT EXISTS` in `MIGRATIONS`.
- Menu rule: each course is filled independently across `MENU_DAYS`; a dish occupies `max(1, keepsDays)` consecutive days, then the next selected dish of that course is used, cycling back to the first when the list is exhausted.
- Shopping list: aggregate the DISTINCT canonical ingredients of all menu dishes; match each to its cheapest whitelist offer (the matcher already filters); group by `canonicalStore(offer.store) ?? canonicalStore(offer.storeName)`; render one Apple Maps link per store; ingredients with no whitelist offer go under "Докупить (не в акции)".
- Dish course mapping for the planner: `course === "first"` → first-course slot; everything else (`"second"`, `null`, undefined) → second-course slot.

---

## File Structure

**New files**
- `src/planner.ts` — pure `fillCourse` + `planWeek`. (Task 2)
- `src/recipes/selectionStore.ts` — `saveSelection` / `getSelection`. (Task 1)
- `src/bot/intent.ts` — `classifyIntent` (LLM intent router). (Task 3)
- `src/bot/resolve.ts` — `resolveDishes` (LLM dish-name resolver). (Task 3)
- `src/shoppingList.ts` — `buildGroupedList`. (Task 4)
- Tests: `tests/selectionStore.test.ts`, `tests/planner.test.ts`, `tests/intent.test.ts`, `tests/resolve.test.ts`, `tests/shoppingList.test.ts`.

**Modified files**
- `src/types.ts` — add `WeeklyMenu`/`MenuDay`, `Intent`/`IntentKind`, `GroupedShoppingList`/`StoreGroup`. (Tasks 1–4, each adds its own types)
- `src/db/migrations.ts` — append the `selection` table. (Task 1)
- `src/config.ts` + `tests/config.test.ts` — `MENU_DAYS`. (Task 1)
- `src/bot/handlers.ts` — add `handleSelect`/`handleMenu`/`handleList` + a `helpText`. (Task 5)
- `src/bot/bot.ts` — route `message:text` through the intent router; add `/menu` `/list` commands. (Task 5)
- `src/main.ts` — pass `db`, `llm`, `plz`, `menuDays` into `createBot`. (Task 5)
- `tests/handlers.test.ts` — tests for the three new handlers. (Task 5)

---

### Task 1: Selection persistence + MENU_DAYS config

**Files:**
- Create: `src/recipes/selectionStore.ts`, `tests/selectionStore.test.ts`
- Modify: `src/db/migrations.ts`, `src/config.ts`, `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `saveSelection(db, week, dishIds: number[]): void`; `getSelection(db, week): number[] | null`; `Config.menuDays: number`; `selection` table.

- [ ] **Step 1: Write the failing selection-store test**

Create `tests/selectionStore.test.ts`:

```ts
import { test, expect } from "bun:test";
import { openDb } from "../src/db/db";
import { saveSelection, getSelection } from "../src/recipes/selectionStore";

test("saveSelection + getSelection round-trips dish ids for a week", () => {
  const db = openDb(":memory:");
  saveSelection(db, "2026-W26", [3, 7, 12]);
  expect(getSelection(db, "2026-W26")).toEqual([3, 7, 12]);
});

test("getSelection returns null for an unknown week", () => {
  const db = openDb(":memory:");
  expect(getSelection(db, "2026-W26")).toBeNull();
});

test("saveSelection overwrites the same week", () => {
  const db = openDb(":memory:");
  saveSelection(db, "2026-W26", [1, 2]);
  saveSelection(db, "2026-W26", [9]);
  expect(getSelection(db, "2026-W26")).toEqual([9]);
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `bun test tests/selectionStore.test.ts`
Expected: FAIL — module not found / no `selection` table.

- [ ] **Step 3: Add the migration + the store**

In `src/db/migrations.ts`, append one entry to the `MIGRATIONS` array (after the `meta` table entry):

```ts
  `CREATE TABLE IF NOT EXISTS selection (
     week TEXT PRIMARY KEY,
     dish_ids_json TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
```

Create `src/recipes/selectionStore.ts`:

```ts
import type { Database } from "bun:sqlite";

/** Persist the chosen dish ids for an ISO week (overwrites any existing row). */
export function saveSelection(db: Database, week: string, dishIds: number[]): void {
  db.run(
    "INSERT OR REPLACE INTO selection(week, dish_ids_json, updated_at) VALUES(?, ?, ?)",
    [week, JSON.stringify(dishIds), new Date().toISOString()]
  );
}

/** Return the chosen dish ids for an ISO week, or null if none saved. */
export function getSelection(db: Database, week: string): number[] | null {
  const row = db
    .query("SELECT dish_ids_json FROM selection WHERE week = ?")
    .get(week) as { dish_ids_json: string } | null;
  return row ? (JSON.parse(row.dish_ids_json) as number[]) : null;
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `bun test tests/selectionStore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing config test**

Append to `tests/config.test.ts`:

```ts
test("applies MENU_DAYS default and parses a custom value", () => {
  expect(loadConfig(base).menuDays).toBe(7);
  expect(loadConfig({ ...base, MENU_DAYS: "5" }).menuDays).toBe(5);
});
```

- [ ] **Step 6: Run it — expect FAIL**

Run: `bun test tests/config.test.ts`
Expected: FAIL — `menuDays` undefined.

- [ ] **Step 7: Add MENU_DAYS to config**

In `src/config.ts`, add to the `schema` object (next to `DIGEST_LIMIT`):

```ts
  MENU_DAYS: z.coerce.number().int().positive().default(7),
```

Add to the `Config` type:

```ts
  menuDays: number;
```

Add to the `loadConfig` return object:

```ts
    menuDays: p.MENU_DAYS,
```

- [ ] **Step 8: Run both suites — expect PASS**

Run: `bun test tests/config.test.ts tests/selectionStore.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/db/migrations.ts src/recipes/selectionStore.ts tests/selectionStore.test.ts src/config.ts tests/config.test.ts
git commit -m "feat: selection table + store and MENU_DAYS config"
```

---

### Task 2: Menu planner (pure)

**Files:**
- Create: `src/planner.ts`, `tests/planner.test.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Consumes: `Dish` (`keepsDays?`).
- Produces: `MenuDay = { day: number; first: Dish | null; second: Dish | null }`; `WeeklyMenu = { days: MenuDay[] }`; `fillCourse(dishes: Dish[], days: number): (Dish | null)[]`; `planWeek(firsts: Dish[], seconds: Dish[], days: number): WeeklyMenu`.

- [ ] **Step 1: Write the failing test**

Create `tests/planner.test.ts`:

```ts
import { test, expect } from "bun:test";
import { fillCourse, planWeek } from "../src/planner";
import type { Dish } from "../src/types";

const dish = (nameRu: string, keepsDays: number, course: "first" | "second"): Dish => ({
  nameRu, nameUa: null, nameDe: null, cuisine: "ru", course, keepsDays,
  tags: [], servings: 4, ingredients: [{ canonical: "x", qty: 1, unit: "шт" }],
});

test("fillCourse repeats a dish for keepsDays then advances, cycling to fill the week", () => {
  const f = fillCourse([dish("Борщ", 4, "first"), dish("Гречка", 1, "first")], 7);
  expect(f.map((d) => d!.nameRu)).toEqual([
    "Борщ", "Борщ", "Борщ", "Борщ", "Гречка", "Борщ", "Борщ",
  ]);
});

test("fillCourse with an empty list yields all null", () => {
  expect(fillCourse([], 7)).toEqual([null, null, null, null, null, null, null]);
});

test("fillCourse with a single dish fills every day", () => {
  const f = fillCourse([dish("Плов", 3, "second")], 7);
  expect(f.every((d) => d!.nameRu === "Плов")).toBe(true);
  expect(f).toHaveLength(7);
});

test("planWeek lays out first and second courses independently", () => {
  const menu = planWeek(
    [dish("Борщ", 4, "first")],
    [dish("Карбонара", 2, "second")],
    7
  );
  expect(menu.days).toHaveLength(7);
  expect(menu.days[0]!.day).toBe(1);
  expect(menu.days[0]!.first!.nameRu).toBe("Борщ");
  expect(menu.days[0]!.second!.nameRu).toBe("Карбонара");
});

test("planWeek leaves a slot null when that course has no dishes", () => {
  const menu = planWeek([dish("Борщ", 2, "first")], [], 7);
  expect(menu.days.every((d) => d.first !== null)).toBe(true);
  expect(menu.days.every((d) => d.second === null)).toBe(true);
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `bun test tests/planner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the types**

In `src/types.ts`, append:

```ts
export type MenuDay = { day: number; first: Dish | null; second: Dish | null };
export type WeeklyMenu = { days: MenuDay[] };
```

- [ ] **Step 4: Implement the planner**

Create `src/planner.ts`:

```ts
import type { Dish, WeeklyMenu, MenuDay } from "./types";

/**
 * Fill `days` slots from `dishes`: each dish occupies max(1, keepsDays) consecutive
 * days before the next is used; cycle back to the first when the list is exhausted.
 * An empty list yields all-null.
 */
export function fillCourse(dishes: Dish[], days: number): (Dish | null)[] {
  if (dishes.length === 0) return Array.from({ length: days }, () => null);
  const out: (Dish | null)[] = [];
  let i = 0;
  let used = 0;
  while (out.length < days) {
    const dish = dishes[i % dishes.length]!;
    out.push(dish);
    used++;
    if (used >= Math.max(1, dish.keepsDays ?? 1)) {
      i++;
      used = 0;
    }
  }
  return out;
}

/** Lay out a `days`-day menu with a first and a second course each day. */
export function planWeek(firsts: Dish[], seconds: Dish[], days: number): WeeklyMenu {
  const f = fillCourse(firsts, days);
  const s = fillCourse(seconds, days);
  const out: MenuDay[] = [];
  for (let k = 0; k < days; k++) {
    out.push({ day: k + 1, first: f[k] ?? null, second: s[k] ?? null });
  }
  return { days: out };
}
```

- [ ] **Step 5: Run it — expect PASS**

Run: `bun test tests/planner.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/planner.ts tests/planner.test.ts src/types.ts
git commit -m "feat: pure weekly menu planner (keepsDays-driven, cycling)"
```

---

### Task 3: Intent router + dish resolver (LLM-backed)

**Files:**
- Create: `src/bot/intent.ts`, `src/bot/resolve.ts`, `tests/intent.test.ts`, `tests/resolve.test.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Consumes: `Llm` (`src/llm/llm.ts`), `Dish`.
- Produces:
  - `IntentKind = "suggest" | "select_dishes" | "show_menu" | "show_list" | "help"`; `Intent = { kind: IntentKind; dishNames: string[] }`.
  - `classifyIntent(llm: Llm, text: string): Promise<Intent>`.
  - `ResolveResult = { matched: Dish[]; unmatched: string[] }`; `resolveDishes(llm: Llm, catalogue: Dish[], names: string[]): Promise<ResolveResult>`.

- [ ] **Step 1: Write the failing intent test**

Create `tests/intent.test.ts`:

```ts
import { test, expect } from "bun:test";
import { classifyIntent } from "../src/bot/intent";
import type { Llm } from "../src/llm/llm";

const stub = (out: unknown): Llm => ({ async structured() { return out as never; } });

test("classifyIntent returns the LLM-classified intent", async () => {
  const llm = stub({ kind: "select_dishes", dishNames: ["борщ", "карбонара"] });
  const intent = await classifyIntent(llm, "хочу борщ и карбонару");
  expect(intent.kind).toBe("select_dishes");
  expect(intent.dishNames).toEqual(["борщ", "карбонара"]);
});

test("classifyIntent passes the user message into the prompt", async () => {
  let seenPrompt = "";
  const llm: Llm = {
    async structured(a) { seenPrompt = a.prompt; return { kind: "help", dishNames: [] } as never; },
  };
  await classifyIntent(llm, "что приготовить?");
  expect(seenPrompt).toContain("что приготовить?");
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `bun test tests/intent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the Intent types**

In `src/types.ts`, append:

```ts
export type IntentKind = "suggest" | "select_dishes" | "show_menu" | "show_list" | "help";
export type Intent = { kind: IntentKind; dishNames: string[] };
```

- [ ] **Step 4: Implement the intent router**

Create `src/bot/intent.ts`:

```ts
import { z } from "zod";
import type { Llm } from "../llm/llm";
import type { Intent } from "../types";

const IntentSchema = z.object({
  kind: z.enum(["suggest", "select_dishes", "show_menu", "show_list", "help"]),
  dishNames: z.array(z.string()),
});

/** Route a Russian/Ukrainian free-text message to a bot intent (LLM-backed). */
export async function classifyIntent(llm: Llm, text: string): Promise<Intent> {
  return llm.structured({
    system:
      "You route a Russian/Ukrainian grocery-bot message to ONE intent. " +
      "'suggest' = the user asks what is worth cooking / what is on offer this week. " +
      "'select_dishes' = the user lists dishes they want to cook this week — extract those dish names into dishNames. " +
      "'show_menu' = show the planned weekly menu. 'show_list' = show the shopping list. " +
      "'help' = anything unclear or a greeting. dishNames MUST be [] unless kind is 'select_dishes'.",
    prompt: `Message: "${text}"`,
    toolName: "route_intent",
    description: "Classify the message intent",
    schema: IntentSchema,
  });
}
```

- [ ] **Step 5: Run it — expect PASS**

Run: `bun test tests/intent.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Write the failing resolver test**

Create `tests/resolve.test.ts`:

```ts
import { test, expect } from "bun:test";
import { resolveDishes } from "../src/bot/resolve";
import type { Llm } from "../src/llm/llm";
import type { Dish } from "../src/types";

const cat: Dish[] = [
  { id: 1, nameRu: "Борщ", nameUa: "Борщ", nameDe: null, cuisine: "ua", course: "first", keepsDays: 4, tags: [], servings: 4, ingredients: [{ canonical: "свёкла", qty: 1, unit: "кг" }] },
  { id: 2, nameRu: "Карбонара", nameUa: null, nameDe: null, cuisine: "it", course: "second", keepsDays: 1, tags: [], servings: 2, ingredients: [{ canonical: "паста", qty: 0.5, unit: "кг" }] },
];

test("resolveDishes maps returned ids to catalogue dishes and passes unmatched through", async () => {
  const llm: Llm = { async structured() { return { matchedIds: [1, 2], unmatched: ["пельмени"] } as never; } };
  const r = await resolveDishes(llm, cat, ["борщ", "карбонара", "пельмени"]);
  expect(r.matched.map((d) => d.nameRu)).toEqual(["Борщ", "Карбонара"]);
  expect(r.unmatched).toEqual(["пельмени"]);
});

test("resolveDishes drops ids that are not in the catalogue", async () => {
  const llm: Llm = { async structured() { return { matchedIds: [1, 999], unmatched: [] } as never; } };
  const r = await resolveDishes(llm, cat, ["борщ"]);
  expect(r.matched.map((d) => d.id)).toEqual([1]);
});

test("resolveDishes short-circuits with no LLM call when names is empty", async () => {
  let called = false;
  const llm: Llm = { async structured() { called = true; return {} as never; } };
  const r = await resolveDishes(llm, cat, []);
  expect(called).toBe(false);
  expect(r).toEqual({ matched: [], unmatched: [] });
});
```

- [ ] **Step 7: Run it — expect FAIL**

Run: `bun test tests/resolve.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 8: Implement the resolver**

Create `src/bot/resolve.ts`:

```ts
import { z } from "zod";
import type { Llm } from "../llm/llm";
import type { Dish } from "../types";

const ResolveSchema = z.object({
  matchedIds: z.array(z.number().int()),
  unmatched: z.array(z.string()),
});

export type ResolveResult = { matched: Dish[]; unmatched: string[] };

/** Map free-text dish names to catalogue dish ids via the LLM (RU/UA, course-aware). */
export async function resolveDishes(
  llm: Llm,
  catalogue: Dish[],
  names: string[]
): Promise<ResolveResult> {
  if (names.length === 0) return { matched: [], unmatched: [] };

  const withId = catalogue.filter((d) => d.id !== undefined);
  const list = withId
    .map((d) => `${d.id}: ${d.nameRu}${d.nameUa ? ` / ${d.nameUa}` : ""} (${d.course ?? "?"})`)
    .join("\n");

  const out = await llm.structured({
    system:
      "Match each user dish name to the closest dish id from the catalogue (handle RU/UA spelling " +
      "and synonyms). Put any user name with no good catalogue match into 'unmatched'.",
    prompt: `Catalogue (id: name (course)):\n${list}\n\nUser dishes: ${names.join(", ")}`,
    toolName: "resolve_dishes",
    description: "Resolve user dish names to catalogue ids",
    schema: ResolveSchema,
    maxTokens: 1024,
  });

  const byId = new Map(withId.map((d) => [d.id as number, d]));
  const matched = out.matchedIds
    .map((id) => byId.get(id))
    .filter((d): d is Dish => d !== undefined);
  return { matched, unmatched: out.unmatched };
}
```

- [ ] **Step 9: Run it — expect PASS**

Run: `bun test tests/resolve.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 10: Commit**

```bash
git add src/bot/intent.ts src/bot/resolve.ts tests/intent.test.ts tests/resolve.test.ts src/types.ts
git commit -m "feat: LLM intent router + dish-name resolver"
```

---

### Task 4: Grouped shopping list

**Files:**
- Create: `src/shoppingList.ts`, `tests/shoppingList.test.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Consumes: `Matcher.matchIngredient` (already whitelist-filtered), `canonicalStore`/`mapsLink`/`StoreKey`, `Dish`, `Offer`.
- Produces: `StoreGroup = { store: StoreKey; storeName: string; mapsUrl: string; items: { ingredient: string; product: string; price: number }[] }`; `GroupedShoppingList = { groups: StoreGroup[]; missing: string[] }`; `buildGroupedList(dishes: Dish[], matcher: Matcher, plz: number): Promise<GroupedShoppingList>`.

- [ ] **Step 1: Write the failing test**

Create `tests/shoppingList.test.ts`:

```ts
import { test, expect } from "bun:test";
import { buildGroupedList } from "../src/shoppingList";
import type { Dish, Offer } from "../src/types";
import type { Matcher } from "../src/matcher";

const offer = (over: Partial<Offer>): Offer => ({
  externalId: 1, store: "aldi", storeName: "Aldi", product: "X", price: 1,
  oldPrice: null, referencePrice: null, unit: "St", validFrom: "", validTo: "", ...over,
});

const dish = (ings: string[]): Dish => ({
  nameRu: "D", nameUa: null, nameDe: null, cuisine: "ru", course: "second", keepsDays: 1,
  tags: [], servings: 4, ingredients: ings.map((c) => ({ canonical: c, qty: 1, unit: "шт" })),
});

test("buildGroupedList groups matched ingredients by store with a maps link", async () => {
  const offers: Record<string, Offer> = {
    "картофель": offer({ store: "aldi-nord", storeName: "Aldi Nord", product: "Kartoffeln", price: 1.99 }),
    "сметана": offer({ store: "kaufland", storeName: "Kaufland", product: "Schmand", price: 0.99 }),
    "лук": offer({ store: "aldi", storeName: "Aldi", product: "Zwiebeln", price: 0.5 }),
  };
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient(c) { return offers[c] ?? null; },
  };
  const list = await buildGroupedList([dish(["картофель", "сметана", "лук"])], matcher, 30459);
  const aldi = list.groups.find((g) => g.store === "aldi");
  const kauf = list.groups.find((g) => g.store === "kaufland");
  expect(aldi!.items.map((i) => i.ingredient).sort()).toEqual(["картофель", "лук"]);
  expect(kauf!.items.map((i) => i.ingredient)).toEqual(["сметана"]);
  expect(aldi!.mapsUrl).toBe("https://maps.apple.com/?q=Aldi%2030459");
  expect(list.missing).toEqual([]);
});

test("buildGroupedList puts ingredients with no offer under missing", async () => {
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient(c) { return c === "лук" ? offer({ store: "aldi", storeName: "Aldi" }) : null; },
  };
  const list = await buildGroupedList([dish(["лук", "укроп"])], matcher, 30459);
  expect(list.missing).toEqual(["укроп"]);
  expect(list.groups.flatMap((g) => g.items.map((i) => i.ingredient))).toEqual(["лук"]);
});

test("buildGroupedList deduplicates ingredients shared across dishes", async () => {
  let calls = 0;
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient() { calls++; return offer({ store: "aldi", storeName: "Aldi" }); },
  };
  await buildGroupedList([dish(["лук"]), dish(["лук"])], matcher, 30459);
  expect(calls).toBe(1); // "лук" matched once, not twice
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `bun test tests/shoppingList.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the types**

In `src/types.ts`, add the import at the TOP of the file:

```ts
import type { StoreKey } from "./stores";
```

Then append:

```ts
export type StoreGroup = {
  store: StoreKey;
  storeName: string;
  mapsUrl: string;
  items: { ingredient: string; product: string; price: number }[];
};
export type GroupedShoppingList = { groups: StoreGroup[]; missing: string[] };
```

- [ ] **Step 4: Implement the builder**

Create `src/shoppingList.ts`:

```ts
import type { Dish, GroupedShoppingList, StoreGroup } from "./types";
import type { Matcher } from "./matcher";
import { canonicalStore, mapsLink, type StoreKey } from "./stores";

/**
 * Aggregate the DISTINCT canonical ingredients of all dishes, match each to its
 * cheapest whitelist offer, and group by store with an Apple Maps link. Ingredients
 * with no whitelist offer go under `missing`.
 */
export async function buildGroupedList(
  dishes: Dish[],
  matcher: Matcher,
  plz: number
): Promise<GroupedShoppingList> {
  const canonicals = [
    ...new Set(dishes.flatMap((d) => d.ingredients.map((i) => i.canonical))),
  ];
  const groups = new Map<StoreKey, StoreGroup>();
  const missing: string[] = [];

  for (const c of canonicals) {
    const offer = await matcher.matchIngredient(c);
    const key = offer ? (canonicalStore(offer.store) ?? canonicalStore(offer.storeName)) : null;
    if (!offer || key === null) {
      missing.push(c);
      continue;
    }
    let group = groups.get(key);
    if (!group) {
      group = { store: key, storeName: offer.storeName, mapsUrl: mapsLink(key, plz), items: [] };
      groups.set(key, group);
    }
    group.items.push({ ingredient: c, product: offer.product, price: offer.price });
  }

  return { groups: [...groups.values()], missing };
}
```

- [ ] **Step 5: Run it — expect PASS**

Run: `bun test tests/shoppingList.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/shoppingList.ts tests/shoppingList.test.ts src/types.ts
git commit -m "feat: store-grouped shopping list with maps links"
```

---

### Task 5: Bot wiring — select / menu / list handlers + intent routing

**Files:**
- Modify: `src/bot/handlers.ts`, `src/bot/bot.ts`, `src/main.ts`, `tests/handlers.test.ts`

**Interfaces:**
- Consumes: `classifyIntent` (Task 3), `resolveDishes` (Task 3), `planWeek` (Task 2), `buildGroupedList` (Task 4), `saveSelection`/`getSelection` (Task 1), `isoWeek`, `Matcher`, `Llm`, `Config.menuDays`/`locationPlz`.
- Produces: `handleSelect`, `handleMenu`, `handleList`, `helpText` in `handlers.ts`; bot routes free text through `classifyIntent`; `/menu` `/list` commands; `createBot` accepts `db`, `llm`, `plz`, `menuDays`.

- [ ] **Step 1: Write the failing handler tests**

Append to `tests/handlers.test.ts` (add imports at the top: `import { handleSelect, handleMenu, handleList } from "../src/bot/handlers";`, `import { openDb } from "../src/db/db";`, `import { insertDish } from "../src/recipes/recipeStore";`, `import { saveSelection } from "../src/recipes/selectionStore";`, `import type { Llm } from "../src/llm/llm";`):

```ts
const borsch: Dish = { nameRu: "Борщ", nameUa: null, nameDe: null, cuisine: "ua", course: "first", keepsDays: 4, tags: [], servings: 4, ingredients: [{ canonical: "свёкла", qty: 1, unit: "кг" }] };
const plov: Dish = { nameRu: "Плов", nameUa: null, nameDe: null, cuisine: "ru", course: "second", keepsDays: 3, tags: [], servings: 4, ingredients: [{ canonical: "рис", qty: 1, unit: "кг" }] };

test("handleSelect resolves names, saves the selection, and confirms", async () => {
  const db = openDb(":memory:");
  const id1 = insertDish(db, borsch);
  const id2 = insertDish(db, plov);
  const dishes = [{ ...borsch, id: id1 }, { ...plov, id: id2 }];
  const llm: Llm = { async structured() { return { matchedIds: [id1, id2], unmatched: ["суши"] } as never; } };
  const text = await handleSelect({ llm, db, dishes, week: "2026-W26" }, ["борщ", "плов", "суши"]);
  expect(text).toContain("Борщ");
  expect(text).toContain("Плов");
  expect(text).toContain("суши"); // reported as not found
});

test("handleMenu renders a 7-day menu from the saved selection", () => {
  const db = openDb(":memory:");
  const id1 = insertDish(db, borsch);
  const id2 = insertDish(db, plov);
  const dishes = [{ ...borsch, id: id1 }, { ...plov, id: id2 }];
  saveSelection(db, "2026-W26", [id1, id2]);
  const text = handleMenu({ db, dishes, week: "2026-W26", menuDays: 7 });
  expect(text).toContain("Борщ"); // first course
  expect(text).toContain("Плов"); // second course
});

test("handleMenu asks for a selection when none is saved", () => {
  const db = openDb(":memory:");
  const text = handleMenu({ db, dishes: [], week: "2026-W26", menuDays: 7 });
  expect(text).toContain("выбери блюда");
});

test("handleList groups the selection's ingredients by store", async () => {
  const db = openDb(":memory:");
  const id1 = insertDish(db, borsch);
  const dishes = [{ ...borsch, id: id1 }];
  saveSelection(db, "2026-W26", [id1]);
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient() {
      return { externalId: 1, store: "aldi", storeName: "Aldi", product: "Rote Bete", price: 0.99, oldPrice: null, referencePrice: null, unit: "kg", validFrom: "", validTo: "" };
    },
  };
  const text = await handleList({ db, dishes, matcher, week: "2026-W26", plz: 30459 });
  expect(text).toContain("Aldi");
  expect(text).toContain("maps.apple.com");
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `bun test tests/handlers.test.ts`
Expected: FAIL — `handleSelect`/`handleMenu`/`handleList` not exported.

- [ ] **Step 3: Add the handlers**

In `src/bot/handlers.ts`, add imports at the top:

```ts
import type { Database } from "bun:sqlite";
import type { Llm } from "../llm/llm";
import { resolveDishes } from "./resolve";
import { planWeek } from "../planner";
import { buildGroupedList } from "../shoppingList";
import { saveSelection, getSelection } from "../recipes/selectionStore";
```

Append these to `src/bot/handlers.ts` (keep `isAllowed` and `handleRecommend` unchanged):

```ts
const NO_SELECTION = "Сначала выбери блюда: напиши их через запятую, например «борщ, карбонара, плов».";

export function helpText(): string {
  return [
    "Я подскажу, что выгодно готовить на этой неделе и где дешевле купить.",
    "",
    "• Напиши блюда через запятую (например «борщ, карбонара, плов») — соберу меню.",
    "• /digest — что выгодно приготовить.",
    "• /menu — меню на неделю.",
    "• /list — список покупок по магазинам.",
  ].join("\n");
}

/** Resolve free-text dish names to catalogue ids, persist them for the week, confirm. */
export async function handleSelect(
  deps: { llm: Llm; db: Database; dishes: Dish[]; week: string },
  dishNames: string[]
): Promise<string> {
  const { matched, unmatched } = await resolveDishes(deps.llm, deps.dishes, dishNames);
  if (matched.length === 0) {
    return "Не понял, какие блюда добавить. " + NO_SELECTION;
  }
  saveSelection(deps.db, deps.week, matched.map((d) => d.id as number));
  const names = matched.map((d) => d.nameRu).join(", ");
  let msg = `Записал на эту неделю: ${names}.`;
  if (unmatched.length) msg += `\nНе нашёл: ${unmatched.join(", ")}.`;
  msg += "\n\n/menu — меню на неделю · /list — список покупок.";
  return msg;
}

/** Render the weekly menu from the saved selection. */
export function handleMenu(deps: {
  db: Database;
  dishes: Dish[];
  week: string;
  menuDays: number;
}): string {
  const ids = getSelection(deps.db, deps.week);
  if (!ids || ids.length === 0) return NO_SELECTION;

  const byId = new Map(deps.dishes.filter((d) => d.id !== undefined).map((d) => [d.id as number, d]));
  const chosen = ids.map((id) => byId.get(id)).filter((d): d is Dish => d !== undefined);
  const firsts = chosen.filter((d) => d.course === "first");
  const seconds = chosen.filter((d) => d.course !== "first");
  const menu = planWeek(firsts, seconds, deps.menuDays);

  const labels = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  const lines = ["📅 Меню на неделю:\n"];
  for (const d of menu.days) {
    const label = labels[(d.day - 1) % 7] ?? `День ${d.day}`;
    const first = d.first ? d.first.nameRu : "—";
    const second = d.second ? d.second.nameRu : "—";
    lines.push(`*${label}*: 🥣 ${first} · 🍽 ${second}`);
  }
  return lines.join("\n");
}

/** Render the store-grouped shopping list for the saved selection. */
export async function handleList(deps: {
  db: Database;
  dishes: Dish[];
  matcher: Matcher;
  week: string;
  plz: number;
}): Promise<string> {
  const ids = getSelection(deps.db, deps.week);
  if (!ids || ids.length === 0) return NO_SELECTION;

  const byId = new Map(deps.dishes.filter((d) => d.id !== undefined).map((d) => [d.id as number, d]));
  const chosen = ids.map((id) => byId.get(id)).filter((d): d is Dish => d !== undefined);
  const { groups, missing } = await buildGroupedList(chosen, deps.matcher, deps.plz);

  if (groups.length === 0 && missing.length === 0) return "Список пуст.";

  const lines = ["🛒 Список покупок:"];
  for (const g of groups) {
    lines.push(`\n*${g.storeName}* — [на карте](${g.mapsUrl})`);
    for (const it of g.items) {
      lines.push(`• ${it.ingredient}: ${it.product} — ${it.price.toFixed(2)}€`);
    }
  }
  if (missing.length) lines.push(`\n*Докупить (не в акции):* ${missing.join(", ")}`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the handler tests — expect PASS**

Run: `bun test tests/handlers.test.ts`
Expected: PASS (existing handler tests + 4 new).

- [ ] **Step 5: Wire the bot**

Replace `src/bot/bot.ts` with (this routes free text through the intent router and adds `/menu` `/list`; it keeps the whitelist middleware and `/digest`):

```ts
import { Bot, type Context } from "grammy";
import { Database } from "bun:sqlite";
import type { Dish } from "../types";
import type { Matcher } from "../matcher";
import type { Llm } from "../llm/llm";
import { isAllowed, handleRecommend, handleSelect, handleMenu, handleList, helpText } from "./handlers";
import { classifyIntent } from "./intent";
import { isoWeek } from "../util/week";

export function createBot(deps: {
  token: string;
  allowedUserIds: number[];
  dishes: Dish[];
  matcher: Matcher;
  llm: Llm;
  db: Database;
  plz: number;
  menuDays: number;
  coverageMin?: number;
  digestLimit?: number;
}): Bot {
  const bot = new Bot(deps.token);

  bot.use(async (ctx, next) => {
    if (!isAllowed(ctx.from?.id, deps.allowedUserIds)) {
      console.warn("Ignored message from non-whitelisted user id:", ctx.from?.id);
      return;
    }
    await next();
  });

  const reply = async (ctx: Context, text: string) => {
    await ctx.reply(text, { parse_mode: "Markdown" });
  };

  const suggest = (ctx: Context) =>
    handleRecommend({
      dishes: deps.dishes,
      matcher: deps.matcher,
      coverageMin: deps.coverageMin,
      limit: deps.digestLimit,
    }).then((t) => reply(ctx, t));

  const menu = (ctx: Context) =>
    reply(ctx, handleMenu({ db: deps.db, dishes: deps.dishes, week: isoWeek(new Date()), menuDays: deps.menuDays }));

  const list = (ctx: Context) =>
    handleList({ db: deps.db, dishes: deps.dishes, matcher: deps.matcher, week: isoWeek(new Date()), plz: deps.plz }).then((t) => reply(ctx, t));

  const guard = (fn: (ctx: Context) => Promise<void>) => async (ctx: Context) => {
    try {
      await fn(ctx);
    } catch (e) {
      await ctx.reply("Упс, что-то пошло не так. Попробуй позже.");
      console.error(e);
    }
  };

  bot.command("start", (ctx) => reply(ctx, helpText()));
  bot.command("digest", guard(suggest));
  bot.command("menu", guard(menu));
  bot.command("list", guard(list));

  bot.on("message:text", guard(async (ctx) => {
    const intent = await classifyIntent(deps.llm, ctx.message.text);
    switch (intent.kind) {
      case "select_dishes":
        await reply(ctx, await handleSelect({ llm: deps.llm, db: deps.db, dishes: deps.dishes, week: isoWeek(new Date()) }, intent.dishNames));
        break;
      case "show_menu":
        await menu(ctx);
        break;
      case "show_list":
        await list(ctx);
        break;
      case "suggest":
        await suggest(ctx);
        break;
      default:
        await reply(ctx, helpText());
    }
  }));

  return bot;
}
```

- [ ] **Step 6: Wire the composition root**

In `src/main.ts`, pass the new deps to `createBot`. Change the `createBot({ ... })` call to:

```ts
const bot = createBot({
  token: cfg.telegramBotToken,
  allowedUserIds: cfg.allowedUserIds,
  dishes,
  matcher,
  llm,
  db,
  plz: cfg.locationPlz,
  menuDays: cfg.menuDays,
  coverageMin: cfg.offerCoverageMin,
  digestLimit: cfg.digestLimit,
});
```

(`llm` and `db` already exist as locals in `main.ts`; `cfg.locationPlz`/`cfg.menuDays` come from config.)

- [ ] **Step 7: Run the full suite + build check**

Run: `bun test`
Expected: PASS (whole suite).

Run: `bun build src/main.ts --target=bun --outfile=/dev/null`
Expected: clean build. (Do NOT run `bun start` — it connects to Telegram/marktguru.)

Run: `bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/bot/handlers.ts src/bot/bot.ts src/main.ts tests/handlers.test.ts
git commit -m "feat: route free text via intent router; add /menu and /list"
```

---

## Manual Verification (after merge + deploy)

1. `./deploy.sh home` (the `selection` table is created by the idempotent migration on startup).
2. One-time after this deploy: clear the pre-whitelist cache so the whitelist takes effect this week (Layer 1 review note) — e.g. `ssh home 'cd ~/annona && docker compose exec -T annona sh -c "echo \"DELETE FROM match_cache;\" | sqlite3 data/annona.db"'`. If `sqlite3` isn't in the image, just let it lapse at the next ISO week.
3. Re-seed to 110 if not already: `ssh home 'cd ~/annona && docker compose run --rm annona bun run src/recipes/seed.ts'`, then `docker compose restart annona`.
4. In Telegram: send `борщ, карбонара, плов` → confirmation listing matched dishes (+ any "не нашёл"). Then `/menu` → a 7-day table with first/second courses, borscht/plov repeating per their keeps_days. Then `/list` → ingredients grouped by store, each with a `на карте` Apple Maps link, plus "Докупить (не в акции)" for off-offer items. `/digest` still returns the Layer-1 compact shortlist.

---

## Self-Review

**Spec coverage (Layer 2 deliverables, spec §5 items 6–11 + §14):**
- Intent router → Task 3 (`classifyIntent`). ✅
- Dish resolver → Task 3 (`resolveDishes`). ✅
- Menu planner (pure, keeps_days-driven, cycling) → Task 2 (`planWeek`/`fillCourse`). ✅
- Grouped shopping list with Maps links + "докупить" → Task 4 (`buildGroupedList`) + Task 5 render. ✅
- Selection persistence (`selection(week)`) → Task 1. ✅
- Bot wiring (`message:text` via router; `/menu` `/list`) → Task 5. ✅
- `MENU_DAYS` config → Task 1. ✅

**Placeholder scan:** none — every code step is complete; every command has an expected result.

**Type consistency:** `WeeklyMenu`/`MenuDay` (Task 2) consumed by `handleMenu` (Task 5). `Intent` (Task 3) consumed by the bot router (Task 5). `ResolveResult`/`resolveDishes` (Task 3) consumed by `handleSelect` (Task 5). `GroupedShoppingList`/`buildGroupedList` (Task 4) consumed by `handleList` (Task 5). `saveSelection`/`getSelection` (Task 1) consumed by Task 5. `StoreKey` imported into `types.ts` (Task 4) for `StoreGroup`. `createBot` gains `llm`/`db`/`plz`/`menuDays`, all supplied by `main.ts` (Task 5). Per-message `isoWeek(new Date())` is used for selection (the matcher keeps its Phase-1 startup week; selection is correctly current-week).
