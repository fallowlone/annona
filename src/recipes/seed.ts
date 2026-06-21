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
    30
  );
  console.log(`seeded ${n} dishes`);
} catch (error) {
  console.error("Failed to seed dishes:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
