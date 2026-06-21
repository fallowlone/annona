import { test, expect } from "bun:test";
import { canonicalStore, mapsLink, STORE_KEYS } from "../src/stores";

test("canonicalStore maps marktguru advertiser slugs to whitelist keys", () => {
  expect(canonicalStore("aldi-nord")).toBe("aldi");
  expect(canonicalStore("Aldi Nord")).toBe("aldi");
  expect(canonicalStore("ALDI SÜD")).toBe("aldi");
  expect(canonicalStore("Lidl")).toBe("lidl");
  expect(canonicalStore("PENNY")).toBe("penny");
  expect(canonicalStore("Kaufland")).toBe("kaufland");
  expect(canonicalStore("EDEKA")).toBe("edeka");
  expect(canonicalStore("Edeka Center")).toBe("edeka");
  expect(canonicalStore("REWE")).toBe("rewe");
  expect(canonicalStore("netto-marken-discount")).toBe("netto");
  expect(canonicalStore("Netto Marken-Discount")).toBe("netto");
  expect(canonicalStore("dm-drogerie-markt")).toBe("dm");
  expect(canonicalStore("dm")).toBe("dm");
});

test("canonicalStore returns null for out-of-scope or empty stores", () => {
  expect(canonicalStore("Rossmann")).toBeNull();
  expect(canonicalStore("Real")).toBeNull();
  expect(canonicalStore("unknown")).toBeNull();
  expect(canonicalStore("")).toBeNull();
  expect(canonicalStore(null)).toBeNull();
  expect(canonicalStore(undefined)).toBeNull();
});

test("mapsLink builds a chain+PLZ Apple Maps search URL", () => {
  expect(mapsLink("lidl", 30459)).toBe("https://maps.apple.com/?q=Lidl%2030459");
  expect(mapsLink("edeka", 30459)).toBe("https://maps.apple.com/?q=Edeka%2030459");
  expect(mapsLink("dm", 30459)).toBe("https://maps.apple.com/?q=dm%2030459");
});

test("STORE_KEYS holds the eight whitelist chains", () => {
  expect([...STORE_KEYS]).toEqual([
    "lidl", "penny", "kaufland", "edeka", "dm", "aldi", "netto", "rewe",
  ]);
});
