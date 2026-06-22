# Annona bot UX + features (Spec 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Annona meal-planning bot a button-driven menu UI (main hub + paginated recipe browser + dish cards with on-demand cooking steps), show an approximate per-dish cost ("по акциям") in `/menu`, `/list`, and the card, and drop the Kaufland store.

**Architecture:** A new `@grammyjs/menu` layer adds an inline-keyboard hub and a recipe browser/card, rendered in HTML (needed for expandable blockquotes). Per-dish cost reuses the existing matcher/cache via a new shared `src/cost.ts`. Recipe steps are a new nullable `dishes.steps` column, generated lazily on first view. `/menu` and `/list` stay in Markdown and just gain a cost line. Existing commands and the generate-on-miss flow are unchanged.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, grammY `1.44.0` + `@grammyjs/menu`, Anthropic (Haiku) structured tool-use, Zod.

## Global Constraints

- Default to Bun: `bun test`, `bun:sqlite`, grammY. No `node`.
- One new dependency allowed: `@grammyjs/menu` (first-party grammY plugin). No others.
- No external recipe/price API (that is Spec 2).
- DB change limited to a single additive, idempotent column (`dishes.steps TEXT` nullable) via `COLUMN_MIGRATIONS` — no new tables.
- All user-facing strings in Russian.
- Per-dish/total € figures are labelled "(по акциям)" (sale-only lower bound).
- Immutable update patterns; `bunx tsc --noEmit` clean and `bun test` green before every commit.
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- Do not rewrite untouched messages/surfaces; do not restructure unrelated code.
- Commit attribution disabled globally — NO `Co-Authored-By` trailer.

---

### Task 1: Drop Kaufland from the default store whitelist

`STORE_WHITELIST` defaults to all 8 stores including `kaufland`. Remove `kaufland` from the default so a deploy without an explicit env var excludes it. (Prod `.env` is user-managed; the user removes it there if set explicitly.)

**Files:**
- Modify: `src/config.ts:25` (the `.default(...)` string)
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: nothing new — only the default value changes.

- [ ] **Step 1: Write the failing test**

Add to `tests/config.test.ts`:

```ts
test("default STORE_WHITELIST excludes kaufland", () => {
  const cfg = loadConfig({
    TELEGRAM_BOT_TOKEN: "t",
    ALLOWED_USER_IDS: "1",
    ANTHROPIC_API_KEY: "k",
  });
  expect(cfg.storeWhitelist).not.toContain("kaufland");
  expect(cfg.storeWhitelist).toContain("lidl");
});
```

Confirm `loadConfig` is imported at the top of the test file (it is used by existing tests). If not, add `import { loadConfig } from "../src/config";`.

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test tests/config.test.ts -t "kaufland"`
Expected: FAIL — default still contains `kaufland`.

- [ ] **Step 3: Change the default**

In `src/config.ts`, change the `STORE_WHITELIST` default string (line 25) from:

```ts
    .default("lidl,penny,kaufland,edeka,dm,aldi,netto,rewe")
```

to:

```ts
    .default("lidl,penny,edeka,dm,aldi,netto,rewe")
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test tests/config.test.ts -t "kaufland"`
Expected: PASS.

- [ ] **Step 5: Run the full suite + tsc**

Run: `bun test && bunx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(stores): drop Kaufland from the default whitelist"
```

---

### Task 2: Shared per-dish cost helper (`src/cost.ts`)

Extract the "sum of winning sale-offer shelf prices" logic (currently inline in `recommender.rankDishes`) into a shared module used by both the recommender and the new UI surfaces. Cost is the sum of `offer.price` over the dish's matched ingredients (unmatched ingredients contribute 0) — NOT scaled by quantity, matching the existing `estTotal` semantics.

**Files:**
- Create: `src/cost.ts`
- Modify: `src/recommender.ts:13-26` (use the shared helper for `estTotal`)
- Test: `tests/cost.test.ts` (create)

**Interfaces:**
- Consumes: `Matcher.matchIngredient(canonical): Promise<Offer | null>` (existing), `Offer`, `Dish`.
- Produces:
  - `export function dishCostFromMatches(dish: Dish, matches: Map<string, Offer | null>): number`
  - `export async function estimateDishCost(matcher: Matcher, dish: Dish): Promise<number>`

- [ ] **Step 1: Write the failing tests**

Create `tests/cost.test.ts`:

```ts
import { test, expect } from "bun:test";
import { dishCostFromMatches, estimateDishCost } from "../src/cost";
import type { Dish, Offer } from "../src/types";
import type { Matcher } from "../src/matcher";

const offer = (price: number): Offer => ({
  externalId: 1, store: "aldi", storeName: "Aldi", product: "x",
  price, oldPrice: null, referencePrice: null, unit: "kg", validFrom: "", validTo: "",
});

const dish: Dish = {
  nameRu: "Борщ", nameUa: null, nameDe: null, cuisine: "ua", course: "first",
  keepsDays: 4, tags: [], servings: 4,
  ingredients: [{ canonical: "свёкла", qty: 1, unit: "кг" }, { canonical: "капуста", qty: 1, unit: "кг" }],
};

test("dishCostFromMatches sums matched offer prices, ignores unmatched", () => {
  const matches = new Map<string, Offer | null>([
    ["свёкла", offer(0.99)],
    ["капуста", null],
  ]);
  expect(dishCostFromMatches(dish, matches)).toBeCloseTo(0.99);
});

test("estimateDishCost matches each ingredient and sums", async () => {
  const prices: Record<string, number> = { "свёкла": 0.99, "капуста": 1.49 };
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient(c) { return c in prices ? offer(prices[c]!) : null; },
  };
  expect(await estimateDishCost(matcher, dish)).toBeCloseTo(2.48);
});
```

- [ ] **Step 2: Run them, verify they fail**

Run: `bun test tests/cost.test.ts`
Expected: FAIL — module `../src/cost` not found.

- [ ] **Step 3: Implement `src/cost.ts`**

```ts
import type { Dish, Offer } from "./types";
import type { Matcher } from "./matcher";

/** Sum the winning sale-offer shelf prices for a dish's ingredients (unmatched = 0). */
export function dishCostFromMatches(dish: Dish, matches: Map<string, Offer | null>): number {
  let total = 0;
  for (const ing of dish.ingredients) {
    const m = matches.get(ing.canonical);
    if (m) total += m.price;
  }
  return total;
}

/** Estimate a dish's cost "по акциям" by matching each ingredient via the matcher (cache-warm). */
export async function estimateDishCost(matcher: Matcher, dish: Dish): Promise<number> {
  const matches = new Map<string, Offer | null>();
  for (const ing of dish.ingredients) {
    if (!matches.has(ing.canonical)) {
      matches.set(ing.canonical, await matcher.matchIngredient(ing.canonical));
    }
  }
  return dishCostFromMatches(dish, matches);
}
```

- [ ] **Step 4: Run them, verify they pass**

Run: `bun test tests/cost.test.ts`
Expected: PASS.

- [ ] **Step 5: Refactor `recommender.ts` to use the shared helper (DRY)**

In `src/recommender.ts`, add the import at the top:

```ts
import { dishCostFromMatches } from "./cost";
```

Replace the `rankDishes` body's per-dish loop (lines 13-26) with:

```ts
  const ranked: RankedDish[] = dishes.map((dish) => {
    let onOfferCount = 0;
    for (const ing of dish.ingredients) {
      if (matches.get(ing.canonical)) onOfferCount++;
    }
    const estTotal = dishCostFromMatches(dish, matches);
    const total = dish.ingredients.length;
    const coverage = total === 0 ? 0 : onOfferCount / total;
    return { dish, onOfferCount, estTotal, coverage };
  });
```

(Leave the sort and the file's leading comment unchanged.)

- [ ] **Step 6: Run the full suite + tsc, verify green**

Run: `bun test && bunx tsc --noEmit`
Expected: PASS (existing `recommender.test.ts` still green — `estTotal` values are identical), tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/cost.ts src/recommender.ts tests/cost.test.ts
git commit -m "feat(cost): shared per-dish cost helper, reused by recommender"
```

---

### Task 3: Recipe steps — column, type, store helpers, generator

Add a nullable `dishes.steps` column, a `Dish.steps` field, get/set helpers, and an LLM generator. New dishes keep `steps` null; steps are generated lazily on first view (Task 6). `listDishes` is intentionally NOT changed (steps loaded on demand via `dishSteps`).

**Files:**
- Modify: `src/db/migrations.ts:8-19` (add the column migration)
- Modify: `src/types.ts:22-33` (add `steps`)
- Modify: `src/recipes/recipeStore.ts` (add `dishSteps`, `saveDishSteps`, `generateSteps`)
- Test: `tests/recipeStore.test.ts`

**Interfaces:**
- Consumes: `Llm.structured` (existing), `Database`, `Dish`.
- Produces:
  - `Dish.steps?: string | null`
  - `export function dishSteps(db: Database, dishId: number): string | null`
  - `export function saveDishSteps(db: Database, dishId: number, steps: string): void`
  - `export async function generateSteps(llm: Llm, dish: Dish): Promise<string>`

- [ ] **Step 1: Write the failing tests**

Add to `tests/recipeStore.test.ts` (import `dishSteps, saveDishSteps, generateSteps` in the top `recipeStore` import alongside the existing names):

```ts
test("saveDishSteps + dishSteps round-trip; null before save", () => {
  const db = openDb(":memory:");
  const id = insertDish(db, borscht);
  expect(dishSteps(db, id)).toBeNull();
  saveDishSteps(db, id, "1. Налей воду.\n2. Свари свёклу.");
  expect(dishSteps(db, id)).toContain("Свари свёклу");
});

test("generateSteps asks the LLM and returns the steps text", async () => {
  const llm: Llm = {
    async structured(args: { toolName?: string }) {
      expect(args.toolName).toBe("save_steps");
      return { steps: "1. Шаг один.\n2. Шаг два." } as never;
    },
  };
  const steps = await generateSteps(llm, borscht);
  expect(steps).toContain("Шаг один");
});
```

(`borscht` is an existing module-level fixture in `recipeStore.test.ts`. If the file does not define one, add `const borscht: Dish = { nameRu: "Борщ", nameUa: null, nameDe: null, cuisine: "ua", course: "first", keepsDays: 4, tags: [], servings: 4, ingredients: [{ canonical: "свёкла", qty: 1, unit: "кг" }] };` near the other fixtures and import `Dish` from `../src/types`.)

- [ ] **Step 2: Run them, verify they fail**

Run: `bun test tests/recipeStore.test.ts -t "Steps"`
Expected: FAIL — `dishSteps`/`saveDishSteps`/`generateSteps` not defined (and the `steps` column missing).

- [ ] **Step 3: Add the column migration**

In `src/db/migrations.ts`, append to the `COLUMN_MIGRATIONS` array (after the `keeps_days` entry, before the closing `]`):

```ts
  {
    table: "dishes",
    column: "steps",
    ddl: "ALTER TABLE dishes ADD COLUMN steps TEXT",
  },
```

- [ ] **Step 4: Add the `steps` field to the `Dish` type**

In `src/types.ts`, add to the `Dish` type (after `keepsDays?`):

```ts
  steps?: string | null; // cooking steps, lazily generated; null until first view
```

- [ ] **Step 5: Implement the store helpers + generator**

In `src/recipes/recipeStore.ts`, add a Zod schema near the other schemas (after `GenerateDishSchema`, ~line 33):

```ts
const StepsSchema = z.object({ steps: z.string().min(1) });
```

Add these functions after `dishIdByName` (~line 148):

```ts
/** Return a dish's cached cooking steps, or null if not yet generated. */
export function dishSteps(db: Database, dishId: number): string | null {
  const row = db.query("SELECT steps FROM dishes WHERE id = ?").get(dishId) as { steps: string | null } | null;
  return row?.steps ?? null;
}

/** Persist generated cooking steps for a dish. */
export function saveDishSteps(db: Database, dishId: number, steps: string): void {
  db.run("UPDATE dishes SET steps = ? WHERE id = ?", [steps, dishId]);
}

/** Generate numbered Russian cooking steps for a dish from its name + ingredients. */
export async function generateSteps(llm: Llm, dish: Dish): Promise<string> {
  const ings = dish.ingredients
    .map((i) => (i.qty !== null ? `${i.canonical} ${i.qty}${i.unit ? ` ${i.unit}` : ""}` : i.canonical))
    .join(", ");
  const out = await llm.structured({
    system: "Ты повар. Пиши простые домашние рецепты на русском, нумерованными шагами.",
    prompt:
      `Напиши пошаговый рецепт блюда «${dish.nameRu}» на ${dish.servings} порц. ` +
      `Ингредиенты: ${ings}. Верни нумерованные шаги (1., 2., …), кратко и по делу.`,
    toolName: "save_steps",
    description: "Persist the recipe cooking steps",
    schema: StepsSchema,
    maxTokens: 1024,
  });
  return out.steps;
}
```

- [ ] **Step 6: Run them, verify they pass**

Run: `bun test tests/recipeStore.test.ts -t "Steps"`
Expected: PASS.

- [ ] **Step 7: Run the full suite + tsc, verify green**

Run: `bun test && bunx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 8: Commit**

```bash
git add src/db/migrations.ts src/types.ts src/recipes/recipeStore.ts tests/recipeStore.test.ts
git commit -m "feat(recipes): dishes.steps column + lazy step generation helpers"
```

---

### Task 4: Surface per-dish cost in `/menu` and `/list`

`/menu` rows gain `~X.XX€`; its header notes "(цены по акциям)". `/list` gains a per-dish breakdown block + grand total. Both reuse `estimateDishCost`. `handleMenu` becomes async and takes the matcher.

**Files:**
- Modify: `src/bot/handlers.ts` (`handleMenu` ~107-134, `handleList` ~137-167)
- Modify: `src/bot/bot.ts` (the `menu` helper ~80-81 — pass matcher + await)
- Test: `tests/handlers.test.ts` (update the 3 `handleMenu` tests; add a cost test for each surface)

**Interfaces:**
- Consumes: `estimateDishCost` (Task 2).
- Produces: `handleMenu(deps: { db; dishes; matcher: Matcher; week; menuDays; householdSize? }): Promise<string>` (now async, +`matcher`). `handleList` signature unchanged.

- [ ] **Step 1: Update the existing `handleMenu` tests to be async + pass a matcher**

In `tests/handlers.test.ts`, the three `handleMenu` tests (≈ lines 124-139 and 252-260) currently call `handleMenu({...})` synchronously without a matcher. Replace each call so it awaits and passes a zero-cost matcher. Define this helper once near the top of the file (after the `llmResolve` helper, ~line 17):

```ts
const noOffers: Matcher = { async searchTerms() { return []; }, async matchIngredient() { return null; } };
```

Then change the three tests to async and pass `matcher: noOffers`. For example:

```ts
test("handleMenu renders a 7-day menu from the saved selection", async () => {
  const db = openDb(":memory:");
  const id1 = insertDish(db, borsch);
  const id2 = insertDish(db, plov);
  const dishes = [{ ...borsch, id: id1 }, { ...plov, id: id2 }];
  saveSelection(db, "2026-W26", [id1, id2]);
  const text = await handleMenu({ db, dishes, matcher: noOffers, week: "2026-W26", menuDays: 7 });
  expect(text).toContain("Борщ");
  expect(text).toContain("Плов");
});
```

Apply the same two changes (add `async`, `await`, `matcher: noOffers`) to `"handleMenu asks for a selection when none is saved"` and `"handleMenu surfaces portion coverage for the household"`.

- [ ] **Step 2: Add the new cost tests**

Add to `tests/handlers.test.ts`:

```ts
test("handleMenu shows an approximate per-dish cost", async () => {
  const db = openDb(":memory:");
  const id1 = insertDish(db, borsch);
  const dishes = [{ ...borsch, id: id1 }];
  saveSelection(db, "2026-W26", [id1]);
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient() {
      return { externalId: 1, store: "aldi", storeName: "Aldi", product: "Rote Bete", price: 1.5, oldPrice: null, referencePrice: null, unit: "kg", validFrom: "", validTo: "" };
    },
  };
  const text = await handleMenu({ db, dishes, matcher, week: "2026-W26", menuDays: 7 });
  expect(text).toContain("1.50€");
  expect(text.toLowerCase()).toContain("по акциям");
});

test("handleList shows a per-dish breakdown and grand total", async () => {
  const db = openDb(":memory:");
  const id1 = insertDish(db, borsch); // 1 ingredient
  const dishes = [{ ...borsch, id: id1 }];
  saveSelection(db, "2026-W26", [id1]);
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient() {
      return { externalId: 1, store: "aldi", storeName: "Aldi", product: "Rote Bete", price: 2.0, oldPrice: null, referencePrice: null, unit: "kg", validFrom: "", validTo: "" };
    },
  };
  const text = await handleList({ db, dishes, matcher, week: "2026-W26", plz: 30459 });
  expect(text).toContain("Борщ — ~2.00€");
  expect(text).toContain("Итого");
});
```

- [ ] **Step 3: Run them, verify they fail**

Run: `bun test tests/handlers.test.ts -t "per-dish"` and `bun test tests/handlers.test.ts -t "breakdown"`
Expected: FAIL — `handleMenu` not async / no matcher param / no cost text; `/list` has no breakdown.

- [ ] **Step 4: Make `handleMenu` async with cost**

In `src/bot/handlers.ts`, add the import (top of file, with the other imports):

```ts
import { estimateDishCost } from "../cost";
```

Replace `handleMenu` (≈107-134) with:

```ts
/** Render the weekly menu from the saved selection, with an approximate per-dish cost. */
export async function handleMenu(deps: {
  db: Database;
  dishes: Dish[];
  matcher: Matcher;
  week: string;
  menuDays: number;
  householdSize?: number;
}): Promise<string> {
  const ids = getSelection(deps.db, deps.week);
  if (!ids || ids.length === 0) return NO_SELECTION;

  const household = deps.householdSize ?? DEFAULT_HOUSEHOLD;
  const byId = new Map(deps.dishes.filter((d) => d.id !== undefined).map((d) => [d.id as number, d]));
  const chosen = ids.map((id) => byId.get(id)).filter((d): d is Dish => d !== undefined);
  const firsts = chosen.filter((d) => d.course === "first");
  const seconds = chosen.filter((d) => d.course !== "first");
  const menu = planWeek(firsts, seconds, deps.menuDays);

  const cost = new Map<number, number>();
  for (const d of chosen) cost.set(d.id as number, await estimateDishCost(deps.matcher, d));

  const cell = (dish: Dish | null): string =>
    dish ? `${dish.nameRu} ~${(cost.get(dish.id as number) ?? 0).toFixed(2)}€ (~${coverageDays(dish.servings, household)}дн)` : "—";

  const labels = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  const lines = [`📅 Меню на неделю (семья ${household}) · цены по акциям:\n`];
  for (const d of menu.days) {
    const label = labels[(d.day - 1) % 7] ?? `День ${d.day}`;
    lines.push(`*${label}*: 🥣 ${cell(d.first)} · 🍽 ${cell(d.second)}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 5: Add the `/list` breakdown + total**

In `src/bot/handlers.ts`, in `handleList`, replace the final `return lines.join("\n");` (≈166) and the lines just before it so the pantry footer stays last but a cost block is inserted before it. Specifically, replace lines ≈164-166:

```ts
  if (missing.length) lines.push(`\n*Докупить (не в акции):* ${missing.join(", ")}`);

  const costLines = await Promise.all(
    chosen.map(async (d) => `• ${d.nameRu} — ~${(await estimateDishCost(deps.matcher, d)).toFixed(2)}€`)
  );
  const total = (
    await Promise.all(chosen.map((d) => estimateDishCost(deps.matcher, d)))
  ).reduce((a, b) => a + b, 0);
  if (costLines.length) {
    lines.push(`\n💰 *Примерно по блюдам (по акциям):*`);
    lines.push(...costLines);
    lines.push(`Итого: ~${total.toFixed(2)}€`);
  }

  if (inPantry.length) lines.push(`\n✅ Уже дома: ${inPantry.join(", ")}`);
  return lines.join("\n");
```

(Note: `chosen` is already in scope in `handleList`. The grand total is the sum of per-dish estimates and may double-count ingredients shared between dishes — this is the documented "(по акциям)" approximation.)

- [ ] **Step 6: Update the `menu` call site in `bot.ts`**

In `src/bot/bot.ts`, replace the `menu` helper (≈80-81):

```ts
  const menu = (ctx: Context) =>
    handleMenu({ db: deps.db, dishes, matcher: deps.matcher, week: week(), menuDays: deps.menuDays, householdSize: household }).then(
      (t) => reply(ctx, t)
    );
```

- [ ] **Step 7: Run the full suite + tsc, verify green**

Run: `bun test && bunx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 8: Commit**

```bash
git add src/bot/handlers.ts src/bot/bot.ts tests/handlers.test.ts
git commit -m "feat(cost): show approximate per-dish cost in /menu and /list"
```

---

### Task 5: `@grammyjs/menu` + HTML helper + main menu hub on `/start`

Install the menu plugin, add an HTML-escape helper, build the main hub menu, register it, and show it on `/start`. `/menu`, `/list`, `/digest` etc. remain working commands; the hub's buttons trigger the same handlers. Existing commands are unchanged.

> **Plugin API note:** Before writing menu code, confirm the `@grammyjs/menu` API via context7 (`mcp__plugin_context7_context7__resolve-library-id` → `query-docs` for "grammy menu plugin"). Key surface used below: `new Menu("id")`, `.text("label", handler)` / `.text({ text, payload }, handler)`, `.submenu("label", "subId", onFn?)`, `.back("label")`, `.row()`, `.dynamic((ctx, range) => {…})`, `ctx.menu.update()`, `ctx.menu.nav("id")`, `ctx.match` (the payload of the navigating button), registering via `bot.use(menu)` and sending via `ctx.reply(text, { reply_markup: menu, parse_mode: "HTML" })`. Adjust the representative code to the real API.

**Files:**
- Modify: `package.json` (`bun add @grammyjs/menu`)
- Create: `src/bot/format.ts` (`esc`)
- Create: `src/bot/menus.ts` (`createMenus(deps)` → registered `Menu` instances)
- Modify: `src/bot/bot.ts` (register menus, show hub on `/start`)
- Test: `tests/format.test.ts` (create); `tests/bot.test.ts` (hub-on-/start smoke)

**Interfaces:**
- Produces:
  - `export function esc(s: string): string` (escapes `& < >`)
  - `export function createMenus(deps: MenuDeps): { main: Menu<Context> }` where `MenuDeps = { db: Database; matcher: Matcher; llm: Llm; menuDays: number; householdSize: number; plz: number; week: () => string; coverageMin?: number; digestLimit?: number }`
- Consumes (Task 6 extends `createMenus` with the recipes browser submenu).

- [ ] **Step 1: Install the plugin**

Run: `bun add @grammyjs/menu`
Expected: `@grammyjs/menu` appears in `package.json` dependencies; `bun install` clean.

- [ ] **Step 2: Write the failing `esc` test**

Create `tests/format.test.ts`:

```ts
import { test, expect } from "bun:test";
import { esc } from "../src/bot/format";

test("esc escapes the three HTML-significant characters only", () => {
  expect(esc("Соус <Tom & Jerry>")).toBe("Соус &lt;Tom &amp; Jerry&gt;");
  expect(esc("борщ")).toBe("борщ");
});
```

- [ ] **Step 3: Run it, verify it fails**

Run: `bun test tests/format.test.ts`
Expected: FAIL — module `../src/bot/format` not found.

- [ ] **Step 4: Implement `src/bot/format.ts`**

```ts
/** Escape the three HTML-significant characters for Telegram HTML parse mode. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
```

- [ ] **Step 5: Run it, verify it passes**

Run: `bun test tests/format.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the hub-on-/start smoke test**

Add to `tests/bot.test.ts` (reuse the existing `harness`, `textUpdate`, and the `sent` capture; if a `/start` update helper does not exist, build the update inline as the other tests do). The test asserts that `/start` replies with an inline keyboard containing the hub buttons:

```ts
test("/start shows the main menu hub with inline buttons", async () => {
  const db = openDb(":memory:");
  const { bot, sent } = harness(db, [], llmResolve([], []));
  await bot.handleUpdate(textUpdate("/start"));
  const hub = sent.find((s) => s.method === "sendMessage" && s.payload.reply_markup);
  expect(hub).toBeDefined();
  const kb = JSON.stringify(hub!.payload.reply_markup);
  expect(kb).toContain("Меню недели");
  expect(kb).toContain("Рецепты");
});
```

(If `bot.test.ts`'s `harness` does not already exist with this shape, use the existing harness factory in that file — match its real signature. `llmResolve` may need to be imported/defined as in the existing tests; reuse what the file already has.)

- [ ] **Step 7: Run it, verify it fails**

Run: `bun test tests/bot.test.ts -t "main menu hub"`
Expected: FAIL — `/start` currently replies `helpText()` as plain text with no `reply_markup`.

- [ ] **Step 8: Implement `src/bot/menus.ts`**

Create the menu factory. Buttons call the same logic the commands use. The hub re-renders weekly menu / list / digest text as a NEW reply (not in-place) for those text-heavy views — the in-place navigation is for the recipe browser (Task 6). Representative code (verify plugin API):

```ts
import { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";
import type { Database } from "bun:sqlite";
import type { Matcher } from "../matcher";
import type { Llm } from "../llm/llm";
import { handleMenu, handleList, handleRecommend, handleShowPantry } from "./handlers";
import { listDishes } from "../recipes/recipeStore";

export type MenuDeps = {
  db: Database;
  matcher: Matcher;
  llm: Llm;
  menuDays: number;
  householdSize: number;
  plz: number;
  week: () => string;
  coverageMin?: number;
  digestLimit?: number;
};

export function createMenus(deps: MenuDeps): { main: Menu<Context> } {
  const main = new Menu<Context>("annona-main")
    .text("📋 Меню недели", async (ctx) => {
      await ctx.reply(
        await handleMenu({ db: deps.db, dishes: listDishes(deps.db), matcher: deps.matcher, week: deps.week(), menuDays: deps.menuDays, householdSize: deps.householdSize }),
        { parse_mode: "Markdown" }
      );
    })
    .text("🛒 Покупки", async (ctx) => {
      await ctx.reply(
        await handleList({ db: deps.db, dishes: listDishes(deps.db), matcher: deps.matcher, week: deps.week(), plz: deps.plz, householdSize: deps.householdSize }),
        { parse_mode: "Markdown" }
      );
    })
    .row()
    .text("🍳 Что приготовить", async (ctx) => {
      await ctx.reply(
        await handleRecommend({ dishes: listDishes(deps.db), matcher: deps.matcher, coverageMin: deps.coverageMin, limit: deps.digestLimit, householdSize: deps.householdSize }),
        { parse_mode: "Markdown" }
      );
    })
    .text("🥫 Кладовка", async (ctx) => {
      await ctx.reply(handleShowPantry({ db: deps.db, week: deps.week() }));
    })
    .row();
  // Task 6 attaches the "📖 Рецепты" submenu + "➕ Добавить" here.

  return { main };
}
```

- [ ] **Step 9: Register the hub + show on `/start`**

In `src/bot/bot.ts`:

Add imports (with the other imports):

```ts
import { createMenus } from "./menus";
```

Inside `createBot`, after the `week` helper is defined (~69) and before the command registrations, build and register the menus:

```ts
  const menus = createMenus({
    db: deps.db, matcher: deps.matcher, llm: deps.llm,
    menuDays: deps.menuDays, householdSize: household, plz: deps.plz, week,
    coverageMin: deps.coverageMin, digestLimit: deps.digestLimit,
  });
  bot.use(menus.main);
```

Replace the `/start` command (~199):

```ts
  bot.command("start", async (ctx) => {
    await ctx.reply(helpText(), { reply_markup: menus.main });
  });
```

- [ ] **Step 10: Run the full suite + tsc, verify green**

Run: `bun test && bunx tsc --noEmit`
Expected: PASS (hub smoke test green), tsc clean.

- [ ] **Step 11: Commit**

```bash
git add package.json bun.lock src/bot/format.ts src/bot/menus.ts src/bot/bot.ts tests/format.test.ts tests/bot.test.ts
git commit -m "feat(ui): main menu hub on /start via @grammyjs/menu"
```

---

### Task 6: Recipe browser (paginated) + dish card with lazy steps

Add a "📖 Рецепты" submenu: a paginated list of catalogue dishes; tapping one opens a dish card (HTML) showing course · servings · "~cost (по акциям)" · ingredients, with buttons 📖 Показать рецепт (lazy steps) · ➕ В меню · 🗑 Удалить · ⬅️ Назад. Pure helpers (`paginate`, `renderDishCard`) are fully tested; the menu wiring is verified by a harness smoke test + the deploy smoke.

> **Plugin API note:** Same as Task 5 — confirm `@grammyjs/menu` dynamic-range + payload + `ctx.menu.update()`/`nav()` behaviour via context7 before wiring.

**Files:**
- Create: `src/bot/recipeView.ts` (`paginate`, `renderDishCard`)
- Modify: `src/bot/menus.ts` (recipes submenu + dish-card submenu + actions; attach "📖 Рецепты" + "➕ Добавить" to `main`)
- Test: `tests/recipeView.test.ts` (create); `tests/bot.test.ts` (browser smoke)

**Interfaces:**
- Consumes: `listDishes`, `deleteDish`, `dishSteps`, `saveDishSteps`, `generateSteps` (Task 3), `estimateDishCost` (Task 2), `addToSelection`, `esc` (Task 5).
- Produces:
  - `export function paginate<T>(items: T[], page: number, perPage: number): { slice: T[]; page: number; pages: number }`
  - `export function renderDishCard(dish: Dish, costText: string, steps: string | null): string` (HTML)

- [ ] **Step 1: Write the failing helper tests**

Create `tests/recipeView.test.ts`:

```ts
import { test, expect } from "bun:test";
import { paginate, renderDishCard } from "../src/bot/recipeView";
import type { Dish } from "../src/types";

test("paginate clamps the page into range and slices", () => {
  const items = [1, 2, 3, 4, 5];
  expect(paginate(items, 0, 2)).toEqual({ slice: [1, 2], page: 0, pages: 3 });
  expect(paginate(items, 2, 2)).toEqual({ slice: [5], page: 2, pages: 3 });
  expect(paginate(items, 9, 2).page).toBe(2);   // clamped to last page
  expect(paginate(items, -1, 2).page).toBe(0);  // clamped to first page
});

test("paginate reports 1 page for an empty list", () => {
  expect(paginate([], 0, 6)).toEqual({ slice: [], page: 0, pages: 1 });
});

const dish: Dish = {
  nameRu: "Карбонара", nameUa: null, nameDe: null, cuisine: "it", course: "second",
  keepsDays: 1, tags: [], servings: 4,
  ingredients: [{ canonical: "спагетти", qty: 400, unit: "г" }, { canonical: "бекон", qty: 150, unit: "г" }],
};

test("renderDishCard shows name, meta, ingredients; steps only when present", () => {
  const noSteps = renderDishCard(dish, "~6.40€ (по акциям)", null);
  expect(noSteps).toContain("Карбонара");
  expect(noSteps).toContain("~6.40€");
  expect(noSteps).toContain("спагетти");
  expect(noSteps).not.toContain("blockquote");

  const withSteps = renderDishCard(dish, "~6.40€ (по акциям)", "1. Свари пасту.");
  expect(withSteps).toContain("blockquote");
  expect(withSteps).toContain("Свари пасту");
});

test("renderDishCard escapes HTML-significant characters in the name", () => {
  const danger: Dish = { ...dish, nameRu: "Соус <острый>" };
  expect(renderDishCard(danger, "~1.00€", null)).toContain("Соус &lt;острый&gt;");
});
```

- [ ] **Step 2: Run them, verify they fail**

Run: `bun test tests/recipeView.test.ts`
Expected: FAIL — module `../src/bot/recipeView` not found.

- [ ] **Step 3: Implement `src/bot/recipeView.ts`**

```ts
import type { Dish } from "../types";
import { esc } from "./format";

/** Clamp `page` into [0, pages-1] and return that slice of `items`. */
export function paginate<T>(items: T[], page: number, perPage: number): { slice: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const clamped = Math.min(Math.max(page, 0), pages - 1);
  const start = clamped * perPage;
  return { slice: items.slice(start, start + perPage), page: clamped, pages };
}

/** HTML dish card: name, meta, ingredients, and (if present) steps in an expandable blockquote. */
export function renderDishCard(dish: Dish, costText: string, steps: string | null): string {
  const course = dish.course === "first" ? "первое" : "второе";
  const ings = dish.ingredients
    .map((i) => (i.qty !== null ? `${i.canonical} ${i.qty}${i.unit ? ` ${i.unit}` : ""}` : i.canonical))
    .join(", ");
  const lines = [
    `🍽 <b>${esc(dish.nameRu)}</b>`,
    `${course} · ${dish.servings} порц · ${esc(costText)} · хранится ~${dish.keepsDays ?? 1} дн`,
    `<b>Ингредиенты:</b> ${esc(ings)}`,
  ];
  if (steps) lines.push(`<blockquote expandable>${esc(steps)}</blockquote>`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run them, verify they pass**

Run: `bun test tests/recipeView.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the recipes browser + dish card into `src/bot/menus.ts`**

Add imports to `src/bot/menus.ts`:

```ts
import { paginate, renderDishCard } from "./recipeView";
import { estimateDishCost } from "../cost";
import { dishSteps, saveDishSteps, generateSteps, deleteDish } from "../recipes/recipeStore";
import { addToSelection } from "../recipes/selectionStore";
```

Inside `createMenus`, before building `main`, add per-user paging state and the two submenus. Representative code (verify plugin API for `dynamic`, payload via `ctx.match`, `ctx.menu.nav/update`):

```ts
  const PER_PAGE = 6;
  const page = new Map<number, number>(); // userId → current recipe-browser page

  const card = new Menu<Context>("annona-card")
    .text(
      { text: "📖 Показать рецепт" },
      async (ctx) => {
        const id = Number(ctx.match);
        const dish = listDishes(deps.db).find((d) => d.id === id);
        if (!dish || dish.id === undefined) { await ctx.answerCallbackQuery("Блюдо не найдено"); return; }
        let steps = dishSteps(deps.db, dish.id);
        if (!steps) {
          try {
            steps = await generateSteps(deps.llm, dish);
            saveDishSteps(deps.db, dish.id, steps);
          } catch {
            await ctx.answerCallbackQuery("Не получилось собрать рецепт, попробуй ещё раз");
            return;
          }
        }
        const cost = await estimateDishCost(deps.matcher, dish);
        await ctx.editMessageText(renderDishCard(dish, `~${cost.toFixed(2)}€ (по акциям)`, steps), { parse_mode: "HTML" });
      }
    )
    .text(
      { text: "➕ В меню" },
      async (ctx) => {
        const id = Number(ctx.match);
        addToSelection(deps.db, deps.week(), [id]);
        await ctx.answerCallbackQuery("Добавил в меню недели");
      }
    )
    .row()
    .text(
      { text: "🗑 Удалить" },
      async (ctx) => {
        const id = Number(ctx.match);
        deleteDish(deps.db, id);
        await ctx.answerCallbackQuery("Удалил из каталога");
        ctx.menu.nav("annona-recipes");
      }
    )
    .back("⬅️ Назад");

  const recipes = new Menu<Context>("annona-recipes")
    .dynamic((ctx, range) => {
      const uid = ctx.from?.id ?? 0;
      const all = listDishes(deps.db);
      const { slice, page: p, pages } = paginate(all, page.get(uid) ?? 0, PER_PAGE);
      page.set(uid, p);
      for (const d of slice) {
        range.submenu({ text: d.nameRu, payload: String(d.id) }, "annona-card", async (ctx) => {
          const cost = await estimateDishCost(deps.matcher, d);
          await ctx.editMessageText(renderDishCard(d, `~${cost.toFixed(2)}€ (по акциям)`, dishSteps(deps.db, d.id as number)), { parse_mode: "HTML" });
        }).row();
      }
      range
        .text("⬅️", (ctx) => { page.set(uid, Math.max((page.get(uid) ?? 0) - 1, 0)); ctx.menu.update(); })
        .text(`${p + 1}/${pages}`, (ctx) => ctx.answerCallbackQuery())
        .text("➡️", (ctx) => { page.set(uid, Math.min((page.get(uid) ?? 0) + 1, pages - 1)); ctx.menu.update(); });
    })
    .row()
    .back("🏠 Домой");

  card.register(recipes); // if the plugin requires explicit submenu registration; otherwise register both on the bot
```

Then attach the recipes submenu to `main` (extend the chain built in Task 5):

```ts
  // …after the "🥫 Кладовка" .text(...).row() in `main`:
    .submenu("📖 Рецепты", "annona-recipes");
```

Register the submenus in `bot.ts` if the plugin needs each top-level menu registered. Per `@grammyjs/menu`, a submenu navigated via `.submenu(...)` must be made known to its parent with `parent.register(child)`. Update `createMenus` to register `recipes` and `card` under `main` (`main.register(recipes); recipes.register(card);`) and return only `{ main }`. Verify the exact registration requirement in the docs.

- [ ] **Step 6: Write the browser smoke test**

Add to `tests/bot.test.ts`:

```ts
test("tapping 📖 Рецепты lists catalogue dishes as buttons", async () => {
  const db = openDb(":memory:");
  insertDish(db, { nameRu: "Борщ", nameUa: null, nameDe: null, cuisine: "ua", course: "first", keepsDays: 4, tags: [], servings: 4, ingredients: [{ canonical: "свёкла", qty: 1, unit: "кг" }] });
  const { bot, sent } = harness(db, listDishes(db), llmResolve([], []));
  await bot.handleUpdate(textUpdate("/start"));
  // Navigate into the recipes submenu via its callback. Use the existing callbackUpdate helper.
  await bot.handleUpdate(callbackUpdate("annona-main/recipes-submenu-payload"));
  const shown = JSON.stringify(sent.map((s) => s.payload.reply_markup));
  expect(shown).toContain("Борщ");
});
```

> This smoke test depends on the exact callback_data `@grammyjs/menu` emits for a `.submenu` button. If that string is opaque/unstable, replace this test with a direct assertion on the menu structure the plugin exposes, OR drop it and rely on the `recipeView` unit tests + deploy smoke. Do NOT assert against a guessed callback_data string — confirm it from the plugin or the harness's captured payloads. `log()` what coverage was dropped if you remove it.

- [ ] **Step 7: Run it, verify it fails, then implement until green**

Run: `bun test tests/bot.test.ts -t "Рецепты"`
Expected: FAIL first, PASS after wiring.

- [ ] **Step 8: Run the full suite + tsc, verify green**

Run: `bun test && bunx tsc --noEmit`
Expected: PASS, tsc clean, output pristine.

- [ ] **Step 9: Commit**

```bash
git add src/bot/recipeView.ts src/bot/menus.ts tests/recipeView.test.ts tests/bot.test.ts
git commit -m "feat(ui): paginated recipe browser + dish card with lazy steps"
```

---

## Rollout (after all tasks merge)

1. PR `bot-ux` → review (subagent-driven: implementer + reviewer per task, final whole-branch) → merge to `main` (ff).
2. `./deploy.sh` to `home` (the `steps` column migration applies idempotently on startup).
3. Telegram smoke:
   - `/start` → hub buttons appear.
   - 📖 Рецепты → paginated list → tap a dish → card with ~cost (по акциям) → 📖 Показать рецепт generates+shows steps → ➕ В меню adds it.
   - `/menu` rows show `~€`; `/list` shows the per-dish breakdown + Итого.
   - Confirm Kaufland no longer appears in `/list` store groups (prod `.env`: drop `kaufland` from `STORE_WHITELIST` if set explicitly).

## Self-Review

- **Spec coverage:** UI hub + browser + card → Tasks 5, 6. Lazy recipe steps → Tasks 3, 6. Per-dish cost (card + /menu + /list) → Tasks 2, 4, 6. Remove Kaufland → Task 1. HTML/`esc` foundation → Task 5 (scoped to menu surfaces; /menu and /list stay Markdown, only appending a cost line). `@grammyjs/menu` single dep → Task 5. No new tables (only `steps` column) → Task 3.
- **Placeholder scan:** none — every code step shows complete code; the two plugin-API notes point at context7 verification for a third-party API (not a placeholder), and the browser smoke test step explicitly forbids asserting against a guessed callback_data and prescribes the fallback.
- **Type consistency:** `estimateDishCost(matcher, dish)` / `dishCostFromMatches(dish, matches)` (Task 2) consumed in Tasks 4, 6. `dishSteps`/`saveDishSteps`/`generateSteps` + `Dish.steps` (Task 3) consumed in Task 6. `esc` (Task 5) consumed in Task 6 (`recipeView`). `createMenus(deps): { main }` (Task 5) extended in Task 6. `handleMenu` becomes async with `matcher` (Task 4) — its only call site (`bot.ts` `menu` helper) and 3 tests are updated in the same task.
```
