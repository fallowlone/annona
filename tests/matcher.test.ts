import { test, expect } from "bun:test";
import { openDb } from "../src/db/db";
import { createMatcher } from "../src/matcher";
import type { Offer } from "../src/types";
import type { Llm } from "../src/llm/llm";
import type { OfferProvider } from "../src/providers/marktguru";
import type { StoreKey } from "../src/stores";

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

test("matchIngredient returns the cheapest offer across all terms and cache-hit guards BOTH provider AND LLM", async () => {
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
  // second call served from match_cache — both provider AND LLM throw if invoked
  const throwingLlm: Llm = { async structured() { throw new Error("LLM must not be called on cache hit"); } };
  const m2 = createMatcher({
    db, llm: throwingLlm, week: "2026-W26",
    provider: { async search() { throw new Error("provider must not be called on cache hit"); } },
  });
  const cached = await m2.matchIngredient("сметана");
  expect(cached!.storeName).toBe("Kaufland");
});

test("searchTerms cache-MISS calls LLM and persists terms to synonyms table", async () => {
  const db = openDb(":memory:");
  let called = false;
  const llm: Llm = {
    async structured() {
      called = true;
      return { terms: ["Schmand", "Saure Sahne"] } as never;
    },
  };
  const provider: OfferProvider = { async search() { return []; } };
  const m = createMatcher({ db, llm, provider, week: "2026-W26" });
  const terms = await m.searchTerms("сметана");
  expect(terms).toEqual(["Schmand", "Saure Sahne"]);
  expect(called).toBe(true);
  // verify persisted to synonyms table
  const row = db
    .query("SELECT search_terms_de FROM synonyms WHERE canonical_name = ?")
    .get("сметана") as { search_terms_de: string } | null;
  expect(row).not.toBeNull();
  expect(JSON.parse(row!.search_terms_de)).toEqual(["Schmand", "Saure Sahne"]);
});

test("matchIngredient returns null when no offers found, and caches the null result", async () => {
  const db = openDb(":memory:");
  const m = createMatcher({
    db,
    llm: llmStub(["Schmand"]),
    provider: { async search() { return []; } },
    week: "2026-W26",
  });
  const result = await m.matchIngredient("сметана");
  expect(result).toBeNull();
  // second call: both LLM and provider throw — null must be served from cache
  const throwingLlm: Llm = { async structured() { throw new Error("LLM must not be called on cached null"); } };
  const m2 = createMatcher({
    db, llm: throwingLlm, week: "2026-W26",
    provider: { async search() { throw new Error("provider must not be called on cached null"); } },
  });
  const cached = await m2.matchIngredient("сметана");
  expect(cached).toBeNull();
});

test("matchIngredient picks cheapest by effectiveUnitPrice using referencePrice-null fallback", async () => {
  const db = openDb(":memory:");
  // offer A: referencePrice=null, price=0.79 → effectiveUnitPrice=0.79 (winner)
  // offer B: referencePrice=1.20, price=0.50 → effectiveUnitPrice=1.20 (higher)
  const provider: OfferProvider = {
    async search() {
      return [
        offer({ externalId: 10, referencePrice: null, price: 0.79, storeName: "Aldi" }),
        offer({ externalId: 11, referencePrice: 1.20, price: 0.50, storeName: "Rewe" }),
      ];
    },
  };
  const m = createMatcher({ db, llm: llmStub(["Schmand"]), provider, week: "2026-W26" });
  const best = await m.matchIngredient("сметана");
  // Aldi wins because its effectiveUnitPrice (price=0.79, referencePrice=null→0.79) < Rewe's referencePrice=1.20
  expect(best!.storeName).toBe("Aldi");
  expect(best!.price).toBe(0.79);
});

test("matchIngredient drops offers whose store is not in the whitelist", async () => {
  const db = openDb(":memory:");
  // Cheapest by effectiveUnitPrice is Metro (out of scope) and must be ignored.
  const provider: OfferProvider = {
    async search() {
      return [
        offer({ externalId: 20, store: "metro", storeName: "Metro", referencePrice: 0.5 }),
        offer({ externalId: 21, store: "aldi-nord", storeName: "Aldi Nord", referencePrice: 0.99 }),
      ];
    },
  };
  const whitelist = new Set<StoreKey>(["aldi", "lidl"]);
  const m = createMatcher({ db, llm: llmStub(["Schmand"]), provider, week: "2026-W26", whitelist });
  const best = await m.matchIngredient("сметана");
  expect(best!.storeName).toBe("Aldi Nord");
});

test("matchIngredient without a whitelist keeps all offers", async () => {
  const db = openDb(":memory:");
  const provider: OfferProvider = {
    async search() {
      return [offer({ externalId: 30, store: "metro", storeName: "Metro", referencePrice: 0.5 })];
    },
  };
  const m = createMatcher({ db, llm: llmStub(["Schmand"]), provider, week: "2026-W26" });
  const best = await m.matchIngredient("сметана");
  expect(best!.storeName).toBe("Metro");
});
