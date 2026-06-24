import { Database } from "bun:sqlite";
import { z } from "zod";
import type { Dish, Ingredient } from "../types";
import type { Llm } from "../llm/llm";

// ── Schemas ────────────────────────────────────────────────────────────────

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
  course: z.enum(["first", "second"]),
  keepsDays: z.number().int().positive(),
  tags: z.array(z.string()),
  servings: z.number().int().positive(),
  ingredients: z.array(IngredientSchema).min(1),
});

// Inferred output (course is a required enum here, since the model always emits
// it) is a structural subtype of Dish (course optional|null), so it's directly
// assignable wherever a Dish is expected — no cast needed.
export const DishSeedSchema = z.object({ dishes: z.array(DishSchema) });

const GenerateDishSchema = z.object({ dish: DishSchema });

const StepsSchema = z.object({ steps: z.string().min(1) });

// ── Row types ──────────────────────────────────────────────────────────────

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

type IngredientRow = {
  canonical_name: string;
  qty: number | null;
  unit: string | null;
};

// ── Persistence ────────────────────────────────────────────────────────────

/** Insert a dish and all its ingredients in a single transaction. Returns the new dish id. */
export function insertDish(db: Database, dish: Dish): number {
  const insert = db.transaction(() => {
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

    if (!row) throw new Error("insertDish: RETURNING id returned no row");

    const ingStmt = db.prepare(
      `INSERT INTO ingredients(dish_id, canonical_name, qty, unit) VALUES(?, ?, ?, ?)`
    );
    for (const ing of dish.ingredients) {
      ingStmt.run(row.id, ing.canonical, ing.qty ?? null, ing.unit ?? null);
    }

    return row.id;
  });

  return insert() as number;
}

/** Delete a dish and its ingredients in one transaction (no FK pragma reliance). */
export function deleteDish(db: Database, dishId: number): void {
  const tx = db.transaction(() => {
    db.run("DELETE FROM ingredients WHERE dish_id = ?", [dishId]);
    db.run("DELETE FROM dishes WHERE id = ?", [dishId]);
  });
  tx();
}

/** Return all dishes ordered by id, each with their ingredients. */
export function listDishes(db: Database): Dish[] {
  const dishRows = db
    .query<DishRow, []>(
      `SELECT id, name_ru, name_ua, name_de, cuisine, course, keeps_days, tags, servings FROM dishes ORDER BY id`
    )
    .all();

  const ingQ = db.query<IngredientRow, [number]>(
    `SELECT canonical_name, qty, unit FROM ingredients WHERE dish_id = ? ORDER BY id`
  );

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
}

/** Return ingredients for a single dish by id. */
export function getIngredients(db: Database, dishId: number): Ingredient[] {
  return db
    .query<IngredientRow, [number]>(
      `SELECT canonical_name, qty, unit FROM ingredients WHERE dish_id = ? ORDER BY id`
    )
    .all(dishId)
    .map((i) => ({ canonical: i.canonical_name, qty: i.qty, unit: i.unit }));
}

/** Return the id of a catalogue dish by name_ru (case-insensitive), or null. */
export function dishIdByName(db: Database, name: string): number | null {
  const needle = name.toLowerCase();
  const rows = db
    .query<{ id: number; name_ru: string }, []>("SELECT id, name_ru FROM dishes")
    .all();
  const match = rows.find((r) => r.name_ru.toLowerCase() === needle);
  return match ? match.id : null;
}

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
  // Neutralize guillemet/quote delimiter-breakout and cap length before interpolating into the prompt.
  const safeName = dish.nameRu.replace(/[«»"]/g, "'").slice(0, 120);
  const ings = dish.ingredients
    .map((i) => (i.qty !== null ? `${i.canonical} ${i.qty}${i.unit ? ` ${i.unit}` : ""}` : i.canonical))
    .join(", ");
  const out = await llm.structured({
    system: "Ты повар. Пиши простые домашние рецепты на русском, нумерованными шагами.",
    prompt:
      `Напиши пошаговый рецепт блюда «${safeName}» на ${dish.servings} порц. ` +
      `Ингредиенты: ${ings}. Верни нумерованные шаги (1., 2., …), кратко и по делу.`,
    toolName: "save_steps",
    description: "Persist the recipe cooking steps",
    schema: StepsSchema,
    maxTokens: 1024,
  });
  return out.steps;
}

// ── LLM seeding ───────────────────────────────────────────────────────────

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
  // Only the most recent names go into the anti-repeat hint. Sending the full
  // `seen` set grew the prompt O(n) per batch → O(n²) input tokens over a run;
  // a bounded window keeps each prompt O(1) while still steering away from the
  // last couple of batches (the post-hoc `seen.has` check dedupes the rest).
  const EXCLUDE_WINDOW = 16;
  let added = 0;
  while (added < need) {
    const want = Math.min(BATCH, need - added);
    const recent = [...seen].slice(-EXCLUDE_WINDOW);
    const exclude =
      recent.length > 0
        ? ` Do NOT repeat any of these already-known dishes: ${recent.join(", ")}.`
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

/**
 * Generate a single dish record from just its name via the LLM (same catalogue
 * conventions as `seedDishes`). Returns a validated Dish; the caller persists it.
 */
export async function generateDish(llm: Llm, name: string): Promise<Dish> {
  // Neutralize quote-breakout and cap length before interpolating user text into the prompt.
  const safeName = name.replace(/"/g, "'").slice(0, 120);
  const out = await llm.structured({
    system:
      "You are a chef cataloguing home dishes a CIS family can cook in Germany: mostly Ukrainian and Russian classics, plus globally popular dishes.",
    prompt:
      `Describe the single dish "${safeName}". Provide nameRu, nameUa (or null), nameDe (or null), ` +
      `cuisine (short code like 'ru'|'ua'|'it'), course ('first' for soups/porridge, 'second' for mains), ` +
      `keepsDays (integer 1-5: how many days the cooked dish keeps in a fridge), tags (array of strings), ` +
      `servings (integer), and ingredients with canonical Russian names, qty (number or null) and ` +
      `unit (string or null). Use ingredients buyable in German supermarkets.`,
    toolName: "save_dish",
    description: "Persist one generated dish",
    schema: GenerateDishSchema,
    maxTokens: 1024,
  });
  return out.dish;
}
