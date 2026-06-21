import { z } from "zod";
import type { Llm } from "../llm/llm";
import type { Intent } from "../types";

const IntentSchema = z.object({
  kind: z.enum(["suggest", "select_dishes", "show_menu", "show_list", "help"]),
  dishNames: z.array(z.string()),
});

/** Route a Russian/Ukrainian free-text message to a bot intent (LLM-backed). */
export async function classifyIntent(llm: Llm, text: string): Promise<Intent> {
  return llm.structured({
    system:
      "You route a Russian/Ukrainian grocery-bot message to ONE intent. " +
      "'suggest' = the user asks what is worth cooking / what is on offer this week. " +
      "'select_dishes' = the user lists dishes they want to cook this week — extract those dish names into dishNames. " +
      "'show_menu' = show the planned weekly menu. 'show_list' = show the shopping list. " +
      "'help' = anything unclear or a greeting. dishNames MUST be [] unless kind is 'select_dishes'.",
    prompt: `Message: "${text}"`,
    toolName: "route_intent",
    description: "Classify the message intent",
    schema: IntentSchema,
  });
}
