import { Bot, type Context } from "grammy";
import type { Dish } from "../types";
import type { Matcher } from "../matcher";
import { isAllowed, handleRecommend } from "./handlers";

export function createBot(deps: {
  token: string;
  allowedUserIds: number[];
  dishes: Dish[];
  matcher: Matcher;
  coverageMin?: number;
  digestLimit?: number;
}): Bot {
  const bot = new Bot(deps.token);

  bot.use(async (ctx, next) => {
    if (!isAllowed(ctx.from?.id, deps.allowedUserIds)) {
      console.warn("Ignored message from non-whitelisted user id:", ctx.from?.id);
      return; // silently ignore strangers
    }
    await next();
  });

  bot.command("start", (ctx) =>
    ctx.reply(
      "Привет! Напиши /digest или «что приготовить», и я подскажу выгодные блюда недели."
    )
  );

  const recommend = async (ctx: Context) => {
    const text = await handleRecommend({
      dishes: deps.dishes,
      matcher: deps.matcher,
      coverageMin: deps.coverageMin,
      limit: deps.digestLimit,
    });
    await ctx.reply(text, { parse_mode: "Markdown" });
  };

  bot.command("digest", async (ctx) => {
    try {
      await recommend(ctx);
    } catch (e) {
      await ctx.reply("Упс, что-то пошло не так. Попробуй позже.");
      console.error(e);
    }
  });
  bot.on("message:text", async (ctx) => {
    try {
      await recommend(ctx);
    } catch (e) {
      await ctx.reply("Упс, что-то пошло не так. Попробуй позже.");
      console.error(e);
    }
  });

  return bot;
}
