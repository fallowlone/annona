import { Bot, InlineKeyboard, type Context } from "grammy";
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
  previewCustomDish,
  confirmCustomDish,
  previewDeleteDish,
  confirmDeleteDish,
  handleScaleDish,
  helpText,
  handleAddPantry,
  handleRemovePantry,
  handleShowPantry,
  generateForSelection,
  saveDishToWeek,
  type SelectResult,
} from "./handlers";
import { classifyIntent } from "./intent";
import { routeMessage } from "./router";
import { listDishes } from "../recipes/recipeStore";
import { isoWeek } from "../util/week";
import { log, errInfo } from "../log";
import { createMenus } from "./menus";
import { esc } from "./format";

const DEFAULT_HOUSEHOLD = 2;

/** Split a free-text argument like "борщ, плов" into trimmed dish names. */
function parseNames(arg: string): string[] {
  return arg.split(",").map((s) => s.trim()).filter(Boolean);
}

export function createBot(deps: {
  token: string;
  allowedUserIds: number[];
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
  // Net for errors thrown inside grammy middleware/menu handlers that aren't
  // wrapped by guard() (e.g. the @grammyjs/menu card actions) — log, don't crash.
  bot.catch((err) => log.error("bot_error", { userId: err.ctx?.from?.id, ...errInfo(err.error) }));
  const household = deps.householdSize ?? DEFAULT_HOUSEHOLD;
  // Single source of truth: read the catalogue live from the DB on every use
  // (like the menu handlers do). A mutable cached copy went stale whenever a
  // catalogue mutation happened on the menu side, which createBot couldn't see.
  const catalogue = (): Dish[] => listDishes(deps.db);

  bot.use(async (ctx, next) => {
    if (!isAllowed(ctx.from?.id, deps.allowedUserIds)) {
      log.warn("ignored_non_whitelisted", { userId: ctx.from?.id });
      return;
    }
    await next();
  });

  // HTML parse mode throughout: handlers already esc() their dynamic strings.
  // (Legacy Markdown can't be escaped reliably and silently 400s on an unbalanced
  // metacharacter in a dish/product name.)
  const reply = async (ctx: Context, text: string) => {
    await ctx.reply(text, { parse_mode: "HTML" });
  };

  const week = () => isoWeek(new Date());

  const menus = createMenus({
    db: deps.db, matcher: deps.matcher, llm: deps.llm,
    menuDays: deps.menuDays, householdSize: household, plz: deps.plz, week,
    coverageMin: deps.coverageMin, digestLimit: deps.digestLimit,
  });
  bot.use(menus.main);

  const suggest = (ctx: Context) =>
    handleRecommend({
      dishes: catalogue(),
      matcher: deps.matcher,
      coverageMin: deps.coverageMin,
      limit: deps.digestLimit,
      householdSize: household,
    }).then((t) => reply(ctx, t));

  const menu = (ctx: Context) =>
    handleMenu({ db: deps.db, dishes: catalogue(), matcher: deps.matcher, week: week(), menuDays: deps.menuDays, householdSize: household }).then(
      (t) => reply(ctx, t)
    );

  const list = (ctx: Context) =>
    handleList({ db: deps.db, dishes: catalogue(), matcher: deps.matcher, week: week(), plz: deps.plz, householdSize: household }).then(
      (t) => reply(ctx, t)
    );

  const addDishes = (names: string[]) =>
    handleAddDishes({ llm: deps.llm, db: deps.db, dishes: catalogue(), week: week() }, names);

  const removeDishes = (names: string[]) =>
    handleRemoveDishes({ llm: deps.llm, db: deps.db, dishes: catalogue(), week: week() }, names);

  type GenState = { queue: string[]; week: string; added: string[]; skipped: string[]; failed: string[] };
  const pendingGen = new Map<number, GenState & { dish: Dish }>(); // userId → current preview + remaining queue

  const genSummary = (st: GenState): string => {
    const parts: string[] = [];
    if (st.added.length) parts.push(`✅ Добавил в неделю и каталог: ${esc(st.added.join(", "))}.`);
    if (st.skipped.length) parts.push(`Пропустил: ${esc(st.skipped.join(", "))}.`);
    if (st.failed.length) parts.push(`Не получилось сгенерировать: ${esc(st.failed.join(", "))}.`);
    if (parts.length === 0) parts.push("Готово.");
    return parts.join("\n") + "\n\n/menu — меню · /list — список покупок.";
  };

  // Pop names off the queue, generating each. Existing dishes join the week silently;
  // brand-new dishes pause the queue with a confirm preview. Empty queue → summary.
  const offerNext = async (ctx: Context, uid: number, st: GenState): Promise<void> => {
    while (st.queue.length > 0) {
      const name = st.queue.shift()!;
      let outcome;
      try {
        outcome = await generateForSelection({ llm: deps.llm, db: deps.db, week: st.week }, name);
      } catch (e) {
        log.error("gen_on_miss_failed", { userId: uid, name, ...errInfo(e) });
        st.failed.push(name);
        continue;
      }
      if (outcome.status === "added") {
        st.added.push(outcome.nameRu);
        continue;
      }
      pendingGen.set(uid, { ...st, dish: outcome.dish });
      await ctx.reply(outcome.text, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("✅ Сохранить", "gen_yes").text("❌ Пропустить", "gen_no"),
      });
      return;
    }
    pendingGen.delete(uid);
    await reply(ctx, genSummary(st));
  };

  const startGenQueue = async (ctx: Context, names: string[], wk: string): Promise<void> => {
    if (!ctx.from) return;
    await reply(ctx, `Не нашёл в каталоге: ${esc(names.join(", "))}. Сгенерировать рецепт?`);
    await offerNext(ctx, ctx.from.id, { queue: [...names], week: wk, added: [], skipped: [], failed: [] });
  };

  const replyNamesResult = async (ctx: Context, res: SelectResult, wk: string): Promise<void> => {
    if (res.text) await reply(ctx, res.text);
    if (res.unmatched.length) await startGenQueue(ctx, res.unmatched, wk);
  };

  const pendingDish = new Map<number, Dish>(); // userId → dish awaiting save-confirm
  const pendingDelete = new Map<number, number>(); // userId → dishId awaiting delete-confirm

  const startCustomDish = async (ctx: Context, name: string) => {
    const clean = name.trim();
    if (!clean) {
      await reply(ctx, "Напиши название блюда: «добавь блюдо шакшука».");
      return;
    }
    const res = await previewCustomDish({ llm: deps.llm, db: deps.db }, clean);
    if (res.status !== "preview" || !ctx.from) {
      await reply(ctx, res.text);
      return;
    }
    pendingDish.set(ctx.from.id, res.dish);
    await ctx.reply(res.text, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("✅ Сохранить", "dish_save").text("❌ Отмена", "dish_cancel"),
    });
  };

  const startDeleteDish = async (ctx: Context, name: string) => {
    const clean = name.trim();
    if (!clean) {
      await reply(ctx, "Напиши название: «удали блюдо борщ».");
      return;
    }
    const res = await previewDeleteDish({ llm: deps.llm, db: deps.db, dishes: catalogue() }, clean);
    if (res.status !== "confirm" || !ctx.from) {
      await reply(ctx, res.text);
      return;
    }
    pendingDelete.set(ctx.from.id, res.dishId);
    await ctx.reply(res.text, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("🗑 Удалить", "del_confirm").text("❌ Отмена", "del_cancel"),
    });
  };

  const scaleDish = (name: string, target: number) =>
    handleScaleDish({ llm: deps.llm, db: deps.db, dishes: catalogue() }, name, target);

  const matchText = (ctx: Context): string => (typeof ctx.match === "string" ? ctx.match : "");

  const guard = (fn: (ctx: Context) => Promise<void>) => async (ctx: Context) => {
    try {
      await fn(ctx);
    } catch (e) {
      await ctx.reply("Упс, что-то пошло не так. Попробуй позже.");
      log.error("handler_error", { userId: ctx.from?.id, ...errInfo(e) });
    }
  };

  bot.command("start", async (ctx) => {
    await ctx.reply(helpText(), { reply_markup: menus.main });
  });
  bot.command("digest", guard(suggest));
  bot.command("menu", guard(menu));
  bot.command("list", guard(list));
  bot.command("add", guard(async (ctx) => replyNamesResult(ctx, await addDishes(parseNames(matchText(ctx))), week())));
  bot.command("remove", guard(async (ctx) => reply(ctx, await removeDishes(parseNames(matchText(ctx))))));
  bot.command("recipe", guard((ctx) => startCustomDish(ctx, matchText(ctx))));
  bot.command("delrecipe", guard((ctx) => startDeleteDish(ctx, matchText(ctx))));
  bot.command("pantry", guard((ctx) => {
    const arg = matchText(ctx);
    const msg = arg.trim()
      ? handleAddPantry({ db: deps.db, week: week() }, arg.split(",").map((s) => s.trim()).filter(Boolean))
      : handleShowPantry({ db: deps.db, week: week() });
    return reply(ctx, msg);
  }));

  bot.on("message:text", guard(async (ctx) => {
    const text = ctx.message?.text ?? "";
    const intent = routeMessage(text) ?? (await classifyIntent(deps.llm, text));
    switch (intent.kind) {
      case "select_dishes":
        await replyNamesResult(ctx, await handleSelect({ llm: deps.llm, db: deps.db, dishes: catalogue(), week: week() }, intent.dishNames), week());
        break;
      case "add_dishes":
        await replyNamesResult(ctx, await addDishes(intent.dishNames), week());
        break;
      case "remove_dishes":
        await reply(ctx, await removeDishes(intent.dishNames));
        break;
      case "add_custom_dish":
        await startCustomDish(ctx, intent.dishNames[0] ?? "");
        break;
      case "delete_dish":
        await startDeleteDish(ctx, intent.dishNames[0] ?? "");
        break;
      case "add_pantry":
        await reply(ctx, handleAddPantry({ db: deps.db, week: week() }, intent.dishNames));
        break;
      case "remove_pantry":
        await reply(ctx, handleRemovePantry({ db: deps.db, week: week() }, intent.dishNames));
        break;
      case "show_pantry":
        await reply(ctx, handleShowPantry({ db: deps.db, week: week() }));
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

  bot.callbackQuery("gen_yes", guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from?.id;
    const st = uid !== undefined ? pendingGen.get(uid) : undefined;
    if (uid === undefined || !st) {
      await reply(ctx, "Нет блюда для сохранения — начни заново.");
      return;
    }
    pendingGen.delete(uid);
    saveDishToWeek({ db: deps.db }, st.dish, st.week);
    st.added.push(st.dish.nameRu);
    await offerNext(ctx, uid, { queue: st.queue, week: st.week, added: st.added, skipped: st.skipped, failed: st.failed });
  }));

  bot.callbackQuery("gen_no", guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from?.id;
    const st = uid !== undefined ? pendingGen.get(uid) : undefined;
    if (uid === undefined || !st) {
      await reply(ctx, "Нечего пропускать — начни заново.");
      return;
    }
    pendingGen.delete(uid);
    st.skipped.push(st.dish.nameRu);
    await offerNext(ctx, uid, { queue: st.queue, week: st.week, added: st.added, skipped: st.skipped, failed: st.failed });
  }));

  bot.callbackQuery("dish_save", guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from?.id;
    const dish = uid !== undefined ? pendingDish.get(uid) : undefined;
    if (uid === undefined || !dish) {
      await reply(ctx, "Нет блюда для сохранения — сгенерируй заново.");
      return;
    }
    pendingDish.delete(uid);
    const msg = confirmCustomDish({ db: deps.db }, dish);
    await reply(ctx, msg);
  }));

  bot.callbackQuery("dish_cancel", guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.from) pendingDish.delete(ctx.from.id);
    await reply(ctx, "Отменил, в каталог не добавил.");
  }));

  bot.callbackQuery("del_confirm", guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    const uid = ctx.from?.id;
    const dishId = uid !== undefined ? pendingDelete.get(uid) : undefined;
    if (uid === undefined || dishId === undefined) {
      await reply(ctx, "Нечего удалять — попробуй заново.");
      return;
    }
    pendingDelete.delete(uid);
    const msg = confirmDeleteDish({ db: deps.db }, dishId);
    await reply(ctx, msg);
  }));

  bot.callbackQuery("del_cancel", guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.from) pendingDelete.delete(ctx.from.id);
    await reply(ctx, "Отменил, блюдо не удалил.");
  }));

  return bot;
}
