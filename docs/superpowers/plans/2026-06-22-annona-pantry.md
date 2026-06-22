# Pantry (P2 #12) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the family declare what they already have at home (per ISO week, binary) so those ingredients are dropped from the shopping list.

**Architecture:** Mirror the existing `selection(week)` model with a new `pantry(week)` table and store. Extend the deterministic keyword prefilter with three pantry intents, add three handlers, and thread a `pantry` Set into `buildGroupedList` so matching ingredients are excluded from store groups and the missing list, with an `✅ Уже дома: …` footer.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, grammy, `bun test`.

## Global Constraints

- Runtime: Bun. Use `bun test`, `bunx tsc --noEmit`. No new dependencies.
- All DB migrations idempotent (`CREATE TABLE IF NOT EXISTS`), appended in order.
- Binary pantry (presence only), per ISO week, resets weekly. No quantity math.
- Pantry only affects `/list` — never `/digest`, menu, planner, matcher.
- Normalization is lowercase + trim; one shared helper, no duplication.
- TDD: write the failing test first, watch it fail, minimal impl, watch it pass, commit.
- Spec: `docs/superpowers/specs/2026-06-22-annona-pantry-design.md`.

---

### Task 1: Pantry table + store

**Files:**
- Modify: `src/db/migrations.ts` (append one `CREATE TABLE`)
- Create: `src/recipes/pantryStore.ts`
- Test: `tests/pantryStore.test.ts`

**Interfaces:**
- Consumes: `openDb` from `src/db/db.ts`.
- Produces:
  - `normalizePantryItem(s: string): string`
  - `getPantry(db: Database, week: string): string[]`
  - `addToPantry(db: Database, week: string, items: string[]): void`
  - `removeFromPantry(db: Database, week: string, items: string[]): void`

- [ ] **Step 1: Add the migration**

In `src/db/migrations.ts`, append a new entry to the `MIGRATIONS` array (after the `selection` table):

```ts
  `CREATE TABLE IF NOT EXISTS pantry (
     week TEXT PRIMARY KEY,
     items_json TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
```

- [ ] **Step 2: Write the failing test**

Create `tests/pantryStore.test.ts`:

```ts
import { test, expect } from "bun:test";
import { openDb } from "../src/db/db";
import {
  normalizePantryItem,
  getPantry,
  addToPantry,
  removeFromPantry,
} from "../src/recipes/pantryStore";

test("normalizePantryItem lowercases and trims", () => {
  expect(normalizePantryItem("  Рис ")).toBe("рис");
});

test("getPantry returns [] for an unknown week", () => {
  const db = openDb(":memory:");
  expect(getPantry(db, "2026-W26")).toEqual([]);
});

test("addToPantry normalizes, unions, dedupes and preserves order", () => {
  const db = openDb(":memory:");
  addToPantry(db, "2026-W26", ["Рис", "лук"]);
  addToPantry(db, "2026-W26", ["лук", "соль"]);
  expect(getPantry(db, "2026-W26")).toEqual(["рис", "лук", "соль"]);
});

test("removeFromPantry removes only matching items (normalized)", () => {
  const db = openDb(":memory:");
  addToPantry(db, "2026-W26", ["рис", "лук", "соль"]);
  removeFromPantry(db, "2026-W26", ["Лук"]);
  expect(getPantry(db, "2026-W26")).toEqual(["рис", "соль"]);
});

test("removeFromPantry on an unknown week is a no-op", () => {
  const db = openDb(":memory:");
  removeFromPantry(db, "2026-W26", ["рис"]);
  expect(getPantry(db, "2026-W26")).toEqual([]);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/pantryStore.test.ts`
Expected: FAIL — `Cannot find module '../src/recipes/pantryStore'`.

- [ ] **Step 4: Write minimal implementation**

Create `src/recipes/pantryStore.ts`:

```ts
import type { Database } from "bun:sqlite";

/** Normalize a pantry term so matching is case/space-insensitive. */
export function normalizePantryItem(s: string): string {
  return s.trim().toLowerCase();
}

/** Return the normalized pantry items for an ISO week, or [] if none. */
export function getPantry(db: Database, week: string): string[] {
  const row = db
    .query("SELECT items_json FROM pantry WHERE week = ?")
    .get(week) as { items_json: string } | null;
  return row ? (JSON.parse(row.items_json) as string[]) : [];
}

function save(db: Database, week: string, items: string[]): void {
  db.run(
    "INSERT OR REPLACE INTO pantry(week, items_json, updated_at) VALUES(?, ?, ?)",
    [week, JSON.stringify(items), new Date().toISOString()]
  );
}

/** Merge normalized items into the week's pantry (union, dedupe, first-seen order). */
export function addToPantry(db: Database, week: string, items: string[]): void {
  const merged = [...getPantry(db, week)];
  for (const raw of items) {
    const item = normalizePantryItem(raw);
    if (item && !merged.includes(item)) merged.push(item);
  }
  save(db, week, merged);
}

/** Remove normalized items from the week's pantry. No-op if absent. */
export function removeFromPantry(db: Database, week: string, items: string[]): void {
  const current = getPantry(db, week);
  if (current.length === 0) return;
  const remove = new Set(items.map(normalizePantryItem));
  save(db, week, current.filter((i) => !remove.has(i)));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/pantryStore.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations.ts src/recipes/pantryStore.ts tests/pantryStore.test.ts
git commit -m "feat(pantry): per-week pantry table + store"
```

---

### Task 2: Pantry intents in the router

**Files:**
- Modify: `src/types.ts` (extend `IntentKind`)
- Modify: `src/bot/router.ts` (add patterns + branches)
- Test: `tests/router.test.ts` (append)

**Interfaces:**
- Consumes: `Intent`, `routeMessage` from existing code.
- Produces: `routeMessage` now returns `{ kind: "add_pantry" | "remove_pantry" | "show_pantry", dishNames: string[] }` for the new patterns.

- [ ] **Step 1: Extend the IntentKind union**

In `src/types.ts`, add the three kinds to `IntentKind` (after `"delete_dish"`):

```ts
  | "add_pantry"
  | "remove_pantry"
  | "show_pantry"
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/router.test.ts`:

```ts
test("routes 'у меня есть X, Y' to add_pantry", () => {
  expect(routeMessage("у меня есть рис, лук")).toEqual({
    kind: "add_pantry",
    dishNames: ["рис", "лук"],
  });
});

test("routes 'есть дома X' to add_pantry", () => {
  expect(routeMessage("есть дома масло")).toEqual({ kind: "add_pantry", dishNames: ["масло"] });
});

test("routes 'закончился X' to remove_pantry (not remove_dishes)", () => {
  expect(routeMessage("закончился рис")).toEqual({ kind: "remove_pantry", dishNames: ["рис"] });
});

test("routes 'убери из дома X' to remove_pantry (before remove_dishes)", () => {
  expect(routeMessage("убери из дома лук")).toEqual({ kind: "remove_pantry", dishNames: ["лук"] });
});

test("routes bare '/pantry' and 'что дома' to show_pantry", () => {
  expect(routeMessage("/pantry")).toEqual({ kind: "show_pantry", dishNames: [] });
  expect(routeMessage("что дома")).toEqual({ kind: "show_pantry", dishNames: [] });
});

test("'убери борщ' (no 'из дома') still routes to remove_dishes", () => {
  expect(routeMessage("убери борщ")).toEqual({ kind: "remove_dishes", dishNames: ["борщ"] });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/router.test.ts`
Expected: FAIL — `add_pantry`/`remove_pantry`/`show_pantry` not produced.

- [ ] **Step 4: Add the patterns and branches**

In `src/bot/router.ts`, add the pattern constants after the existing `ADD_CUSTOM`/`ADD` constants:

```ts
const SHOW_PANTRY = [/^\/pantry$/i, /^что\s+(есть\s+)?дома\??$/i];
const ADD_PANTRY = [/^у\s+меня\s+есть\s+(.+)$/i, /^есть\s+дома\s+(.+)$/i, /^дома\s+есть\s+(.+)$/i, /^\/pantry\s+(.+)$/i];
const REMOVE_PANTRY = [/^закончил(?:ся|ась|ись)\s+(.+)$/i, /^убери\s+из\s+дома\s+(.+)$/i];
```

Then, inside `routeMessage`, add these blocks **before** the `DELETE_CUSTOM` loop (so pantry verbs win over `убери X`):

```ts
  for (const re of SHOW_PANTRY) {
    if (re.test(t)) return { kind: "show_pantry", dishNames: [] };
  }

  for (const re of ADD_PANTRY) {
    const m = t.match(re);
    if (m) {
      const n = names(m[1]!);
      return n.length ? { kind: "add_pantry", dishNames: n } : null;
    }
  }

  for (const re of REMOVE_PANTRY) {
    const m = t.match(re);
    if (m) {
      const n = names(m[1]!);
      return n.length ? { kind: "remove_pantry", dishNames: n } : null;
    }
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/router.test.ts`
Expected: PASS (all, including the existing ones).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/bot/router.ts tests/router.test.ts
git commit -m "feat(pantry): route add/remove/show pantry intents"
```

---

### Task 3: Pantry handlers

**Files:**
- Modify: `src/bot/handlers.ts` (add three handlers + import)
- Test: `tests/handlers.test.ts` (append)

**Interfaces:**
- Consumes: `getPantry`, `addToPantry`, `removeFromPantry` from `src/recipes/pantryStore.ts`.
- Produces:
  - `handleAddPantry(deps: { db: Database; week: string }, names: string[]): string`
  - `handleRemovePantry(deps: { db: Database; week: string }, names: string[]): string`
  - `handleShowPantry(deps: { db: Database; week: string }): string`

- [ ] **Step 1: Write the failing tests**

Append to `tests/handlers.test.ts` (the file already imports `openDb`):

```ts
import {
  handleAddPantry, handleRemovePantry, handleShowPantry,
} from "../src/bot/handlers";
import { getPantry } from "../src/recipes/pantryStore";

test("handleAddPantry stores normalized items and confirms", () => {
  const db = openDb(":memory:");
  const text = handleAddPantry({ db, week: "2026-W26" }, ["Рис", "лук"]);
  expect(getPantry(db, "2026-W26")).toEqual(["рис", "лук"]);
  expect(text).toContain("рис");
});

test("handleAddPantry prompts when given no items", () => {
  const db = openDb(":memory:");
  const text = handleAddPantry({ db, week: "2026-W26" }, []);
  expect(getPantry(db, "2026-W26")).toEqual([]);
  expect(text.toLowerCase()).toContain("что");
});

test("handleRemovePantry removes the named item", () => {
  const db = openDb(":memory:");
  handleAddPantry({ db, week: "2026-W26" }, ["рис", "лук"]);
  const text = handleRemovePantry({ db, week: "2026-W26" }, ["рис"]);
  expect(getPantry(db, "2026-W26")).toEqual(["лук"]);
  expect(text).toContain("рис");
});

test("handleShowPantry lists items or reports empty", () => {
  const db = openDb(":memory:");
  expect(handleShowPantry({ db, week: "2026-W26" }).toLowerCase()).toContain("ничего");
  handleAddPantry({ db, week: "2026-W26" }, ["рис"]);
  expect(handleShowPantry({ db, week: "2026-W26" })).toContain("рис");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/handlers.test.ts`
Expected: FAIL — pantry handlers not exported.

- [ ] **Step 3: Implement the handlers**

In `src/bot/handlers.ts`, add to the imports near the top:

```ts
import { getPantry, addToPantry, removeFromPantry } from "../recipes/pantryStore";
```

Append the handlers at the end of the file:

```ts
type PantryDeps = { db: Database; week: string };

/** Add free-text items to the week's pantry. */
export function handleAddPantry(deps: PantryDeps, names: string[]): string {
  const items = names.map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) return "Что у тебя есть дома? Например: «у меня есть рис, лук».";
  addToPantry(deps.db, deps.week, items);
  return `✅ Дома есть: ${items.join(", ")}. Учту в /list.`;
}

/** Remove items from the week's pantry. */
export function handleRemovePantry(deps: PantryDeps, names: string[]): string {
  const items = names.map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) return "Что закончилось? Например: «закончился рис».";
  removeFromPantry(deps.db, deps.week, items);
  return `✅ Убрал из дома: ${items.join(", ")}.`;
}

/** Show the week's pantry. */
export function handleShowPantry(deps: PantryDeps): string {
  const items = getPantry(deps.db, deps.week);
  if (items.length === 0) return "Дома пока ничего не отмечено. Напиши «у меня есть рис, лук».";
  return `🏠 Дома есть: ${items.join(", ")}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bot/handlers.ts tests/handlers.test.ts
git commit -m "feat(pantry): add/remove/show pantry handlers"
```

---

### Task 4: Exclude pantry from the shopping list

**Files:**
- Modify: `src/types.ts` (`GroupedShoppingList.inPantry`)
- Modify: `src/shoppingList.ts` (`pantry` param + skip + `inPantry`)
- Test: `tests/shoppingList.test.ts` (append)

**Interfaces:**
- Consumes: `normalizePantryItem` from `src/recipes/pantryStore.ts`; `scaleIngredients`.
- Produces: `buildGroupedList(dishes, matcher, plz, targetServings?, pantry?: Set<string>)` now returns `{ groups, missing, inPantry: string[] }`.

- [ ] **Step 1: Extend the GroupedShoppingList type**

In `src/types.ts`, change:

```ts
export type GroupedShoppingList = { groups: StoreGroup[]; missing: string[] };
```

to:

```ts
export type GroupedShoppingList = { groups: StoreGroup[]; missing: string[]; inPantry: string[] };
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/shoppingList.test.ts` (uses the existing `offer`, `dishOf`, `oneOffer` helpers):

```ts
test("buildGroupedList excludes pantry ingredients from groups and missing", async () => {
  const d = dishOf(4, [
    { canonical: "рис", qty: 1, unit: "кг" },
    { canonical: "мясо", qty: 1, unit: "кг" },
  ]);
  const list = await buildGroupedList([d], oneOffer, 30459, 4, new Set(["рис"]));
  const shown = list.groups.flatMap((g) => g.items.map((i) => i.ingredient));
  expect(shown).not.toContain("рис");
  expect(shown).toContain("мясо");
  expect(list.inPantry).toEqual(["рис"]);
});

test("buildGroupedList pantry match is case-insensitive and keeps inPantry distinct", async () => {
  const d = dishOf(4, [{ canonical: "Лук", qty: 1, unit: "шт" }]);
  const list = await buildGroupedList([d, d], oneOffer, 30459, 4, new Set(["лук"]));
  expect(list.groups.flatMap((g) => g.items.map((i) => i.ingredient))).toEqual([]);
  expect(list.inPantry).toEqual(["Лук"]);
});

test("buildGroupedList without a pantry returns an empty inPantry", async () => {
  const d = dishOf(4, [{ canonical: "рис", qty: 1, unit: "кг" }]);
  const list = await buildGroupedList([d], oneOffer, 30459, 4);
  expect(list.inPantry).toEqual([]);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/shoppingList.test.ts`
Expected: FAIL — `inPantry` undefined / pantry not excluded.

- [ ] **Step 4: Implement the pantry filter**

In `src/shoppingList.ts`, add the import at the top:

```ts
import { normalizePantryItem } from "./recipes/pantryStore";
```

Change the signature. Replace the function signature line:

```ts
export async function buildGroupedList(
  dishes: Dish[],
  matcher: Matcher,
  plz: number,
  targetServings?: number,
  pantry?: Set<string>
): Promise<GroupedShoppingList> {
```

Immediately after the `const agg = new Map<string, Map<string, Bucket>>();` line, add:

```ts
  const inPantrySeen = new Map<string, string>(); // normalized → original casing (distinct)
```

Inside the `for (const ing of scaled)` loop, add this skip at the very top of the loop body (before any bucketing):

```ts
      const norm = normalizePantryItem(ing.canonical);
      if (pantry && pantry.has(norm)) {
        if (!inPantrySeen.has(norm)) inPantrySeen.set(norm, ing.canonical);
        continue;
      }
```

Finally, change the return statement:

```ts
  return { groups: [...groups.values()], missing, inPantry: [...inPantrySeen.values()] };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/shoppingList.test.ts`
Expected: PASS (including the existing tests — older tests don't read `inPantry`, so they're unaffected).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/shoppingList.ts tests/shoppingList.test.ts
git commit -m "feat(pantry): exclude pantry ingredients from the shopping list"
```

---

### Task 5: Wire pantry into /list output

**Files:**
- Modify: `src/bot/handlers.ts` (`handleList`)
- Test: `tests/handlers.test.ts` (append)

**Interfaces:**
- Consumes: `getPantry` (already imported in Task 3), `buildGroupedList` (now returns `inPantry`).
- Produces: `handleList` reply appends an `✅ Уже дома: …` footer when the pantry hid ingredients.

- [ ] **Step 1: Write the failing test**

Append to `tests/handlers.test.ts`:

```ts
import { addToPantry } from "../src/recipes/pantryStore";

test("handleList hides pantry ingredients and shows an 'Уже дома' footer", async () => {
  const db = openDb(":memory:");
  const dish: Dish = {
    nameRu: "Плов", nameUa: null, nameDe: null, cuisine: "ru", course: "second",
    keepsDays: 3, tags: [], servings: 4,
    ingredients: [{ canonical: "рис", qty: 1, unit: "кг" }, { canonical: "мясо", qty: 1, unit: "кг" }],
  };
  const id = insertDish(db, dish);
  saveSelection(db, "2026-W26", [id]);
  addToPantry(db, "2026-W26", ["рис"]);
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient(c) {
      return { externalId: 1, store: "aldi", storeName: "Aldi", product: c, price: 1, oldPrice: null, referencePrice: null, unit: "kg", validFrom: "", validTo: "" };
    },
  };
  const text = await handleList({ db, dishes: [{ ...dish, id }], matcher, week: "2026-W26", plz: 30459 });
  expect(text).toContain("Уже дома");
  expect(text).toContain("рис");
  expect(text).toContain("мясо");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/handlers.test.ts`
Expected: FAIL — no "Уже дома" footer.

- [ ] **Step 3: Implement the footer**

In `src/bot/handlers.ts`, inside `handleList`, change the `buildGroupedList` call to read pantry and pass it:

```ts
  const pantry = new Set(getPantry(deps.db, deps.week));
  const { groups, missing, inPantry } = await buildGroupedList(chosen, deps.matcher, deps.plz, household, pantry);
```

Then, just before `return lines.join("\n");`, add:

```ts
  if (inPantry.length) lines.push(`\n✅ Уже дома: ${inPantry.join(", ")}`);
```

(Leave the existing `if (groups.length === 0 && missing.length === 0)` empty-list guard as-is.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bot/handlers.ts tests/handlers.test.ts
git commit -m "feat(pantry): /list footer for ingredients already at home"
```

---

### Task 6: Bot wiring + integration

**Files:**
- Modify: `src/bot/bot.ts` (switch cases, `/pantry` command, help line)
- Test: `tests/bot.test.ts` (append)

**Interfaces:**
- Consumes: `handleAddPantry`, `handleRemovePantry`, `handleShowPantry` from handlers; `getPantry` + `saveSelection` for the integration assertions.
- Produces: free-text and `/pantry` pantry interactions reach the handlers; `/list` reflects the pantry.

- [ ] **Step 1: Write the failing integration tests**

Append to `tests/bot.test.ts` (uses the existing `harness`, `textUpdate`, `lastText`, `USER`, `llmResolve`). Add these imports at the top of the file:

```ts
import { getPantry } from "../src/recipes/pantryStore";
import { saveSelection } from "../src/recipes/selectionStore";
```

Then the tests:

```ts
test("'у меня есть рис' persists to the week's pantry", async () => {
  const db = openDb(":memory:");
  const { bot } = harness(db, [], llmResolve([]));
  await bot.handleUpdate(textUpdate("у меня есть рис"));
  expect(getPantry(db, isoWeek(new Date()))).toContain("рис");
});

test("pantry ingredients are hidden from /list", async () => {
  const db = openDb(":memory:");
  const dish: Dish = {
    nameRu: "Плов", nameUa: null, nameDe: null, cuisine: "ru", course: "second",
    keepsDays: 3, tags: [], servings: 4,
    ingredients: [{ canonical: "рис", qty: 1, unit: "кг" }, { canonical: "мясо", qty: 1, unit: "кг" }],
  };
  const id = insertDish(db, dish);
  saveSelection(db, isoWeek(new Date()), [id]); // select directly — avoids the LLM classify path
  const matcher: Matcher = {
    async searchTerms() { return []; },
    async matchIngredient(c) {
      return { externalId: 1, store: "aldi", storeName: "Aldi", product: c, price: 1, oldPrice: null, referencePrice: null, unit: "kg", validFrom: "", validTo: "" };
    },
  };
  const { bot, sent } = harness(db, [{ ...dish, id }], llmResolve([id]), matcher);
  await bot.handleUpdate(textUpdate("у меня есть рис"));
  await bot.handleUpdate(textUpdate("/list"));
  const out = lastText(sent);
  expect(out).toContain("Уже дома");
  expect(out).toContain("мясо");
});
```

Note: `/list` is a slash command. grammy matches `bot.command` via the message's bot_command entity. To make `textUpdate("/list")` trigger it, the existing `textUpdate` helper produces a plain-text message without entities — but the bot's `message:text` handler is not what serves `/list`; `bot.command("list")` is. grammy's command plugin matches on text starting with `/` even without entities in current versions, so `textUpdate("/list")` works. If it does not match in your grammy version, add an `entities: [{ type: "bot_command", offset: 0, length: 5 }]` field to the message object built by `textUpdate` for command strings.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/bot.test.ts`
Expected: FAIL — pantry not wired into the bot.

- [ ] **Step 3: Wire the handlers**

In `src/bot/bot.ts`:

Add to the handlers import block:

```ts
  handleAddPantry,
  handleRemovePantry,
  handleShowPantry,
```

Add the three switch cases inside `message:text` (next to the other cases):

```ts
      case "add_pantry":
        await reply(ctx, handleAddPantry({ db: deps.db, week: week() }, intent.dishNames));
        break;
      case "remove_pantry":
        await reply(ctx, handleRemovePantry({ db: deps.db, week: week() }, intent.dishNames));
        break;
      case "show_pantry":
        await reply(ctx, handleShowPantry({ db: deps.db, week: week() }));
        break;
```

Add the `/pantry` command near the other commands:

```ts
  bot.command("pantry", guard((ctx) => {
    const arg = matchText(ctx);
    const msg = arg.trim()
      ? handleAddPantry({ db: deps.db, week: week() }, arg.split(",").map((s) => s.trim()).filter(Boolean))
      : handleShowPantry({ db: deps.db, week: week() });
    return reply(ctx, msg);
  }));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/bot.test.ts`
Expected: PASS.

- [ ] **Step 5: Add a help line**

In `src/bot/handlers.ts`, inside `helpText()`, add after the custom-dish lines:

```ts
    "• «у меня есть рис, лук» — учту дома, уберу из списка.",
```

- [ ] **Step 6: Full verification**

Run: `bun test` (expect all green) and `bunx tsc --noEmit` (expect no output).

- [ ] **Step 7: Commit**

```bash
git add src/bot/bot.ts src/bot/handlers.ts tests/bot.test.ts
git commit -m "feat(pantry): wire pantry intents + /pantry command into the bot"
```

---

## Self-Review

- **Spec coverage:** §4.1 store+migration → Task 1; §4.2 router+types → Task 2; §4.3 handlers → Task 3; §4.4 shoppingList filter+inPantry → Task 4; §4.4 handleList footer → Task 5; §4.5 bot wiring → Task 6; §7 tests distributed across all tasks. All covered.
- **Placeholder scan:** every code step contains full code; no TBD/TODO.
- **Type consistency:** `normalizePantryItem`, `getPantry`, `addToPantry`, `removeFromPantry` defined in Task 1, consumed by Tasks 3/4/5; `GroupedShoppingList.inPantry` defined in Task 4, consumed in Task 5; `buildGroupedList`'s new `pantry?: Set<string>` param matches its `handleList` caller.
- **Deploy:** after Task 6, deploy with `./deploy.sh` (clean+pushed guards apply) and verify the container is `Up`.
