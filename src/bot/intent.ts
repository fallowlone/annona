import { z } from "zod";
import type { Llm } from "../llm/llm";
import type { Intent, IntentKind } from "../types";

// Kept in lockstep with IntentKind via `satisfies` so the classifier schema and
// the bot.ts dispatch switch can never silently drift apart.
const INTENT_KINDS = [
  "suggest",
  "select_dishes",
  "add_dishes",
  "remove_dishes",
  "add_custom_dish",
  "delete_dish",
  "add_pantry",
  "remove_pantry",
  "show_pantry",
  "scale_dish",
  "show_menu",
  "show_list",
  "help",
] as const satisfies readonly IntentKind[];

const IntentSchema = z.object({
  kind: z.enum(INTENT_KINDS),
  dishNames: z.array(z.string()),
  targetServings: z.number().int().positive().optional(),
});

/** Route a Russian/Ukrainian free-text message to a bot intent (LLM-backed). */
export async function classifyIntent(llm: Llm, text: string): Promise<Intent> {
  return llm.structured({
    system:
      "You route a Russian/Ukrainian grocery-bot message to ONE intent kind. Extract dish/ingredient names into dishNames; it MUST be [] when no names apply.\n" +
      "- suggest: asks what is worth cooking / what is on offer this week.\n" +
      "- select_dishes: lists dishes to cook this week (replaces the plan).\n" +
      "- add_dishes: add dish(es) to the existing week plan ('добавь плов').\n" +
      "- remove_dishes: remove dish(es) from the week plan ('убери борщ').\n" +
      "- add_custom_dish: add a brand-new dish to the catalogue ('добавь блюдо шакшука'); one name.\n" +
      "- delete_dish: remove a dish from the catalogue ('удали блюдо борщ'); one name.\n" +
      "- add_pantry: items the user already has at home ('дома есть рис, лук').\n" +
      "- remove_pantry: items that ran out ('закончился рис').\n" +
      "- show_pantry: show what is at home.\n" +
      "- scale_dish: recompute one dish for N servings ('плов на 8 порций'); put the dish in dishNames[0] and N in targetServings.\n" +
      "- show_menu: show the weekly menu. show_list: show the shopping list.\n" +
      "- help: anything unclear or a greeting.\n" +
      "Set targetServings ONLY for scale_dish.",
    prompt: `Message: "${text}"`,
    toolName: "route_intent",
    description: "Classify the message intent",
    schema: IntentSchema,
  });
}
