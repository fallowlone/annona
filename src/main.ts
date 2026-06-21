import { loadConfig } from "./config";
import { openDb } from "./db/db";
import { createFetcher } from "./net/fetcher";
import { loadKeys, createMarktguruProvider } from "./providers/marktguru";
import { createLlm } from "./llm/llm";
import { createMatcher } from "./matcher";
import { listDishes } from "./recipes/recipeStore";
import { isoWeek } from "./util/week";
import { createBot } from "./bot/bot";

const cfg = loadConfig(Bun.env);
const db = openDb("annona.db");
const fetcher = createFetcher({ proxyMode: cfg.proxyMode });
const keys = await loadKeys(fetcher);
const provider = createMarktguruProvider({ fetcher, zipCode: cfg.locationPlz, keys });
const llm = createLlm({ apiKey: cfg.anthropicApiKey, model: cfg.llmModel });
const matcher = createMatcher({ db, llm, provider, week: isoWeek(new Date()) });
const dishes = listDishes(db);

if (dishes.length === 0) console.warn("No dishes yet — run `bun run seed` first.");

const bot = createBot({
  token: cfg.telegramBotToken,
  allowedUserIds: cfg.allowedUserIds,
  dishes,
  matcher,
});
console.log("Annona bot starting…");
bot.start().catch((e) => {
  console.error("Bot failed to start:", e);
  process.exit(1);
});
