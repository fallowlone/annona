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
