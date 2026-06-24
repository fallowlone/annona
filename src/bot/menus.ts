import { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";
import type { Database } from "bun:sqlite";
import type { Matcher } from "../matcher";
import type { Llm } from "../llm/llm";
import { handleMenu, handleList, handleRecommend, handleShowPantry } from "./handlers";
import {
  listDishes,
  dishSteps,
  saveDishSteps,
  generateSteps,
  deleteDish,
} from "../recipes/recipeStore";
import { addToSelection } from "../recipes/selectionStore";
import { paginate, renderDishCard } from "./recipeView";
import { estimateDishCost } from "../cost";
import { log, errInfo } from "../log";
import type { Dish } from "../types";

export type MenuDeps = {
  db: Database;
  matcher: Matcher;
  llm: Llm;
  menuDays: number;
  householdSize: number;
  plz: number;
  week: () => string;
  coverageMin?: number;
  digestLimit?: number;
};

const PER_PAGE = 6;

/** Format a dish cost as "~X.XX€ (по акциям)" via the matcher (cache-warm). */
async function costText(matcher: Matcher, dish: Dish): Promise<string> {
  const cost = await estimateDishCost(matcher, dish);
  return `~${cost.toFixed(2)}€ (по акциям)`;
}

export function createMenus(deps: MenuDeps): { main: Menu<Context> } {
  const browserPage = new Map<number, number>(); // userId → current recipe-browser page
  const selected = new Map<number, number>(); // userId → dish id whose card is open

  // ── Dish card ──────────────────────────────────────────────────────────────
  const card = new Menu<Context>("annona-card", { autoAnswer: false })
    .text("📖 Показать рецепт", async (ctx) => {
      const uid = ctx.from?.id ?? 0;
      const id = selected.get(uid);
      const dish = id !== undefined ? listDishes(deps.db).find((d) => d.id === id) : undefined;
      if (!dish || dish.id === undefined) {
        await ctx.answerCallbackQuery("Блюдо не найдено");
        return;
      }
      let steps = dishSteps(deps.db, dish.id);
      if (!steps) {
        try {
          steps = await generateSteps(deps.llm, dish);
          saveDishSteps(deps.db, dish.id, steps);
        } catch (e) {
          log.error("recipe_steps_failed", { userId: uid, dishId: dish.id, ...errInfo(e) });
          await ctx.answerCallbackQuery("Не получилось собрать рецепт, попробуй ещё раз");
          return;
        }
      }
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(renderDishCard(dish, await costText(deps.matcher, dish), steps), {
        parse_mode: "HTML",
      });
    })
    .text("➕ В меню", async (ctx) => {
      const uid = ctx.from?.id ?? 0;
      const id = selected.get(uid);
      if (id === undefined) {
        await ctx.answerCallbackQuery("Блюдо не найдено");
        return;
      }
      addToSelection(deps.db, deps.week(), [id]);
      await ctx.answerCallbackQuery("Добавил в меню недели");
    })
    .row()
    .text("🗑 Удалить", async (ctx) => {
      const uid = ctx.from?.id ?? 0;
      const id = selected.get(uid);
      if (id === undefined) {
        await ctx.answerCallbackQuery("Блюдо не найдено");
        return;
      }
      deleteDish(deps.db, id);
      selected.delete(uid);
      await ctx.answerCallbackQuery("Удалил из каталога");
      ctx.menu.nav("annona-recipes");
      await ctx.menu.update({ immediate: true });
    })
    .back("⬅️ Назад");

  // ── Recipe browser (paginated list) ──────────────────────────────────────────
  const recipes = new Menu<Context>("annona-recipes", { autoAnswer: false }).dynamic((ctx, range) => {
    const uid = ctx.from?.id ?? 0;
    const all = listDishes(deps.db);
    const { slice, page, pages } = paginate(all, browserPage.get(uid) ?? 0, PER_PAGE);
    browserPage.set(uid, page);

    for (const d of slice) {
      if (d.id === undefined) continue;
      range
        .submenu({ text: d.nameRu, payload: String(d.id) }, "annona-card", async (ctx) => {
          selected.set(uid, d.id as number);
          await ctx.editMessageText(
            renderDishCard(d, await costText(deps.matcher, d), dishSteps(deps.db, d.id as number)),
            { parse_mode: "HTML" }
          );
        })
        .row();
    }

    range
      .text("⬅️", async (ctx) => {
        browserPage.set(uid, Math.max((browserPage.get(uid) ?? 0) - 1, 0));
        ctx.menu.update();
        await ctx.answerCallbackQuery();
      })
      .text(`${page + 1}/${pages}`, (ctx) => ctx.answerCallbackQuery())
      .text("➡️", async (ctx) => {
        browserPage.set(uid, Math.min((browserPage.get(uid) ?? 0) + 1, pages - 1));
        ctx.menu.update();
        await ctx.answerCallbackQuery();
      })
      .row()
      .back("🏠 Домой");
  });

  // ── Hub ──────────────────────────────────────────────────────────────────────
  const main = new Menu<Context>("annona-main", { autoAnswer: false })
    .text("📋 Меню недели", async (ctx) => {
      await ctx.answerCallbackQuery();
      await ctx.reply(
        await handleMenu({ db: deps.db, dishes: listDishes(deps.db), matcher: deps.matcher, week: deps.week(), menuDays: deps.menuDays, householdSize: deps.householdSize }),
        { parse_mode: "HTML" }
      );
    })
    .text("🛒 Покупки", async (ctx) => {
      await ctx.answerCallbackQuery();
      await ctx.reply(
        await handleList({ db: deps.db, dishes: listDishes(deps.db), matcher: deps.matcher, week: deps.week(), plz: deps.plz, householdSize: deps.householdSize }),
        { parse_mode: "HTML" }
      );
    })
    .row()
    .text("🍳 Что приготовить", async (ctx) => {
      await ctx.answerCallbackQuery();
      await ctx.reply(
        await handleRecommend({ dishes: listDishes(deps.db), matcher: deps.matcher, coverageMin: deps.coverageMin, limit: deps.digestLimit, householdSize: deps.householdSize }),
        { parse_mode: "HTML" }
      );
    })
    .text("🥫 Кладовка", async (ctx) => {
      await ctx.answerCallbackQuery();
      await ctx.reply(handleShowPantry({ db: deps.db, week: deps.week() }), { parse_mode: "HTML" });
    })
    .row()
    .submenu("📖 Рецепты", "annona-recipes");

  // Register the submenu tree under the root; only the root is passed to bot.use().
  recipes.register(card);
  main.register(recipes);

  return { main };
}
