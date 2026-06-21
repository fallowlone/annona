import { z } from "zod";
import type { Llm } from "../llm/llm";
import type { Dish } from "../types";

const ResolveSchema = z.object({
  matchedIds: z.array(z.number().int()),
  unmatched: z.array(z.string()),
});

export type ResolveResult = { matched: Dish[]; unmatched: string[] };

/** Map free-text dish names to catalogue dish ids via the LLM (RU/UA, course-aware). */
export async function resolveDishes(
  llm: Llm,
  catalogue: Dish[],
  names: string[]
): Promise<ResolveResult> {
  if (names.length === 0) return { matched: [], unmatched: [] };

  const withId = catalogue.filter((d) => d.id !== undefined);
  const list = withId
    .map((d) => `${d.id}: ${d.nameRu}${d.nameUa ? ` / ${d.nameUa}` : ""} (${d.course ?? "?"})`)
    .join("\n");

  const out = await llm.structured({
    system:
      "Match each user dish name to the closest dish id from the catalogue (handle RU/UA spelling " +
      "and synonyms). Put any user name with no good catalogue match into 'unmatched'.",
    prompt: `Catalogue (id: name (course)):\n${list}\n\nUser dishes: ${names.join(", ")}`,
    toolName: "resolve_dishes",
    description: "Resolve user dish names to catalogue ids",
    schema: ResolveSchema,
    maxTokens: 1024,
  });

  const byId = new Map(withId.map((d) => [d.id as number, d]));
  const matched = out.matchedIds
    .map((id) => byId.get(id))
    .filter((d): d is Dish => d !== undefined);
  return { matched, unmatched: out.unmatched };
}
