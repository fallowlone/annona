import { loadConfig } from "./config";
import { openDb } from "./db/db";
import { createFetcher } from "./net/fetcher";
import { loadKeys, createMarktguruProvider } from "./providers/marktguru";
import { createLlm } from "./llm/llm";
import { createMatcher } from "./matcher";
import { listDishes } from "./recipes/recipeStore";
import { isoWeek } from "./util/week";
import { createBot } from "./bot/bot";
import { log, errInfo } from "./log";
import type { StoreKey } from "./stores";

const cfg = loadConfig(Bun.env);
const db = openDb("data/annona.db");
const fetcher = createFetcher({ proxyMode: cfg.proxyMode });
const keys = await loadKeys(fetcher);
const provider = createMarktguruProvider({ fetcher, zipCode: cfg.locationPlz, keys });
const llm = createLlm({ apiKey: cfg.anthropicApiKey, model: cfg.llmModel });
const whitelist = new Set<StoreKey>(cfg.storeWhitelist);
const matcher = createMatcher({ db, llm, provider, week: () => isoWeek(new Date()), whitelist });
const dishes = listDishes(db);

if (dishes.length === 0) log.warn("no_dishes_seeded", { hint: "run `bun run seed`" });

const bot = createBot({
  token: cfg.telegramBotToken,
  allowedUserIds: cfg.allowedUserIds,
  dishes,
  matcher,
  llm,
  db,
  plz: cfg.locationPlz,
  menuDays: cfg.menuDays,
  householdSize: cfg.householdSize,
  coverageMin: cfg.offerCoverageMin,
  digestLimit: cfg.digestLimit,
});
log.info("bot_starting");
bot.start().catch((e) => {
  log.error("bot_start_failed", errInfo(e));
  process.exit(1);
});
