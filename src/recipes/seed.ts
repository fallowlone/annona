import { loadConfig } from "../config";
import { openDb } from "../db/db";
import { createLlm } from "../llm/llm";
import { seedDishes } from "./recipeStore";
import { log, errInfo } from "../log";

try {
  const cfg = loadConfig(Bun.env);
  const db = openDb("data/annona.db");
  const n = await seedDishes(
    db,
    createLlm({ apiKey: cfg.anthropicApiKey, model: cfg.llmModel }),
    110
  );
  log.info("seeded_dishes", { count: n, target: 110 });
} catch (error) {
  log.error("seed_failed", errInfo(error));
  process.exit(1);
}
