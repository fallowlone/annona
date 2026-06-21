import { test, expect } from "bun:test";
import { openDb } from "../src/db/db";
import { createMatcher } from "../src/matcher";
import type { Offer } from "../src/types";
import type { Llm } from "../src/llm/llm";
import type { OfferProvider } from "../src/providers/marktguru";

const offer = (over: Partial<Offer>): Offer => ({
  externalId: 1, store: "edeka", storeName: "Edeka", product: "Schmand",
  price: 1.49, oldPrice: null, referencePrice: 1.49, unit: "St",
  validFrom: "2026-06-22", validTo: "2026-06-28", ...over,
});

const llmStub = (terms: string[]): Llm => ({
  async structured() { return { terms } as never; },
});

test("searchTerms hits synonym cache without calling the LLM", async () => {
  const db = openDb(":memory:");
  db.run("INSERT INTO synonyms(canonical_name,search_terms_de,updated_at) VALUES(?,?,?)",
    ["сметана", JSON.stringify(["Schmand", "Saure Sahne"]), "2026-06-21"]);
  let called = false;
  const llm: Llm = { async structured() { called = true; return { terms: [] } as never; } };
  const provider: OfferProvider = { async search() { return []; } };
  const m = createMatcher({ db, llm, provider, week: "2026-W26" });
  expect(await m.searchTerms("сметана")).toEqual(["Schmand", "Saure Sahne"]);
  expect(called).toBe(false);
});

test("matchIngredient returns the cheapest offer across all terms", async () => {
  const db = openDb(":memory:");
  const provider: OfferProvider = {
    async search(q) {
      if (q === "Schmand") return [offer({ externalId: 1, referencePrice: 1.49, storeName: "Edeka" })];
      return [offer({ externalId: 2, referencePrice: 0.99, storeName: "Kaufland" })];
    },
  };
  const m = createMatcher({ db, llm: llmStub(["Schmand", "Saure Sahne"]), provider, week: "2026-W26" });
  const best = await m.matchIngredient("сметана");
  expect(best!.storeName).toBe("Kaufland");
  expect(best!.referencePrice).toBe(0.99);
  // second call served from match_cache (provider would throw if hit again)
  const m2 = createMatcher({
    db, llm: llmStub([]), week: "2026-W26",
    provider: { async search() { throw new Error("should be cached"); } },
  });
  const cached = await m2.matchIngredient("сметана");
  expect(cached!.storeName).toBe("Kaufland");
});
