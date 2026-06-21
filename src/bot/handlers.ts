import type { Dish, Offer } from "../types";
import type { Matcher } from "../matcher";
import { rankDishes } from "../recommender";

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
