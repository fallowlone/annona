import { Database } from "bun:sqlite";
import { z } from "zod";
import type { Llm } from "./llm/llm";
import type { OfferProvider } from "./providers/marktguru";
import type { Offer } from "./types";
import { dedupeOffers, effectiveUnitPrice } from "./normalize";
import { canonicalStore, type StoreKey } from "./stores";

const TermsSchema = z.object({ terms: z.array(z.string()).min(1).max(6) });

export interface Matcher {
  searchTerms(canonical: string): Promise<string[]>;
  matchIngredient(canonical: string): Promise<Offer | null>;
}

export function createMatcher(deps: {
  db: Database;
  llm: Llm;
  provider: OfferProvider;
  week: () => string;
  whitelist?: ReadonlySet<StoreKey>;
}): Matcher {
  const { db, llm, provider, whitelist } = deps;

  async function searchTerms(canonical: string): Promise<string[]> {
    const row = db
      .query("SELECT search_terms_de FROM synonyms WHERE canonical_name = ?")
      .get(canonical) as { search_terms_de: string } | null;
    if (row) return JSON.parse(row.search_terms_de) as string[];

    const out = await llm.structured({
      system: "Translate a Russian/Ukrainian grocery ingredient into German supermarket search terms.",
      prompt: `Ingredient: "${canonical}". Return up to 4 German product search terms a shopper would use.`,
      toolName: "german_terms",
      description: "German search terms for the ingredient",
      schema: TermsSchema,
    });

    db.run(
      "INSERT OR REPLACE INTO synonyms(canonical_name,search_terms_de,updated_at) VALUES(?,?,?)",
      [canonical, JSON.stringify(out.terms), new Date().toISOString()]
    );
    return out.terms;
  }

  async function matchIngredient(canonical: string): Promise<Offer | null> {
    const week = deps.week();
    const cached = db
      .query(
        "SELECT offer_json FROM match_cache WHERE ingredient_canonical = ? AND week = ?"
      )
      .get(canonical, week) as { offer_json: string | null } | null;
    if (cached) return cached.offer_json ? (JSON.parse(cached.offer_json) as Offer) : null;

    const terms = await searchTerms(canonical);
    const found: Offer[] = [];
    for (const t of terms) found.push(...(await provider.search(t)));
    const inScope = whitelist
      ? found.filter((o) => {
          const key = canonicalStore(o.store) ?? canonicalStore(o.storeName);
          return key !== null && whitelist.has(key);
        })
      : found;
    const deduped = dedupeOffers(inScope);
    const best = deduped.length
      ? deduped.reduce((a, b) => (effectiveUnitPrice(b) < effectiveUnitPrice(a) ? b : a))
      : null;

    db.run(
      "INSERT OR REPLACE INTO match_cache(ingredient_canonical,week,offer_json,created_at) VALUES(?,?,?,?)",
      [canonical, week, best ? JSON.stringify(best) : null, week]
    );
    return best;
  }

  return { searchTerms, matchIngredient };
}
