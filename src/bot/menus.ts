import { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";
import type { Database } from "bun:sqlite";
import type { Matcher } from "../matcher";
import type { Llm } from "../llm/llm";
import { handleMenu, handleList, handleRecommend, handleShowPantry } from "./handlers";
import { listDishes } from "../recipes/recipeStore";

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

export function createMenus(deps: MenuDeps): { main: Menu<Context> } {
  const main = new Menu<Context>("annona-main")
    .text("📋 Меню недели", async (ctx) => {
      await ctx.reply(
        await handleMenu({ db: deps.db, dishes: listDishes(deps.db), matcher: deps.matcher, week: deps.week(), menuDays: deps.menuDays, householdSize: deps.householdSize }),
        { parse_mode: "Markdown" }
      );
    })
    .text("🛒 Покупки", async (ctx) => {
      await ctx.reply(
        await handleList({ db: deps.db, dishes: listDishes(deps.db), matcher: deps.matcher, week: deps.week(), plz: deps.plz, householdSize: deps.householdSize }),
        { parse_mode: "Markdown" }
      );
    })
    .row()
    .text("🍳 Что приготовить", async (ctx) => {
      await ctx.reply(
        await handleRecommend({ dishes: listDishes(deps.db), matcher: deps.matcher, coverageMin: deps.coverageMin, limit: deps.digestLimit, householdSize: deps.householdSize }),
        { parse_mode: "Markdown" }
      );
    })
    .text("🥫 Кладовка", async (ctx) => {
      await ctx.reply(handleShowPantry({ db: deps.db, week: deps.week() }));
    })
    .row();
  // Task 6 attaches the "📖 Рецепты" submenu + "➕ Добавить" here.

  return { main };
}
