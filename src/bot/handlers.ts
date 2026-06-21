import type { Dish, Offer } from "../types";
import type { Matcher } from "../matcher";
import { rankDishes } from "../recommender";
import type { Database } from "bun:sqlite";
import type { Llm } from "../llm/llm";
import { resolveDishes } from "./resolve";
import { planWeek } from "../planner";
import { buildGroupedList } from "../shoppingList";
import { saveSelection, getSelection } from "../recipes/selectionStore";

const DEFAULT_COVERAGE_MIN = 0.7;
const DEFAULT_DIGEST_LIMIT = 5;

export function isAllowed(userId: number | undefined, allowed: number[]): boolean {
  return userId !== undefined && allowed.includes(userId);
}

export async function handleRecommend(deps: {
  dishes: Dish[];
  matcher: Matcher;
  coverageMin?: number;
  limit?: number;
}): Promise<string> {
  const coverageMin = deps.coverageMin ?? DEFAULT_COVERAGE_MIN;
  const limit = deps.limit ?? DEFAULT_DIGEST_LIMIT;

  const canonicals = [
    ...new Set(deps.dishes.flatMap((d) => d.ingredients.map((i) => i.canonical))),
  ];
  const matches = new Map<string, Offer | null>();
  for (const c of canonicals) {
    matches.set(c, await deps.matcher.matchIngredient(c));
  }

  const top = rankDishes(deps.dishes, matches)
    .filter((r) => r.coverage >= coverageMin)
    .slice(0, limit);

  const pct = Math.round(coverageMin * 100);
  if (top.length === 0) {
    return `На этой неделе нет блюд, где хотя бы ${pct}% ингредиентов в акции 😕`;
  }

  const lines: string[] = ["🛒 Выгодно приготовить на этой неделе:\n"];
  for (const r of top) {
    const total = r.dish.ingredients.length;
    const keeps = r.dish.keepsDays ?? 1;
    lines.push(
      `🍲 *${r.dish.nameRu}* — ${r.onOfferCount}/${total} ингр. в акции · на ${r.dish.servings} порц. · ~${r.estTotal.toFixed(2)}€ · хранится ~${keeps} дн.`
    );
  }
  return lines.join("\n").trim();
}

const NO_SELECTION = "Сначала выбери блюда: напиши их через запятую, например «борщ, карбонара, плов».";

export function helpText(): string {
  return [
    "Я подскажу, что выгодно готовить на этой неделе и где дешевле купить.",
    "",
    "• Напиши блюда через запятую (например «борщ, карбонара, плов») — соберу меню.",
    "• /digest — что выгодно приготовить.",
    "• /menu — меню на неделю.",
    "• /list — список покупок по магазинам.",
  ].join("\n");
}

/** Resolve free-text dish names to catalogue ids, persist them for the week, confirm. */
export async function handleSelect(
  deps: { llm: Llm; db: Database; dishes: Dish[]; week: string },
  dishNames: string[]
): Promise<string> {
  const { matched, unmatched } = await resolveDishes(deps.llm, deps.dishes, dishNames);
  if (matched.length === 0) {
    return "Не понял, какие блюда добавить. " + NO_SELECTION;
  }
  saveSelection(deps.db, deps.week, matched.map((d) => d.id as number));
  const names = matched.map((d) => d.nameRu).join(", ");
  let msg = `Записал на эту неделю: ${names}.`;
  if (unmatched.length) msg += `\nНе нашёл: ${unmatched.join(", ")}.`;
  msg += "\n\n/menu — меню на неделю · /list — список покупок.";
  return msg;
}

/** Render the weekly menu from the saved selection. */
export function handleMenu(deps: {
  db: Database;
  dishes: Dish[];
  week: string;
  menuDays: number;
}): string {
  const ids = getSelection(deps.db, deps.week);
  if (!ids || ids.length === 0) return NO_SELECTION;

  const byId = new Map(deps.dishes.filter((d) => d.id !== undefined).map((d) => [d.id as number, d]));
  const chosen = ids.map((id) => byId.get(id)).filter((d): d is Dish => d !== undefined);
  const firsts = chosen.filter((d) => d.course === "first");
  const seconds = chosen.filter((d) => d.course !== "first");
  const menu = planWeek(firsts, seconds, deps.menuDays);

  const labels = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  const lines = ["📅 Меню на неделю:\n"];
  for (const d of menu.days) {
    const label = labels[(d.day - 1) % 7] ?? `День ${d.day}`;
    const first = d.first ? d.first.nameRu : "—";
    const second = d.second ? d.second.nameRu : "—";
    lines.push(`*${label}*: 🥣 ${first} · 🍽 ${second}`);
  }
  return lines.join("\n");
}

/** Render the store-grouped shopping list for the saved selection. */
export async function handleList(deps: {
  db: Database;
  dishes: Dish[];
  matcher: Matcher;
  week: string;
  plz: number;
}): Promise<string> {
  const ids = getSelection(deps.db, deps.week);
  if (!ids || ids.length === 0) return NO_SELECTION;

  const byId = new Map(deps.dishes.filter((d) => d.id !== undefined).map((d) => [d.id as number, d]));
  const chosen = ids.map((id) => byId.get(id)).filter((d): d is Dish => d !== undefined);
  const { groups, missing } = await buildGroupedList(chosen, deps.matcher, deps.plz);

  if (groups.length === 0 && missing.length === 0) return "Список пуст.";

  const lines = ["🛒 Список покупок:"];
  for (const g of groups) {
    lines.push(`\n*${g.storeName}* — [на карте](${g.mapsUrl})`);
    for (const it of g.items) {
      lines.push(`• ${it.ingredient}: ${it.product} — ${it.price.toFixed(2)}€`);
    }
  }
  if (missing.length) lines.push(`\n*Докупить (не в акции):* ${missing.join(", ")}`);
  return lines.join("\n");
}
