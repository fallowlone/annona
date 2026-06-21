import { test, expect } from "bun:test";
import { extractKeys, parseOffers, createMarktguruProvider } from "../src/providers/marktguru";
import type { Fetcher } from "../src/net/fetcher";

const home = await Bun.file("fixtures/marktguru-home.html").text();
const search = JSON.parse(await Bun.file("fixtures/marktguru-search.json").text());

test("extractKeys reads apiKey/clientKey from the json script block", () => {
  expect(extractKeys(home)).toEqual({ apiKey: "AK_TEST", clientKey: "CK_TEST" });
});

test("parseOffers maps marktguru results to Offer", () => {
  const offers = parseOffers(search);
  expect(offers).toHaveLength(2);
  const o = offers[0];
  expect(o?.externalId).toBe(1001);
  expect(o?.store).toBe("edeka");
  expect(o?.storeName).toBe("Edeka");
  expect(o?.product).toBe("Schmand");
  expect(o?.price).toBe(1.49);
  expect(o?.validFrom).toBe("2026-06-22T00:00:00");
});

test("parseOffers throws on malformed input", () => {
  expect(() => parseOffers(null)).toThrow();
  expect(() => parseOffers({ results: "oops" })).toThrow();
  expect(() => parseOffers({})).toThrow();
  expect(() => parseOffers({ results: [{ id: "x" }] })).toThrow();
});

test("parseOffers maps nullable oldPrice to null", () => {
  const offers = parseOffers(search);
  const second = offers[1];
  expect(second?.oldPrice).toBeNull();
});

test("provider.search sends keys + zipCode and returns parsed offers", async () => {
  let seen: { url: string; headers: Record<string, string>; query?: Record<string, string | number> } | null = null;
  const fakeFetcher: Fetcher = {
    async getJson<T>(url: string, o?: { headers?: Record<string, string>; query?: Record<string, string | number> }) {
      seen = { url, headers: o?.headers ?? {}, query: o?.query };
      return search as T;
    },
    async getText() { return ""; },
  };
  const provider = createMarktguruProvider({
    fetcher: fakeFetcher, zipCode: 30459, keys: { apiKey: "AK", clientKey: "CK" },
  });
  const offers = await provider.search("Schmand");
  expect(offers).toHaveLength(2);
  expect(seen!.headers["x-apikey"]).toBe("AK");
  expect(seen!.query!.q).toBe("Schmand");
  expect(seen!.query!.zipCode).toBe(30459);
});
