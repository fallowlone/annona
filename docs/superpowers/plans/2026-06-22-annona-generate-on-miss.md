# Generate-on-miss dish recognition + CIS classics seed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user lists a dish that is not in the catalogue, offer to generate its recipe (confirm ✅/❌), persist it, and add it to the week — plus guarantee CIS classics in the seed.

**Architecture:** `resolveDishes` already returns matched + unmatched. We surface `unmatched` from the selection handlers, and `bot.ts` drives a per-user confirm **queue** that generates each unmatched dish via the existing `generateDish`, persists confirmed ones, and adds them to the current ISO week. Recipe-generation logic lives in `handlers.ts` (`generateForSelection`, `saveDishToWeek`); `bot.ts` only orchestrates and holds the queue state. A separate `seedClassics` guarantees CIS staples without touching the existing `seedDishes`.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, grammy, Anthropic (Haiku) structured tool-use, Zod.

## Global Constraints

- Default to Bun: `bun test`, `bun:sqlite`, grammy. No `node`, no new runtime deps.
- No external recipe API.
- No new database schema or tables.
- No new dependencies.
- No auto-generation without confirmation (confirm-first to guard against typos / non-dishes).
- No change to the standalone `/recipe` custom-dish flow (its `dish_save` / `dish_cancel` callbacks stay as-is).
- All user-facing strings in Russian.
- Immutable update patterns; `bunx tsc --noEmit` clean and `bun test` green before every commit.
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit.

---

### Task 1: Selection handlers expose `unmatched` (`SelectResult`)

`handleSelect` / `handleAddDishes` currently fold unmatched names into a `Не нашёл:` text tail and drop them. Change them to return `{ text, unmatched }` so the bot can drive generation. `bot.ts` is updated to keep current UX for now (a `replyNamesResult` helper that re-appends the `Не нашёл:` tail) — Task 4 swaps that helper's body for the queue.

**Files:**
- Modify: `src/bot/handlers.ts` (`handleSelect` ~89-103, `handleAddDishes` ~171-179)
- Modify: `src/bot/bot.ts` (call sites: `select_dishes` ~164-166, `add_dishes` ~167-169, `/add` command ~148)
- Test: `tests/handlers.test.ts` (update the two existing tests)

**Interfaces:**
- Produces: `export type SelectResult = { text: string; unmatched: string[] }`
- Produces: `handleSelect(deps, dishNames): Promise<SelectResult>`
- Produces: `handleAddDishes(deps, dishNames): Promise<SelectResult>`
- `handleRemoveDishes` is unchanged (still returns `Promise<string>`).

- [ ] **Step 1: Update the two failing tests**

In `tests/handlers.test.ts`, replace the body of `"handleSelect resolves names, saves the selection, and confirms"` (~110-120) with:

```ts
test("handleSelect resolves names, saves the selection, and reports unmatched separately", async () => {
  const db = openDb(":memory:");
  const id1 = insertDish(db, borsch);
  const id2 = insertDish(db, plov);
  const dishes = [{ ...borsch, id: id1 }, { ...plov, id: id2 }];
  const llm: Llm = { async structured() { return { matchedIds: [id1, id2], unmatched: ["суши"] } as never; } };
  const res = await handleSelect({ llm, db, dishes, week: "2026-W26" }, ["борщ", "плов", "суши"]);
  expect(res.text).toContain("Борщ");
  expect(res.text).toContain("Плов");
  expect(res.text).not.toContain("суши");
  expect(res.unmatched).toEqual(["суши"]);
});
```

And replace the body of `"handleAddDishes merges into the existing selection without replacing it"` (~155-164) with:

```ts
test("handleAddDishes merges into the existing selection without replacing it", async () => {
  const db = openDb(":memory:");
  const id1 = insertDish(db, borsch);
  const id2 = insertDish(db, plov);
  const dishes = [{ ...borsch, id: id1 }, { ...plov, id: id2 }];
  saveSelection(db, "2026-W26", [id1]);
  const res = await handleAddDishes({ llm: llmResolve([id2]), db, dishes, week: "2026-W26" }, ["плов"]);
  expect(getSelection(db, "2026-W26")).toEqual([id1, id2]);
  expect(res.text).toContain("Плов");
  expect(res.unmatched).toEqual([]);
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `bun test tests/handlers.test.ts`
Expected: FAIL — `res.text`/`res.unmatched` undefined (handlers still return a string).

- [ ] **Step 3: Change the handlers to return `SelectResult`**

In `src/bot/handlers.ts`, add the type just above `handleSelect` (after the `NO_SELECTION` const ~70):

```ts
export type SelectResult = { text: string; unmatched: string[] };
```

Replace `handleSelect` (~88-103) with:

```ts
/** Resolve free-text dish names to catalogue ids, persist them for the week, confirm. */
export async function handleSelect(
  deps: { llm: Llm; db: Database; dishes: Dish[]; week: string },
  dishNames: string[]
): Promise<SelectResult> {
  const { matched, unmatched } = await resolveDishes(deps.llm, deps.dishes, dishNames);
  if (matched.length === 0 && unmatched.length === 0) {
    return { text: "Не понял, какие блюда добавить. " + NO_SELECTION, unmatched: [] };
  }
  if (matched.length === 0) return { text: "", unmatched };
  saveSelection(deps.db, deps.week, matched.map((d) => d.id as number));
  const names = matched.map((d) => d.nameRu).join(", ");
  const text = `Записал на эту неделю: ${names}.\n\n/menu — меню на неделю · /list — список покупок.`;
  return { text, unmatched };
}
```

Replace `handleAddDishes` (~170-179) with:

```ts
/** Resolve names and merge them into the week's selection (keeps the rest). */
export async function handleAddDishes(deps: EditDeps, dishNames: string[]): Promise<SelectResult> {
  const { matched, unmatched } = await resolveDishes(deps.llm, deps.dishes, dishNames);
  if (matched.length === 0 && unmatched.length === 0) {
    return { text: "Не понял, какие блюда добавить. " + NO_SELECTION, unmatched: [] };
  }
  if (matched.length > 0) {
    addToSelection(deps.db, deps.week, matched.map((d) => d.id as number));
  }
  const text =
    matched.length > 0
      ? `✅ Добавил: ${matched.map((d) => d.nameRu).join(", ")}.\n\n/menu — меню · /list — список покупок.`
      : "";
  return { text, unmatched };
}
```

- [ ] **Step 4: Update `bot.ts` call sites to keep current UX (interim)**

In `src/bot/bot.ts`, add a helper just after the `removeDishes` const (~89). This is the seam Task 4 rewrites:

```ts
  const replyNamesResult = async (ctx: Context, res: SelectResult): Promise<void> => {
    let msg = res.text;
    if (res.unmatched.length) msg += (msg ? "\n" : "") + `Не нашёл: ${res.unmatched.join(", ")}.`;
    if (msg) await reply(ctx, msg);
  };
```

Add `SelectResult` to the handlers import (~6-23): add `SelectResult,` to the import list.

Replace the `/add` command (~148):

```ts
  bot.command("add", guard(async (ctx) => replyNamesResult(ctx, await addDishes(parseNames(matchText(ctx))))));
```

Replace the `select_dishes` case (~164-166):

```ts
      case "select_dishes":
        await replyNamesResult(ctx, await handleSelect({ llm: deps.llm, db: deps.db, dishes, week: week() }, intent.dishNames));
        break;
```

Replace the `add_dishes` case (~167-169):

```ts
      case "add_dishes":
        await replyNamesResult(ctx, await addDishes(intent.dishNames));
        break;
```

- [ ] **Step 5: Run the full suite + tsc, verify green**

Run: `bun test && bunx tsc --noEmit`
Expected: PASS (190+ tests), tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/bot/handlers.ts src/bot/bot.ts tests/handlers.test.ts
git commit -m "refactor(select): handlers return matched text + unmatched names"
```

---

### Task 2: `dishIdByName` lookup helper

A small read helper to resolve a catalogue dish id by `name_ru` case-insensitively. Used by Task 3's generation helpers.

**Files:**
- Modify: `src/recipes/recipeStore.ts` (add near `listDishes`/`getIngredients` ~128-138)
- Test: `tests/recipeStore.test.ts`

**Interfaces:**
- Produces: `export function dishIdByName(db: Database, name: string): number | null`

- [ ] **Step 1: Write the failing test**

Add to `tests/recipeStore.test.ts` (import `dishIdByName` in the top import from `recipeStore`):

```ts
test("dishIdByName finds a dish case-insensitively, null when absent", () => {
  const db = openDb(":memory:");
  const id = insertDish(db, borscht);
  expect(dishIdByName(db, "борщ")).toBe(id);
  expect(dishIdByName(db, "БОРЩ")).toBe(id);
  expect(dishIdByName(db, "суши")).toBeNull();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bun test tests/recipeStore.test.ts -t "dishIdByName"`
Expected: FAIL — `dishIdByName is not a function`.

- [ ] **Step 3: Implement `dishIdByName`**

Add to `src/recipes/recipeStore.ts` after `getIngredients` (~138):

```ts
/** Return the id of a catalogue dish by name_ru (case-insensitive), or null. */
export function dishIdByName(db: Database, name: string): number | null {
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM dishes WHERE lower(name_ru) = lower(?)")
    .get(name);
  return row ? row.id : null;
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `bun test tests/recipeStore.test.ts -t "dishIdByName"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recipes/recipeStore.ts tests/recipeStore.test.ts
git commit -m "feat(recipes): dishIdByName lookup helper"
```

---

### Task 3: `generateForSelection` + `saveDishToWeek` in handlers

The recipe-generation logic for the miss path. `generateForSelection` generates a dish from a name; if its canonical name already exists in the catalogue, it adds that existing dish to the week and reports `"added"`; otherwise it returns a `"preview"` (no persistence). `saveDishToWeek` persists a previewed dish idempotently and adds it to the week.

**Files:**
- Modify: `src/bot/handlers.ts` (add after `confirmCustomDish` ~229; import `dishIdByName`)
- Test: `tests/handlers.test.ts`

**Interfaces:**
- Consumes: `dishIdByName` (Task 2), `generateDish`/`insertDish` (existing), `addToSelection` (existing import), `renderDishPreview` (existing private fn)
- Produces:
  - `export type GenOutcome = { status: "preview"; dish: Dish; text: string } | { status: "added"; nameRu: string }`
  - `export async function generateForSelection(deps: { llm: Llm; db: Database; week: string }, name: string): Promise<GenOutcome>`
  - `export function saveDishToWeek(deps: { db: Database }, dish: Dish, week: string): void`

- [ ] **Step 1: Write the failing tests**

Add to `tests/handlers.test.ts` (reuses `borsch`, `plov`, `llmDish`, `getSelection`, `listDishes` already imported):

```ts
test("generateForSelection previews a brand-new dish without persisting", async () => {
  const db = openDb(":memory:");
  const sol: Dish = { nameRu: "Солянка", nameUa: null, nameDe: null, cuisine: "ru", course: "first", keepsDays: 3, tags: [], servings: 6, ingredients: [{ canonical: "колбаса", qty: 300, unit: "г" }] };
  const res = await generateForSelection({ llm: llmDish(sol), db, week: "2026-W26" }, "солянка");
  expect(res.status).toBe("preview");
  if (res.status === "preview") expect(res.text).toContain("Солянка");
  expect(listDishes(db)).toHaveLength(0);
  expect(getSelection(db, "2026-W26")).toBeNull();
});

test("generateForSelection adds an already-catalogued dish to the week", async () => {
  const db = openDb(":memory:");
  const id = insertDish(db, borsch); // "Борщ"
  const res = await generateForSelection({ llm: llmDish({ ...borsch }), db, week: "2026-W26" }, "борщец");
  expect(res.status).toBe("added");
  if (res.status === "added") expect(res.nameRu).toBe("Борщ");
  expect(getSelection(db, "2026-W26")).toEqual([id]);
  expect(listDishes(db)).toHaveLength(1); // no duplicate inserted
});

test("saveDishToWeek inserts a new dish and adds it to the week", () => {
  const db = openDb(":memory:");
  const sol: Dish = { nameRu: "Солянка", nameUa: null, nameDe: null, cuisine: "ru", course: "first", keepsDays: 3, tags: [], servings: 6, ingredients: [{ canonical: "колбаса", qty: 300, unit: "г" }] };
  saveDishToWeek({ db }, sol, "2026-W26");
  const id = listDishes(db).find((d) => d.nameRu === "Солянка")!.id!;
  expect(getSelection(db, "2026-W26")).toEqual([id]);
});

test("saveDishToWeek is idempotent on name_ru", () => {
  const db = openDb(":memory:");
  const id = insertDish(db, borsch);
  saveDishToWeek({ db }, { ...borsch }, "2026-W26");
  expect(listDishes(db).filter((d) => d.nameRu === "Борщ")).toHaveLength(1);
  expect(getSelection(db, "2026-W26")).toEqual([id]);
});
```

Add `generateForSelection, saveDishToWeek` to the handlers import at the top of the test file.

- [ ] **Step 2: Run them, verify they fail**

Run: `bun test tests/handlers.test.ts -t "generateForSelection"`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement the helpers**

In `src/bot/handlers.ts`, extend the recipeStore import (~12) to include `dishIdByName`:

```ts
import { generateDish, insertDish, deleteDish, dishIdByName } from "../recipes/recipeStore";
```

Add after `confirmCustomDish` (~229):

```ts
export type GenOutcome =
  | { status: "preview"; dish: Dish; text: string }
  | { status: "added"; nameRu: string };

/**
 * Generate a dish from a free-text name for the weekly-selection miss path.
 * If the generated dish's canonical name already exists in the catalogue, add
 * that existing dish to the week and report "added"; otherwise return a preview
 * (nothing persisted) for the user to confirm.
 */
export async function generateForSelection(
  deps: { llm: Llm; db: Database; week: string },
  name: string
): Promise<GenOutcome> {
  const dish = await generateDish(deps.llm, name);
  const existingId = dishIdByName(deps.db, dish.nameRu);
  if (existingId !== null) {
    addToSelection(deps.db, deps.week, [existingId]);
    return { status: "added", nameRu: dish.nameRu };
  }
  return { status: "preview", dish, text: renderDishPreview(dish) };
}

/** Persist a previewed dish (idempotent by name_ru) and add it to the week's selection. */
export function saveDishToWeek(deps: { db: Database }, dish: Dish, week: string): void {
  const id = dishIdByName(deps.db, dish.nameRu) ?? insertDish(deps.db, dish);
  addToSelection(deps.db, week, [id]);
}
```

- [ ] **Step 4: Run them, verify they pass**

Run: `bun test tests/handlers.test.ts -t "generateForSelection" && bun test tests/handlers.test.ts -t "saveDishToWeek"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bot/handlers.ts tests/handlers.test.ts
git commit -m "feat(select): generateForSelection + saveDishToWeek helpers"
```

---

### Task 4: Generate-on-miss queue wiring in `bot.ts`

Replace the interim `Не нашёл:` tail with a per-user confirm queue. Unmatched names are offered one at a time: generate → preview with ✅/❌. Confirmed dishes persist and join the week; cancelled ones are skipped; generation failures are skipped and reported. A final summary closes the queue.

**Files:**
- Modify: `src/bot/bot.ts` (rewrite `replyNamesResult`; add queue state, helpers, and `gen_yes`/`gen_no` callbacks; pass `week()` through)
- Test: `tests/bot.test.ts`

**Interfaces:**
- Consumes: `SelectResult`, `generateForSelection`, `saveDishToWeek` (Tasks 1/3), `listDishes` (existing).
- Produces: bot callbacks `gen_yes` / `gen_no`; in-memory `pendingGen` queue.

- [ ] **Step 1: Write the failing tests**

Add to `tests/bot.test.ts`. First add a callback-update helper and a combined LLM mock near the top helpers (~25):

```ts
let cbId = 0;
function callbackUpdate(data: string, from = USER) {
  cbId += 1;
  return {
    update_id: 10000 + cbId,
    callback_query: {
      id: "cb" + cbId,
      from: { id: from, is_bot: false, first_name: "U" },
      chat_instance: "ci",
      message: { message_id: 1, date: 0, chat: { id: from, type: "private" }, from: { id: 1, is_bot: true, first_name: "T" }, text: "preview" },
      data,
    },
  } as never;
}

// resolve_dishes → {matchedIds, unmatched}; save_dish → {dish: byName(<name>)}
function llmResolveAndGen(matchedIds: number[], unmatched: string[], byName: (name: string) => Dish): Llm {
  return {
    async structured(args: { toolName?: string; prompt?: string }) {
      if (args.toolName === "save_dish") {
        const m = String(args.prompt).match(/the single dish "([^"]+)"/);
        return { dish: byName(m?.[1] ?? "") } as never;
      }
      return { matchedIds, unmatched } as never; // resolve_dishes
    },
  };
}

const dish = (nameRu: string): Dish => ({
  nameRu, nameUa: null, nameDe: null, cuisine: "ru", course: "second",
  keepsDays: 2, tags: [], servings: 4, ingredients: [{ canonical: "соль", qty: null, unit: null }],
});
```

Then add the tests:

```ts
test("listing a dish not in the catalogue offers to generate it; ✅ adds it to week + catalogue", async () => {
  const db = openDb(":memory:");
  const { bot, sent } = harness(db, [], llmResolveAndGen([], ["солянка"], () => dish("Солянка")));
  await bot.handleUpdate(textUpdate("добавь солянка"));
  const preview = sent.find((s) => s.method === "sendMessage" && String(s.payload.text).includes("Солянка") && s.payload.reply_markup);
  expect(preview).toBeDefined();           // preview with ✅/❌
  expect(listDishes(db)).toHaveLength(0);  // nothing saved yet
  await bot.handleUpdate(callbackUpdate("gen_yes"));
  const id = listDishes(db).find((d) => d.nameRu === "Солянка")?.id;
  expect(id).toBeDefined();
  expect(getSelection(db, isoWeek(new Date()))).toContain(id);
});

test("two unmatched dishes are offered one at a time; ✅ then ❌ summarized", async () => {
  const db = openDb(":memory:");
  const byName = (n: string) => dish(n === "солянка" ? "Солянка" : "Рагу");
  const { bot, sent } = harness(db, [], llmResolveAndGen([], ["солянка", "рагу"], byName));
  await bot.handleUpdate(textUpdate("добавь солянка, рагу"));
  expect(sent.some((s) => String(s.payload.text).includes("Солянка") && s.payload.reply_markup)).toBe(true);
  await bot.handleUpdate(callbackUpdate("gen_yes")); // save Солянка → offer Рагу
  expect(sent.some((s) => String(s.payload.text).includes("Рагу") && s.payload.reply_markup)).toBe(true);
  await bot.handleUpdate(callbackUpdate("gen_no"));  // skip Рагу → summary
  const out = lastText(sent);
  expect(out).toContain("Солянка"); // added
  expect(out).toContain("Рагу");    // skipped
  expect(listDishes(db).map((d) => d.nameRu)).toEqual(["Солянка"]);
});

test("generation failure for an unmatched dish is skipped, not crashed", async () => {
  const db = openDb(":memory:");
  const llm: Llm = {
    async structured(args: { toolName?: string }) {
      if (args.toolName === "save_dish") throw new Error("llm down");
      return { matchedIds: [], unmatched: ["боб"] } as never;
    },
  };
  const { bot, sent } = harness(db, [], llm);
  await bot.handleUpdate(textUpdate("добавь боб"));
  const out = lastText(sent);
  expect(out).toContain("Не получилось сгенерировать");
  expect(out).not.toContain("Упс"); // guard's crash message must not appear
});
```

- [ ] **Step 2: Run them, verify they fail**

Run: `bun test tests/bot.test.ts -t "catalogue"`
Expected: FAIL — no `gen_yes` handling; bot still replies the interim `Не нашёл:` tail and never previews.

- [ ] **Step 3: Wire the queue in `bot.ts`**

In `src/bot/bot.ts`, add `generateForSelection, saveDishToWeek` to the handlers import (~6-23).

Replace the interim `replyNamesResult` (added in Task 1) with the queue machinery. Place this block where `replyNamesResult` currently sits (after the `removeDishes` const ~89):

```ts
  type GenState = { queue: string[]; week: string; added: string[]; skipped: string[]; failed: string[] };
  const pendingGen = new Map<number, GenState & { dish: Dish }>(); // userId → current preview + remaining queue

  const genSummary = (st: GenState): string => {
    const parts: string[] = [];
    if (st.added.length) parts.push(`✅ Добавил в неделю и каталог: ${st.added.join(", ")}.`);
    if (st.skipped.length) parts.push(`Пропустил: ${st.skipped.join(", ")}.`);
    if (st.failed.length) parts.push(`Не получилось сгенерировать: ${st.failed.join(", ")}.`);
    if (parts.length === 0) parts.push("Готово.");
    return parts.join("\n") + "\n\n/menu — меню · /list — список покупок.";
  };

  // Pop names off the queue, generating each. Existing dishes join the week silently;
  // brand-new dishes pause the queue with a confirm preview. Empty queue → summary.
  const offerNext = async (ctx: Context, uid: number, st: GenState): Promise<void> => {
    while (st.queue.length > 0) {
      const name = st.queue.shift()!;
      let outcome;
      try {
        outcome = await generateForSelection({ llm: deps.llm, db: deps.db, week: st.week }, name);
      } catch (e) {
        log.error("gen_on_miss_failed", { userId: uid, name, ...errInfo(e) });
        st.failed.push(name);
        continue;
      }
      if (outcome.status === "added") {
        dishes = listDishes(deps.db);
        st.added.push(outcome.nameRu);
        continue;
      }
      pendingGen.set(uid, { ...st, dish: outcome.dish });
      await ctx.reply(outcome.text, {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("✅ Сохранить", "gen_yes").text("❌ Пропустить", "gen_no"),
      });
      return;
    }
    pendingGen.delete(uid);
    await reply(ctx, genSummary(st));
  };

  const startGenQueue = async (ctx: Context, names: string[], wk: string): Promise<void> => {
    if (!ctx.from) return;
    await reply(ctx, `Не нашёл в каталоге: ${names.join(", ")}. Сгенерировать рецепт?`);
    await offerNext(ctx, ctx.from.id, { queue: [...names], week: wk, added: [], skipped: [], failed: [] });
  };

  const replyNamesResult = async (ctx: Context, res: SelectResult, wk: string): Promise<void> => {
    if (res.text) await reply(ctx, res.text);
    if (res.unmatched.length) await startGenQueue(ctx, res.unmatched, wk);
  };
```

Update the three call sites to pass `week()`:

```ts
  bot.command("add", guard(async (ctx) => replyNamesResult(ctx, await addDishes(parseNames(matchText(ctx))), week())));
```

```ts
      case "select_dishes":
        await replyNamesResult(ctx, await handleSelect({ llm: deps.llm, db: deps.db, dishes, week: week() }, intent.dishNames), week());
        break;
```

```ts
      case "add_dishes":
        await replyNamesResult(ctx, await addDishes(intent.dishNames), week());
        break;
```

Add the two callbacks next to the existing `dish_save` / `dish_cancel` registrations (~217):

```ts
  bot.callbackQuery("gen_yes", guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from?.id;
    const st = uid !== undefined ? pendingGen.get(uid) : undefined;
    if (uid === undefined || !st) {
      await reply(ctx, "Нет блюда для сохранения — начни заново.");
      return;
    }
    pendingGen.delete(uid);
    saveDishToWeek({ db: deps.db }, st.dish, st.week);
    dishes = listDishes(deps.db); // refresh catalogue so the new dish is selectable now
    st.added.push(st.dish.nameRu);
    await offerNext(ctx, uid, { queue: st.queue, week: st.week, added: st.added, skipped: st.skipped, failed: st.failed });
  }));

  bot.callbackQuery("gen_no", guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from?.id;
    const st = uid !== undefined ? pendingGen.get(uid) : undefined;
    if (uid === undefined || !st) {
      await reply(ctx, "Нечего пропускать — начни заново.");
      return;
    }
    pendingGen.delete(uid);
    st.skipped.push(st.dish.nameRu);
    await offerNext(ctx, uid, { queue: st.queue, week: st.week, added: st.added, skipped: st.skipped, failed: st.failed });
  }));
```

- [ ] **Step 4: Run the full suite + tsc, verify green**

Run: `bun test && bunx tsc --noEmit`
Expected: PASS (new bot tests included), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/bot/bot.ts tests/bot.test.ts
git commit -m "feat(select): generate-on-miss confirm queue for unknown dishes"
```

---

### Task 5: `CIS_CLASSICS` + `seedClassics`, wired into the seeder

Guarantee CIS staples (incl. солянка) in the catalogue, idempotently, without touching the well-tested `seedDishes`.

**Files:**
- Modify: `src/recipes/recipeStore.ts` (add `CIS_CLASSICS` + `seedClassics` after `seedDishes` ~187)
- Modify: `src/recipes/seed.ts` (call `seedClassics` before `seedDishes`)
- Test: `tests/recipeStore.test.ts`

**Interfaces:**
- Consumes: `generateDish`, `insertDish` (existing)
- Produces: `export const CIS_CLASSICS: string[]`; `export async function seedClassics(db: Database, llm: Llm): Promise<number>`

- [ ] **Step 1: Write the failing tests**

Add to `tests/recipeStore.test.ts` (import `seedClassics, CIS_CLASSICS` in the top recipeStore import):

```ts
test("seedClassics guarantees every CIS classic is catalogued", async () => {
  const db = openDb(":memory:");
  const llm: Llm = {
    async structured(args: { prompt?: string }) {
      const m = String(args.prompt).match(/the single dish "([^"]+)"/);
      const name = m?.[1] ?? "X";
      return { dish: { nameRu: name, nameUa: null, nameDe: null, cuisine: "ru", course: "second", keepsDays: 2, tags: [], servings: 4, ingredients: [{ canonical: "соль", qty: null, unit: null }] } } as never;
    },
  };
  const added = await seedClassics(db, llm);
  const names = listDishes(db).map((d) => d.nameRu);
  for (const c of CIS_CLASSICS) expect(names).toContain(c);
  expect(added).toBe(CIS_CLASSICS.length);
});

test("seedClassics is idempotent — a second run adds nothing", async () => {
  const db = openDb(":memory:");
  const llm: Llm = {
    async structured(args: { prompt?: string }) {
      const m = String(args.prompt).match(/the single dish "([^"]+)"/);
      return { dish: { nameRu: m?.[1] ?? "X", nameUa: null, nameDe: null, cuisine: "ru", course: "second", keepsDays: 2, tags: [], servings: 4, ingredients: [{ canonical: "соль", qty: null, unit: null }] } } as never;
    },
  };
  await seedClassics(db, llm);
  const second = await seedClassics(db, llm);
  expect(second).toBe(0);
  expect(listDishes(db).filter((d) => d.nameRu === CIS_CLASSICS[0]).length).toBe(1);
});
```

- [ ] **Step 2: Run them, verify they fail**

Run: `bun test tests/recipeStore.test.ts -t "seedClassics"`
Expected: FAIL — `seedClassics`/`CIS_CLASSICS` not defined.

- [ ] **Step 3: Implement `CIS_CLASSICS` + `seedClassics`**

Add to `src/recipes/recipeStore.ts` after `seedDishes` (~187), before `generateDish`:

```ts
/** Curated CIS staples the catalogue must always contain. */
export const CIS_CLASSICS: string[] = [
  "Солянка мясная сборная",
  "Рассольник",
  "Окрошка",
  "Борщ",
  "Плов",
  "Голубцы",
  "Вареники с картошкой",
  "Пельмени",
  "Гречка с грибами",
  "Оливье",
  "Винегрет",
  "Котлеты с пюре",
];

/**
 * Ensure every CIS_CLASSICS dish is in the catalogue. Generates only the missing
 * ones (by name_ru, case-insensitive) and is idempotent. Returns the number added.
 */
export async function seedClassics(db: Database, llm: Llm): Promise<number> {
  const existing = db.query("SELECT name_ru FROM dishes").all() as { name_ru: string }[];
  const seen = new Set<string>(existing.map((r) => r.name_ru.toLowerCase()));
  let added = 0;
  for (const name of CIS_CLASSICS) {
    if (seen.has(name.toLowerCase())) continue;
    const dish = await generateDish(llm, name);
    if (seen.has(dish.nameRu.toLowerCase())) continue; // generated canonical already present
    insertDish(db, dish);
    seen.add(dish.nameRu.toLowerCase());
    added++;
  }
  return added;
}
```

- [ ] **Step 4: Run them, verify they pass**

Run: `bun test tests/recipeStore.test.ts -t "seedClassics"`
Expected: PASS.

- [ ] **Step 5: Wire `seedClassics` into `seed.ts`**

Replace `src/recipes/seed.ts` body so both run; `seedDishes` still tops up to the same target:

```ts
import { loadConfig } from "../config";
import { openDb } from "../db/db";
import { createLlm } from "../llm/llm";
import { seedClassics, seedDishes } from "./recipeStore";
import { log, errInfo } from "../log";

try {
  const cfg = loadConfig(Bun.env);
  const db = openDb("data/annona.db");
  const llm = createLlm({ apiKey: cfg.anthropicApiKey, model: cfg.llmModel });
  const classics = await seedClassics(db, llm);
  const n = await seedDishes(db, llm, 110);
  log.info("seeded_dishes", { classics, count: n, target: 110 });
} catch (error) {
  log.error("seed_failed", errInfo(error));
  process.exit(1);
}
```

- [ ] **Step 6: Run the full suite + tsc, verify green**

Run: `bun test && bunx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/recipes/recipeStore.ts src/recipes/seed.ts tests/recipeStore.test.ts
git commit -m "feat(recipes): seedClassics guarantees CIS staples in the catalogue"
```

---

## Rollout (after all tasks merge)

1. PR `generate-on-miss` → review (subagent-driven: implementer + reviewer per task, final opus whole-branch) → merge to `main`.
2. `./deploy.sh` to `home`.
3. One-off seed top-up so prod gains the CIS classics:
   `ssh home 'cd ~/annona && docker compose run --rm annona bun run src/recipes/seed.ts'`
   then `ssh home 'cd ~/annona && docker compose restart annona'`.
4. Telegram smoke: send «борщ, солянка, гречка» → confirm солянка preview → ✅ →
   `/menu` and `/list` include солянка; re-sending «сборная солянка» resolves to the
   now-cataloged dish without a new prompt.

## Self-Review

- **Spec coverage:** A (generate-on-miss) → Tasks 1, 3, 4. Queue for multiple unmatched → Task 4. Confirm-first ✅/❌ → Task 4. Persist + add-to-week → Tasks 3, 4. C (CIS classics) → Task 5. `/recipe` untouched → only `gen_yes`/`gen_no` added; `dish_save`/`dish_cancel` unchanged. No new dep / no schema change → honored.
- **Placeholder scan:** none — every step has concrete code and exact commands.
- **Type consistency:** `SelectResult` (Task 1) consumed in Task 4; `dishIdByName` (Task 2) consumed in Task 3; `generateForSelection`/`saveDishToWeek` (Task 3) consumed in Task 4; `GenState`/`pendingGen` local to Task 4; `CIS_CLASSICS`/`seedClassics` (Task 5) consumed in `seed.ts`. Names match across tasks.
