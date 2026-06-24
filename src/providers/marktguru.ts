import { z } from "zod";
import type { Fetcher } from "../net/fetcher";
import type { Offer } from "../types";
import { cleanName } from "../normalize";
import { log, errInfo } from "../log";

const BASE = "https://api.marktguru.de/api/v1";
const HOME = "https://www.marktguru.de/";
const DEFAULT_LIMIT = 80;

export interface OfferProvider {
  search(query: string): Promise<Offer[]>;
}

export function extractKeys(html: string): { apiKey: string; clientKey: string } {
  const re = /<script\s+type="application\/json">([\s\S]*?)<\/script>/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const data = JSON.parse(m[1] ?? "") as unknown;
      const cfg =
        (data as Record<string, unknown>)?.["config"] ??
        ((data as Record<string, unknown>)?.["marktguruConfig"] as Record<string, unknown> | undefined)?.["config"];
      if (
        cfg !== null &&
        typeof cfg === "object" &&
        "apiKey" in cfg &&
        "clientKey" in cfg
      ) {
        return {
          apiKey: String((cfg as Record<string, unknown>)["apiKey"]),
          clientKey: String((cfg as Record<string, unknown>)["clientKey"]),
        };
      }
    } catch {
      // not the block we want
    }
  }
  throw new Error("marktguru: could not extract api/client keys from homepage");
}

const RawOfferSchema = z.object({
  id: z.number(),
  price: z.number(),
  oldPrice: z.number().nullable().optional(),
  referencePrice: z.number().nullable().optional(),
  description: z.string().optional(),
  unit: z.object({ shortName: z.string().optional() }).optional(),
  product: z.object({ name: z.string().optional() }).optional(),
  brand: z.object({ name: z.string().optional() }).optional(),
  advertisers: z.array(z.object({ name: z.string().optional(), uniqueName: z.string().optional() })).optional(),
  validityDates: z.array(z.object({ from: z.string().optional(), to: z.string().optional() })).optional(),
});

const SearchResponseSchema = z.object({
  results: z.array(RawOfferSchema),
});

export function parseOffers(json: unknown): Offer[] {
  const { results } = SearchResponseSchema.parse(json);
  return results.map((r) => {
    const adv = r.advertisers?.[0];
    const valid = r.validityDates?.[0];
    return {
      externalId: r.id,
      store: adv?.uniqueName ?? "unknown",
      storeName: adv?.name ?? "Unknown",
      product: cleanName(r.product?.name ?? r.brand?.name ?? r.description ?? ""),
      price: r.price,
      oldPrice: r.oldPrice ?? null,
      referencePrice: r.referencePrice ?? null,
      unit: r.unit?.shortName ?? "",
      validFrom: valid?.from ?? "",
      validTo: valid?.to ?? "",
    } satisfies Offer;
  });
}

export async function loadKeys(
  fetcher: Fetcher
): Promise<{ apiKey: string; clientKey: string }> {
  const html = await fetcher.getText(HOME, { headers: { Accept: "text/html" } });
  return extractKeys(html);
}

export function createMarktguruProvider(deps: {
  fetcher: Fetcher;
  zipCode: number;
  keys: { apiKey: string; clientKey: string };
}): OfferProvider {
  return {
    async search(query: string): Promise<Offer[]> {
      const json = await deps.fetcher.getJson<unknown>(`${BASE}/offers/search`, {
        headers: {
          "x-apikey": deps.keys.apiKey,
          "x-clientkey": deps.keys.clientKey,
        },
        query: { as: "web", q: query, limit: DEFAULT_LIMIT, offset: 0, zipCode: deps.zipCode },
      });
      return parseOffers(json);
    },
  };
}

/**
 * Provider that loads the marktguru api/client keys lazily on first search
 * instead of at boot. A key-load failure (marktguru down / homepage markup
 * changed) degrades to `[]` rather than crashing the process, and a failed
 * search drops the cached keys so the next call re-extracts them — which also
 * self-heals key rotation without a restart. Offer-less search is a graceful
 * degrade: matching simply finds nothing on offer.
 */
export function createLazyMarktguruProvider(deps: {
  fetcher: Fetcher;
  zipCode: number;
}): OfferProvider {
  let inner: OfferProvider | null = null;
  let pending: Promise<OfferProvider | null> | null = null;

  // Single-flight the key load: concurrent first searches (e.g. handleList's
  // parallel estimateDishCost) share one homepage scrape instead of stampeding
  // marktguru with N identical requests (which would invite an anti-bot block).
  function ensure(): Promise<OfferProvider | null> {
    if (inner) return Promise.resolve(inner);
    if (!pending) {
      pending = (async () => {
        try {
          const keys = await loadKeys(deps.fetcher);
          inner = createMarktguruProvider({ fetcher: deps.fetcher, zipCode: deps.zipCode, keys });
          return inner;
        } catch (e) {
          log.warn("marktguru_keys_load_failed", errInfo(e));
          return null; // degraded; retried on the next search
        } finally {
          pending = null; // allow a fresh attempt once this one settles
        }
      })();
    }
    return pending;
  }

  return {
    async search(query: string): Promise<Offer[]> {
      const p = await ensure();
      if (!p) return [];
      try {
        return await p.search(query);
      } catch (e) {
        log.warn("marktguru_search_failed", errInfo(e));
        inner = null; // keys may be stale/blocked — force a reload next call
        return [];
      }
    },
  };
}
