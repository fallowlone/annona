import { loadConfig } from "./config";
import { openDb } from "./db/db";
import { createFetcher } from "./net/fetcher";
import { createLazyMarktguruProvider } from "./providers/marktguru";
import { createLlm } from "./llm/llm";
import { createMatcher } from "./matcher";
import { listDishes } from "./recipes/recipeStore";
import { isoWeek } from "./util/week";
import { createBot } from "./bot/bot";
import { handleRecommend } from "./bot/handlers";
import { msUntilNext } from "./schedule";
import { log, errInfo } from "./log";
import { writeHeartbeat } from "./health";
import type { StoreKey } from "./stores";

const HEARTBEAT_PATH = "data/heartbeat";
const HEARTBEAT_MS = 30_000;

const cfg = loadConfig(Bun.env);
const db = openDb("data/annona.db");
const fetcher = createFetcher({ proxyMode: cfg.proxyMode });
// Keys load lazily on first offer search, so marktguru being down or changing
// its markup degrades matching to "nothing on offer" instead of crash-looping
// the bot at boot. Menu/recipe/pantry reads work without it.
const provider = createLazyMarktguruProvider({ fetcher, zipCode: cfg.locationPlz });
const llm = createLlm({ apiKey: cfg.anthropicApiKey, model: cfg.llmModel });
const whitelist = new Set<StoreKey>(cfg.storeWhitelist);
const matcher = createMatcher({ db, llm, provider, week: () => isoWeek(new Date()), whitelist });
const dishes = listDishes(db);

if (dishes.length === 0) log.warn("no_dishes_seeded", { hint: "run `bun run seed`" });

const bot = createBot({
  token: cfg.telegramBotToken,
  allowedUserIds: cfg.allowedUserIds,
  matcher,
  llm,
  db,
  plz: cfg.locationPlz,
  menuDays: cfg.menuDays,
  householdSize: cfg.householdSize,
  coverageMin: cfg.offerCoverageMin,
  digestLimit: cfg.digestLimit,
});
// Liveness heartbeat on a timer (independent of incoming updates, so an idle
// bot still looks healthy). The Docker HEALTHCHECK fails if it goes stale.
writeHeartbeat(HEARTBEAT_PATH, new Date());
const heartbeat = setInterval(() => writeHeartbeat(HEARTBEAT_PATH, new Date()), HEARTBEAT_MS);

// Weekly digest auto-push (opt-in via DIGEST_PUSH). A self-rescheduling timer
// fires at the configured weekday+hour and sends "что выгодно" to each
// allowlisted user. Self-contained — no external cron needed.
let digestTimer: ReturnType<typeof setTimeout> | undefined;
async function pushDigest(): Promise<void> {
  try {
    const text = await handleRecommend({
      dishes: listDishes(db),
      matcher,
      coverageMin: cfg.offerCoverageMin,
      limit: cfg.digestLimit,
      householdSize: cfg.householdSize,
    });
    for (const uid of cfg.allowedUserIds) {
      await bot.api
        .sendMessage(uid, text, { parse_mode: "HTML" })
        .catch((e) => log.error("digest_push_failed", { uid, ...errInfo(e) }));
    }
  } catch (e) {
    log.error("digest_build_failed", errInfo(e));
  }
}
function scheduleDigest(): void {
  if (!cfg.digestPush) return;
  const ms = msUntilNext(new Date(), cfg.digestDow, cfg.digestHour);
  log.info("digest_scheduled", { inMs: ms, dow: cfg.digestDow, hour: cfg.digestHour });
  digestTimer = setTimeout(() => {
    void pushDigest().finally(scheduleDigest); // reschedule for next week
  }, ms);
}
scheduleDigest();

// Drain on redeploy/stop: long-poll cleanly and close the DB so WAL is
// checkpointed, instead of being hard-killed after Docker's 10s grace.
const shutdown = async (sig: string): Promise<void> => {
  log.info("shutting_down", { sig });
  clearInterval(heartbeat);
  if (digestTimer) clearTimeout(digestTimer);
  try {
    await bot.stop();
  } catch (e) {
    log.error("bot_stop_failed", errInfo(e));
  }
  try {
    db.close();
  } catch (e) {
    log.error("db_close_failed", errInfo(e));
  }
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

// Last-resort nets for errors that escape the per-handler guard / bot.catch
// (floating promises, errors outside the update cycle). Log, don't die silently.
process.on("unhandledRejection", (reason) => log.error("unhandled_rejection", errInfo(reason)));
process.on("uncaughtException", (e) => {
  log.error("uncaught_exception", errInfo(e));
  process.exit(1);
});

log.info("bot_starting");
bot.start().catch((e) => {
  log.error("bot_start_failed", errInfo(e));
  process.exit(1);
});
