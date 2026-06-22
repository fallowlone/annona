import type { Dish, Offer } from "../types";
import type { Matcher } from "../matcher";
import { rankDishes } from "../recommender";
import type { Database } from "bun:sqlite";
import type { Llm } from "../llm/llm";
import { estimateDishCost } from "../cost";
import { resolveDishes } from "./resolve";
import { planWeek } from "../planner";
import { buildGroupedList } from "../shoppingList";
import { scaleIngredients } from "../scale";
import { coverageDays } from "../portions";
import { addToSelection, removeFromSelection, saveSelection, getSelection } from "../recipes/selectionStore";
import { generateDish, insertDish, deleteDish, dishIdByName } from "../recipes/recipeStore";
import type { Ingredient } from "../types";
import { getPantry, addToPantry, removeFromPantry } from "../recipes/pantryStore";

const DEFAULT_COVERAGE_MIN = 0.7;
const DEFAULT_DIGEST_LIMIT = 5;
const DEFAULT_HOUSEHOLD = 2;

/** Render one ingredient with an optional quantity, or "по вкусу" when unknown. */
function fmtIngredient(i: Ingredient): string {
  if (i.qty === null) return `• ${i.canonical} — по вкусу`;
  return `• ${i.canonical} — ${i.qty}${i.unit ? ` ${i.unit}` : ""}`;
}

export function isAllowed(userId: number | undefined, allowed: number[]): boolean {
  return userId !== undefined && allowed.includes(userId);
}

export async function handleRecommend(deps: {
  dishes: Dish[];
  matcher: Matcher;
  coverageMin?: number;
  limit?: number;
  householdSize?: number;
}): Promise<string> {
  const coverageMin = deps.coverageMin ?? DEFAULT_COVERAGE_MIN;
  const limit = deps.limit ?? DEFAULT_DIGEST_LIMIT;
  const household = deps.householdSize ?? DEFAULT_HOUSEHOLD;

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
    const covers = coverageDays(r.dish.servings, household);
    lines.push(
      `🍲 *${r.dish.nameRu}* — ${r.onOfferCount}/${total} ингр. в акции · на ${r.dish.servings} порц. · хватит ~${covers}дн (семья ${household}) · ~${r.estTotal.toFixed(2)}€ · хранится ~${keeps} дн.`
    );
  }
  return lines.join("\n").trim();
}

const NO_SELECTION = "Сначала выбери блюда: напиши их через запятую, например «борщ, карбонара, плов».";

export type SelectResult = { text: string; unmatched: string[] };

export function helpText(): string {
  return [
    "Я подскажу, что выгодно готовить на этой неделе и где дешевле купить.",
    "",
    "• Напиши блюда через запятую (например «борщ, карбонара, плов») — соберу меню.",
    "• «добавь плов» / «убери борщ» — правка меню на неделю.",
    "• «добавь блюдо шакшука» — своё блюдо в каталог.",
    "• «удали блюдо шакшука» — убрать блюдо из каталога.",
    "• «плов на 8 порций» — пересчёт ингредиентов.",
    "• «у меня есть рис, лук» — учту дома, уберу из списка.",
    "• /digest — что выгодно приготовить.",
    "• /menu — меню на неделю.",
    "• /list — список покупок по магазинам.",
  ].join("\n");
}

/** Resolve free-text dish names to catalogue ids, persist them for the week, confirm. */
export async function handleSelect(
  deps: { llm: Llm; db: Database; dishes: Dish[]; week: string },
  dishNames: string[]
): Promise<SelectResult> {
  const { matched, unmatched } = await resolveDishes(deps.llm, deps.dishes, dishNames);
  if (matched.length === 0 && unmatched.length === 0) {
    return { text: "Не понял, какие блюда добавить. " + NO_SELECTION, unmatched: [] };
  }
  if (matched.length === 0) return { text: "", unmatched };
  saveSelection(deps.db, deps.week, matched.map((d) => d.id as number));
  const names = matched.map((d) => d.nameRu).join(", ");
  const text = `Записал на эту неделю: ${names}.\n\n/menu — меню на неделю · /list — список покупок.`;
  return { text, unmatched };
}

/** Render the weekly menu from the saved selection, with an approximate per-dish cost. */
export async function handleMenu(deps: {
  db: Database;
  dishes: Dish[];
  matcher: Matcher;
  week: string;
  menuDays: number;
  householdSize?: number;
}): Promise<string> {
  const ids = getSelection(deps.db, deps.week);
  if (!ids || ids.length === 0) return NO_SELECTION;

  const household = deps.householdSize ?? DEFAULT_HOUSEHOLD;
  const byId = new Map(deps.dishes.filter((d) => d.id !== undefined).map((d) => [d.id as number, d]));
  const chosen = ids.map((id) => byId.get(id)).filter((d): d is Dish => d !== undefined);
  const firsts = chosen.filter((d) => d.course === "first");
  const seconds = chosen.filter((d) => d.course !== "first");
  const menu = planWeek(firsts, seconds, deps.menuDays);

  const cost = new Map<number, number>();
  for (const d of chosen) cost.set(d.id as number, await estimateDishCost(deps.matcher, d));

  const cell = (dish: Dish | null): string =>
    dish ? `${dish.nameRu} ~${(cost.get(dish.id as number) ?? 0).toFixed(2)}€ (~${coverageDays(dish.servings, household)}дн)` : "—";

  const labels = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  const lines = [`📅 Меню на неделю (семья ${household}) · цены по акциям:\n`];
  for (const d of menu.days) {
    const label = labels[(d.day - 1) % 7] ?? `День ${d.day}`;
    lines.push(`*${label}*: 🥣 ${cell(d.first)} · 🍽 ${cell(d.second)}`);
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
  householdSize?: number;
}): Promise<string> {
  const ids = getSelection(deps.db, deps.week);
  if (!ids || ids.length === 0) return NO_SELECTION;

  const household = deps.householdSize ?? DEFAULT_HOUSEHOLD;
  const byId = new Map(deps.dishes.filter((d) => d.id !== undefined).map((d) => [d.id as number, d]));
  const chosen = ids.map((id) => byId.get(id)).filter((d): d is Dish => d !== undefined);
  const pantry = new Set(getPantry(deps.db, deps.week));
  const { groups, missing, inPantry } = await buildGroupedList(chosen, deps.matcher, deps.plz, household, pantry);

  if (groups.length === 0 && missing.length === 0) return "Список пуст.";

  const lines = [`🛒 Список покупок (на ${household} порц.):`];
  for (const g of groups) {
    lines.push(`\n*${g.storeName}* — [на карте](${g.mapsUrl})`);
    for (const it of g.items) {
      const qty = it.qty !== null ? ` — ${it.qty}${it.unit ? ` ${it.unit}` : ""}` : "";
      lines.push(`• ${it.ingredient}${qty}: ${it.product} — ${it.price.toFixed(2)}€`);
    }
  }
  if (missing.length) lines.push(`\n*Докупить (не в акции):* ${missing.join(", ")}`);

  const costLines = await Promise.all(
    chosen.map(async (d) => `• ${d.nameRu} — ~${(await estimateDishCost(deps.matcher, d)).toFixed(2)}€`)
  );
  const total = (
    await Promise.all(chosen.map((d) => estimateDishCost(deps.matcher, d)))
  ).reduce((a, b) => a + b, 0);
  if (costLines.length) {
    lines.push(`\n💰 *Примерно по блюдам (по акциям):*`);
    lines.push(...costLines);
    lines.push(`Итого: ~${total.toFixed(2)}€`);
  }

  if (inPantry.length) lines.push(`\n✅ Уже дома: ${inPantry.join(", ")}`);
  return lines.join("\n");
}

type EditDeps = { llm: Llm; db: Database; dishes: Dish[]; week: string };

/** Resolve names and merge them into the week's selection (keeps the rest). */
export async function handleAddDishes(deps: EditDeps, dishNames: string[]): Promise<SelectResult> {
  const { matched, unmatched } = await resolveDishes(deps.llm, deps.dishes, dishNames);
  if (matched.length === 0 && unmatched.length === 0) {
    return { text: "Не понял, какие блюда добавить. " + NO_SELECTION, unmatched: [] };
  }
  if (matched.length > 0) {
    addToSelection(deps.db, deps.week, matched.map((d) => d.id as number));
  }
  const text =
    matched.length > 0
      ? `✅ Добавил: ${matched.map((d) => d.nameRu).join(", ")}.\n\n/menu — меню · /list — список покупок.`
      : "";
  return { text, unmatched };
}

/** Resolve names and remove them from the week's selection (no-op if absent). */
export async function handleRemoveDishes(deps: EditDeps, dishNames: string[]): Promise<string> {
  const { matched, unmatched } = await resolveDishes(deps.llm, deps.dishes, dishNames);
  if (matched.length === 0) return "Не понял, какие блюда убрать.";
  removeFromSelection(deps.db, deps.week, matched.map((d) => d.id as number));
  let msg = `✅ Убрал: ${matched.map((d) => d.nameRu).join(", ")}.`;
  if (unmatched.length) msg += `\nНе нашёл: ${unmatched.join(", ")}.`;
  return msg;
}

/** True if a dish with this name_ru (case-insensitive) is already catalogued. */
function dishExists(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM dishes WHERE lower(name_ru) = lower(?)").get(name) !== null;
}

/** Human-readable preview of a generated dish, asking the user to confirm. */
function renderDishPreview(dish: Dish): string {
  const course = dish.course === "first" ? "первое" : "второе";
  const ings = dish.ingredients
    .map((i) => (i.qty !== null ? `${i.canonical} ${i.qty}${i.unit ? ` ${i.unit}` : ""}` : i.canonical))
    .join(", ");
  return [
    `🍽 *${dish.nameRu}* — добавить в каталог?`,
    `${course} · ${dish.servings} порц. · хранится ~${dish.keepsDays ?? 1} дн.`,
    `Ингредиенты: ${ings}`,
  ].join("\n");
}

export type CustomDishPreview =
  | { status: "exists"; text: string }
  | { status: "preview"; text: string; dish: Dish };

/** Generate a dish from its name via the LLM and return a preview — does NOT persist. */
export async function previewCustomDish(
  deps: { llm: Llm; db: Database },
  name: string
): Promise<CustomDishPreview> {
  if (dishExists(deps.db, name)) return { status: "exists", text: `«${name}» уже в каталоге.` };
  const dish = await generateDish(deps.llm, name);
  if (dishExists(deps.db, dish.nameRu)) return { status: "exists", text: `«${dish.nameRu}» уже в каталоге.` };
  return { status: "preview", text: renderDishPreview(dish), dish };
}

/** Persist a previewed dish after the user confirms. Idempotent by name_ru. */
export function confirmCustomDish(deps: { db: Database }, dish: Dish): string {
  if (dishExists(deps.db, dish.nameRu)) return `«${dish.nameRu}» уже в каталоге.`;
  insertDish(deps.db, dish);
  return `✅ ${dish.nameRu} (${dish.servings} порц., ${dish.ingredients.length} ингр.) добавил в каталог.`;
}

export type GenOutcome =
  | { status: "preview"; dish: Dish; text: string }
  | { status: "added"; nameRu: string };

/**
 * Generate a dish from a free-text name for the weekly-selection miss path.
 * If the generated dish's canonical name already exists in the catalogue, add
 * that existing dish to the week and report "added"; otherwise return a preview
 * (nothing persisted) for the user to confirm.
 */
export async function generateForSelection(
  deps: { llm: Llm; db: Database; week: string },
  name: string
): Promise<GenOutcome> {
  const dish = await generateDish(deps.llm, name);
  const existingId = dishIdByName(deps.db, dish.nameRu);
  if (existingId !== null) {
    addToSelection(deps.db, deps.week, [existingId]);
    return { status: "added", nameRu: dish.nameRu };
  }
  return { status: "preview", dish, text: renderDishPreview(dish) };
}

/** Persist a previewed dish (idempotent by name_ru) and add it to the week's selection. */
export function saveDishToWeek(deps: { db: Database }, dish: Dish, week: string): void {
  const id = dishIdByName(deps.db, dish.nameRu) ?? insertDish(deps.db, dish);
  addToSelection(deps.db, week, [id]);
}

export type DeleteDishPreview =
  | { status: "notfound"; text: string }
  | { status: "confirm"; text: string; dishId: number; nameRu: string };

/** Resolve a name to a catalogue dish and preview its deletion — does NOT delete. */
export async function previewDeleteDish(
  deps: { llm: Llm; db: Database; dishes: Dish[] },
  name: string
): Promise<DeleteDishPreview> {
  const { matched } = await resolveDishes(deps.llm, deps.dishes, [name]);
  const dish = matched[0];
  if (!dish || dish.id === undefined) {
    return { status: "notfound", text: `Не нашёл блюдо «${name}» в каталоге.` };
  }
  return { status: "confirm", text: `🗑 Удалить «${dish.nameRu}» из каталога?`, dishId: dish.id, nameRu: dish.nameRu };
}

/** Delete a catalogue dish by id after the user confirms. */
export function confirmDeleteDish(deps: { db: Database }, dishId: number): string {
  const row = deps.db.query("SELECT name_ru FROM dishes WHERE id = ?").get(dishId) as { name_ru: string } | null;
  if (!row) return "Блюдо уже удалено из каталога.";
  deleteDish(deps.db, dishId);
  return `🗑 Удалил «${row.name_ru}» из каталога.`;
}

/** Scale one dish's ingredients to the requested number of portions. */
export async function handleScaleDish(
  deps: { llm: Llm; db: Database; dishes: Dish[] },
  name: string,
  targetServings: number
): Promise<string> {
  const { matched } = await resolveDishes(deps.llm, deps.dishes, [name]);
  const dish = matched[0];
  if (!dish) return `Не нашёл блюдо «${name}».`;
  const scaled = scaleIngredients(dish.ingredients, dish.servings, targetServings);
  const lines = scaled.map(fmtIngredient);
  return `🍳 ${dish.nameRu} ×${targetServings} порц.:\n${lines.join("\n")}`;
}

type PantryDeps = { db: Database; week: string };

/** Add free-text items to the week's pantry. */
export function handleAddPantry(deps: PantryDeps, names: string[]): string {
  const items = names.map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (items.length === 0) return "Что у тебя есть дома? Например: «у меня есть рис, лук».";
  addToPantry(deps.db, deps.week, items);
  return `✅ Дома есть: ${items.join(", ")}. Учту в /list.`;
}

/** Remove items from the week's pantry. */
export function handleRemovePantry(deps: PantryDeps, names: string[]): string {
  const items = names.map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (items.length === 0) return "Что закончилось? Например: «закончился рис».";
  removeFromPantry(deps.db, deps.week, items);
  return `✅ Убрал из дома: ${items.join(", ")}.`;
}

/** Show the week's pantry. */
export function handleShowPantry(deps: PantryDeps): string {
  const items = getPantry(deps.db, deps.week);
  if (items.length === 0) return "Дома пока ничего не отмечено. Напиши «у меня есть рис, лук».";
  return `🏠 Дома есть: ${items.join(", ")}`;
}
