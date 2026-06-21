import { test, expect } from "bun:test";
import { cleanName, effectiveUnitPrice, dedupeOffers } from "../src/normalize";
import type { Offer } from "../src/types";

const mk = (over: Partial<Offer>): Offer => ({
  externalId: 1,
  store: "aldi-nord",
  storeName: "Aldi Nord",
  product: "X",
  price: 2,
  oldPrice: null,
  referencePrice: null,
  unit: "St",
  validFrom: "2026-06-22",
  validTo: "2026-06-28",
  ...over,
});

test("cleanName trims and collapses whitespace", () => {
  expect(cleanName("  Schmand   Saure  Sahne ")).toBe("Schmand Saure Sahne");
});

test("effectiveUnitPrice prefers referencePrice", () => {
  expect(effectiveUnitPrice(mk({ price: 2, referencePrice: 1.5 }))).toBe(1.5);
  expect(effectiveUnitPrice(mk({ price: 2, referencePrice: null }))).toBe(2);
});

test("dedupeOffers keeps cheapest per externalId", () => {
  const out = dedupeOffers([
    mk({ externalId: 7, referencePrice: 3 }),
    mk({ externalId: 7, referencePrice: 2 }),
    mk({ externalId: 8, referencePrice: 5 }),
  ]);
  expect(out).toHaveLength(2);
  expect(out.find((o) => o.externalId === 7)!.referencePrice).toBe(2);
});
