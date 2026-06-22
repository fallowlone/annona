import { Bot, type Context } from "grammy";
import { Database } from "bun:sqlite";
import type { Dish } from "../types";
import type { Matcher } from "../matcher";
import type { Llm } from "../llm/llm";
import {
  isAllowed,
  handleRecommend,
  handleSelect,
  handleMenu,
  handleList,
  handleAddDishes,
  handleRemoveDishes,
  handleAddCustomDish,
  handleScaleDish,
  helpText,
} from "./handlers";
import { classifyIntent } from "./intent";
import { routeMessage } from "./router";
import { listDishes } from "../recipes/recipeStore";
import { isoWeek } from "../util/week";

const DEFAULT_HOUSEHOLD = 2;

/** Split a free-text argument like "борщ, плов" into trimmed dish names. */
function parseNames(arg: string): string[] {
  return arg.split(",").map((s) => s.trim()).filter(Boolean);
}

export function createBot(deps: {
  token: string;
  allowedUserIds: number[];
  dishes: Dish[];
  matcher: Matcher;
  llm: Llm;
  db: Database;
  plz: number;
  menuDays: number;
  householdSize?: number;
  coverageMin?: number;
  digestLimit?: number;
}): Bot {
  const bot = new Bot(deps.token);
  const household = deps.householdSize ?? DEFAULT_HOUSEHOLD;
  let dishes = deps.dishes; // mutable: custom dishes append within the running process

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

  const week = () => isoWeek(new Date());

  const suggest = (ctx: Context) =>
    handleRecommend({
      dishes,
      matcher: deps.matcher,
      coverageMin: deps.coverageMin,
      limit: deps.digestLimit,
      householdSize: household,
    }).then((t) => reply(ctx, t));

  const menu = (ctx: Context) =>
    reply(ctx, handleMenu({ db: deps.db, dishes, week: week(), menuDays: deps.menuDays, householdSize: household }));

  const list = (ctx: Context) =>
    handleList({ db: deps.db, dishes, matcher: deps.matcher, week: week(), plz: deps.plz, householdSize: household }).then(
      (t) => reply(ctx, t)
    );

  const addDishes = (names: string[]) =>
    handleAddDishes({ llm: deps.llm, db: deps.db, dishes, week: week() }, names);

  const removeDishes = (names: string[]) =>
    handleRemoveDishes({ llm: deps.llm, db: deps.db, dishes, week: week() }, names);

  const addCustom = async (name: string) => {
    const msg = await handleAddCustomDish({ llm: deps.llm, db: deps.db }, name);
    dishes = listDishes(deps.db); // refresh catalogue so the new dish is selectable now
    return msg;
  };

  const scaleDish = (name: string, target: number) =>
    handleScaleDish({ llm: deps.llm, db: deps.db, dishes }, name, target);

  const matchText = (ctx: Context): string => (typeof ctx.match === "string" ? ctx.match : "");

  const guard = (fn: (ctx: Context) => Promise<void>) => async (ctx: Context) => {
    try {
      await fn(ctx);
    } catch (e) {
      await ctx.reply("Упс, что-то пошло не так. Попробуй позже.");
      console.error("Handler error for user", ctx.from?.id, e);
    }
  };

  bot.command("start", (ctx) => reply(ctx, helpText()));
  bot.command("digest", guard(suggest));
  bot.command("menu", guard(menu));
  bot.command("list", guard(list));
  bot.command("add", guard(async (ctx) => reply(ctx, await addDishes(parseNames(matchText(ctx))))));
  bot.command("remove", guard(async (ctx) => reply(ctx, await removeDishes(parseNames(matchText(ctx))))));
  bot.command("recipe", guard(async (ctx) => reply(ctx, await addCustom(matchText(ctx).trim()))));

  bot.on("message:text", guard(async (ctx) => {
    const text = ctx.message?.text ?? "";
    const intent = routeMessage(text) ?? (await classifyIntent(deps.llm, text));
    switch (intent.kind) {
      case "select_dishes":
        await reply(ctx, await handleSelect({ llm: deps.llm, db: deps.db, dishes, week: week() }, intent.dishNames));
        break;
      case "add_dishes":
        await reply(ctx, await addDishes(intent.dishNames));
        break;
      case "remove_dishes":
        await reply(ctx, await removeDishes(intent.dishNames));
        break;
      case "add_custom_dish":
        await reply(ctx, await addCustom(intent.dishNames[0] ?? ""));
        break;
      case "scale_dish":
        await reply(ctx, await scaleDish(intent.dishNames[0] ?? "", intent.targetServings ?? household));
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
