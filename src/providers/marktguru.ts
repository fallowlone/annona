import { z } from "zod";
import type { Fetcher } from "../net/fetcher";
import type { Offer } from "../types";
import { cleanName } from "../normalize";

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
