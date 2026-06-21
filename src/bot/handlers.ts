import type { Dish } from "../types";
import type { Matcher } from "../matcher";
import { rankDishes, buildShoppingList } from "../recommender";

export function isAllowed(userId: number | undefined, allowed: number[]): boolean {
  return userId !== undefined && allowed.includes(userId);
}

export async function handleRecommend(deps: {
  dishes: Dish[];
  matcher: Matcher;
  topN?: number;
}): Promise<string> {
  const topN = deps.topN ?? 3;
  const canonicals = [
    ...new Set(deps.dishes.flatMap((d) => d.ingredients.map((i) => i.canonical))),
  ];
  const matches = new Map();
  for (const c of canonicals) {
    matches.set(c, await deps.matcher.matchIngredient(c));
  }

  const ranked = rankDishes(deps.dishes, matches).slice(0, topN);
  if (ranked.length === 0 || ranked[0]?.onOfferCount === 0) {
    return "На этой неделе выгодных совпадений по акциям не нашёл 😕";
  }

  const lines: string[] = ["🛒 Выгодно приготовить на этой неделе:\n"];
  for (const r of ranked) {
    lines.push(
      `🍲 *${r.dish.nameRu}* — ${r.onOfferCount} ингр. на акции, ~${r.estTotal.toFixed(2)}€`
    );
    for (const item of buildShoppingList(r.dish, matches)) {
      lines.push(
        `   • ${item.ingredient}: ${item.product} — ${item.price.toFixed(2)}€ (${item.store})`
      );
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
