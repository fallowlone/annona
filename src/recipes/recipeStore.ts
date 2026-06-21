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
  tags: z.array(z.string()),
  servings: z.number().int().positive(),
  ingredients: z.array(IngredientSchema).min(1),
});

// Zod infers nullable fields in the schema that don't structurally match the Dish interface, so we cast to bridge them.
export const DishSeedSchema: z.ZodType<{ dishes: Dish[] }> = z.object({
  dishes: z.array(DishSchema),
}) as unknown as z.ZodType<{ dishes: Dish[] }>;

// ── Row types ──────────────────────────────────────────────────────────────

type DishRow = {
  id: number;
  name_ru: string;
  name_ua: string | null;
  name_de: string | null;
  cuisine: string;
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
      .query<{ id: number }, [string, string | null, string | null, string, string, number]>(
        `INSERT INTO dishes(name_ru, name_ua, name_de, cuisine, tags, servings)
         VALUES(?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(
        dish.nameRu,
        dish.nameUa ?? null,
        dish.nameDe ?? null,
        dish.cuisine,
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

/** Return all dishes ordered by id, each with their ingredients. */
export function listDishes(db: Database): Dish[] {
  const dishRows = db
    .query<DishRow, []>(`SELECT id, name_ru, name_ua, name_de, cuisine, tags, servings FROM dishes ORDER BY id`)
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

// ── LLM seeding ───────────────────────────────────────────────────────────

/**
 * Ask the LLM for `count` dishes, validate the response with DishSeedSchema,
 * insert each dish transactionally, and return the number inserted.
 */
export async function seedDishes(db: Database, llm: Llm, count: number): Promise<number> {
  const out = await llm.structured({
    system: "You are a chef cataloguing Ukrainian and Russian home dishes makeable in Germany.",
    prompt: `Return ${count} popular Ukrainian/Russian dishes. For each provide: nameRu, nameUa, nameDe, cuisine ('ru'|'ua'), tags (array of strings), servings (integer), and ingredients with canonical Russian names, qty (number or null) and unit (string or null). Use ingredients buyable in German supermarkets.`,
    toolName: "save_dishes",
    description: "Persist the generated dish catalogue",
    schema: DishSeedSchema,
    // 30 dishes with ingredients far exceed the default 1024-token cap; without a
    // larger budget the tool JSON is truncated and "dishes" arrives undefined.
    maxTokens: 8192,
  });

  let n = 0;
  for (const dish of out.dishes) {
    insertDish(db, dish);
    n++;
  }
  return n;
}
