import type { Offer } from "./types";

export function cleanName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export function effectiveUnitPrice(o: Offer): number {
  return o.referencePrice ?? o.price;
}

export function dedupeOffers(offers: Offer[]): Offer[] {
  const best = new Map<number, Offer>();
  for (const o of offers) {
    const cur = best.get(o.externalId);
    if (!cur || effectiveUnitPrice(o) < effectiveUnitPrice(cur)) {
      best.set(o.externalId, o);
    }
  }
  return [...best.values()];
}
