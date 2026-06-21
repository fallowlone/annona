import { loadConfig } from "../config";
import { openDb } from "../db/db";
import { createLlm } from "../llm/llm";
import { seedDishes } from "./recipeStore";

const cfg = loadConfig(Bun.env);
const db = openDb("annona.db");
const n = await seedDishes(db, createLlm({ apiKey: cfg.anthropicApiKey, model: cfg.llmModel }), 30);
console.log(`seeded ${n} dishes`);
