import type { Dish } from "../types";
import { esc } from "./format";

/** Clamp `page` into [0, pages-1] and return that slice of `items`. */
export function paginate<T>(
  items: T[],
  page: number,
  perPage: number
): { slice: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const clamped = Math.min(Math.max(page, 0), pages - 1);
  const start = clamped * perPage;
  return { slice: items.slice(start, start + perPage), page: clamped, pages };
}

/** Format one ingredient as "name qty unit" (or just "name" when qty is absent). */
function formatIngredient(i: Dish["ingredients"][number]): string {
  if (i.qty === null) return i.canonical;
  return `${i.canonical} ${i.qty}${i.unit ? ` ${i.unit}` : ""}`;
}

/** HTML dish card: name, meta, ingredients, and (if present) steps in an expandable blockquote. */
export function renderDishCard(dish: Dish, costText: string, steps: string | null): string {
  const course = dish.course === "first" ? "первое" : "второе";
  const ings = dish.ingredients.map(formatIngredient).join(", ");
  const lines = [
    `🍽 <b>${esc(dish.nameRu)}</b>`,
    `${course} · ${dish.servings} порц · ${esc(costText)} · хранится ~${dish.keepsDays ?? 1} дн`,
    `<b>Ингредиенты:</b> ${esc(ings)}`,
  ];
  if (steps) lines.push(`<blockquote expandable>${esc(steps)}</blockquote>`);
  return lines.join("\n");
}
