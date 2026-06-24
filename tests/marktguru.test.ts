import { test, expect } from "bun:test";
import { extractKeys, parseOffers, createMarktguruProvider, createLazyMarktguruProvider } from "../src/providers/marktguru";
import type { Fetcher } from "../src/net/fetcher";

const home = await Bun.file("fixtures/marktguru-home.html").text();
const search = JSON.parse(await Bun.file("fixtures/marktguru-search.json").text());

test("extractKeys reads apiKey/clientKey from the json script block", () => {
  expect(extractKeys(home)).toEqual({ apiKey: "AK_TEST", clientKey: "CK_TEST" });
});

test("extractKeys fails closed when the keys are present but not strings", () => {
  const html = `<script type="application/json">${JSON.stringify({ config: { apiKey: null, clientKey: 123 } })}</script>`;
  expect(() => extractKeys(html)).toThrow("could not extract");
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

/** Fetcher whose getText (homepage for key extraction) is scripted per call. */
function lazyFetcher(homeBodies: string[]): Fetcher {
  let i = 0;
  return {
    async getText() {
      return homeBodies[Math.min(i++, homeBodies.length - 1)] ?? "";
    },
    async getJson<T>() {
      return search as T;
    },
  };
}

test("lazy provider loads keys on first search and returns offers", async () => {
  const provider = createLazyMarktguruProvider({ fetcher: lazyFetcher([home]), zipCode: 30459 });
  expect(await provider.search("Schmand")).toHaveLength(2);
});

test("lazy provider returns [] (does not throw) when key loading fails", async () => {
  // homepage without the key block → extractKeys throws → degraded, no throw
  const provider = createLazyMarktguruProvider({ fetcher: lazyFetcher([""]), zipCode: 30459 });
  expect(await provider.search("Schmand")).toEqual([]);
});

test("lazy provider retries key load on a later call after an earlier failure", async () => {
  const provider = createLazyMarktguruProvider({ fetcher: lazyFetcher(["", home]), zipCode: 30459 });
  expect(await provider.search("Schmand")).toEqual([]); // first load fails
  expect(await provider.search("Schmand")).toHaveLength(2); // second succeeds
});

test("lazy provider loads keys once under concurrent first searches (single-flight)", async () => {
  let textCalls = 0;
  const fetcher: Fetcher = {
    async getText() { textCalls++; return home; },
    async getJson<T>() { return search as T; },
  };
  const provider = createLazyMarktguruProvider({ fetcher, zipCode: 30459 });
  const [a, b] = await Promise.all([provider.search("Schmand"), provider.search("Milch")]);
  expect(a).toHaveLength(2);
  expect(b).toHaveLength(2);
  expect(textCalls).toBe(1); // one homepage scrape, not one per concurrent caller
});
