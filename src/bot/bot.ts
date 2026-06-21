import { Bot } from "grammy";
import type { Dish } from "../types";
import type { Matcher } from "../matcher";
import { isAllowed, handleRecommend } from "./handlers";

export function createBot(deps: {
  token: string;
  allowedUserIds: number[];
  dishes: Dish[];
  matcher: Matcher;
}): Bot {
  const bot = new Bot(deps.token);

  bot.use(async (ctx, next) => {
    if (!isAllowed(ctx.from?.id, deps.allowedUserIds)) return; // silently ignore strangers
    await next();
  });

  bot.command("start", (ctx) =>
    ctx.reply(
      "Привет! Напиши /digest или «что приготовить», и я подскажу выгодные блюда недели."
    )
  );

  const recommend = async (ctx: {
    reply: (t: string, o?: unknown) => Promise<unknown>;
  }) => {
    const text = await handleRecommend({ dishes: deps.dishes, matcher: deps.matcher });
    await ctx.reply(text, { parse_mode: "Markdown" });
  };

  bot.command("digest", recommend);
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
