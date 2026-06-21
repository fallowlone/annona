import { Bot, type Context } from "grammy";
import { Database } from "bun:sqlite";
import type { Dish } from "../types";
import type { Matcher } from "../matcher";
import type { Llm } from "../llm/llm";
import { isAllowed, handleRecommend, handleSelect, handleMenu, handleList, helpText } from "./handlers";
import { classifyIntent } from "./intent";
import { isoWeek } from "../util/week";

export function createBot(deps: {
  token: string;
  allowedUserIds: number[];
  dishes: Dish[];
  matcher: Matcher;
  llm: Llm;
  db: Database;
  plz: number;
  menuDays: number;
  coverageMin?: number;
  digestLimit?: number;
}): Bot {
  const bot = new Bot(deps.token);

  bot.use(async (ctx, next) => {
    if (!isAllowed(ctx.from?.id, deps.allowedUserIds)) {
      console.warn("Ignored message from non-whitelisted user id:", ctx.from?.id);
      return;
    }
    await next();
  });

  const reply = async (ctx: Context, text: string) => {
    await ctx.reply(text, { parse_mode: "Markdown" });
  };

  const suggest = (ctx: Context) =>
    handleRecommend({
      dishes: deps.dishes,
      matcher: deps.matcher,
      coverageMin: deps.coverageMin,
      limit: deps.digestLimit,
    }).then((t) => reply(ctx, t));

  const menu = (ctx: Context) =>
    reply(ctx, handleMenu({ db: deps.db, dishes: deps.dishes, week: isoWeek(new Date()), menuDays: deps.menuDays }));

  const list = (ctx: Context) =>
    handleList({ db: deps.db, dishes: deps.dishes, matcher: deps.matcher, week: isoWeek(new Date()), plz: deps.plz }).then((t) => reply(ctx, t));

  const guard = (fn: (ctx: Context) => Promise<void>) => async (ctx: Context) => {
    try {
      await fn(ctx);
    } catch (e) {
      await ctx.reply("Упс, что-то пошло не так. Попробуй позже.");
      console.error(e);
    }
  };

  bot.command("start", (ctx) => reply(ctx, helpText()));
  bot.command("digest", guard(suggest));
  bot.command("menu", guard(menu));
  bot.command("list", guard(list));

  bot.on("message:text", guard(async (ctx) => {
    const text = ctx.message?.text ?? "";
    const intent = await classifyIntent(deps.llm, text);
    switch (intent.kind) {
      case "select_dishes":
        await reply(ctx, await handleSelect({ llm: deps.llm, db: deps.db, dishes: deps.dishes, week: isoWeek(new Date()) }, intent.dishNames));
        break;
      case "show_menu":
        await menu(ctx);
        break;
      case "show_list":
        await list(ctx);
        break;
      case "suggest":
        await suggest(ctx);
        break;
      default:
        await reply(ctx, helpText());
    }
  }));

  return bot;
}
