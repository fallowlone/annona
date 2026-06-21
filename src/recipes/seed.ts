import { loadConfig } from "../config";
import { openDb } from "../db/db";
import { createLlm } from "../llm/llm";
import { seedDishes } from "./recipeStore";

try {
  const cfg = loadConfig(Bun.env);
  const db = openDb("data/annona.db");
  const n = await seedDishes(
    db,
    createLlm({ apiKey: cfg.anthropicApiKey, model: cfg.llmModel }),
    110
  );
  console.log(`seeded ${n} new dishes (catalogue target 110)`);
} catch (error) {
  console.error("Failed to seed dishes:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
