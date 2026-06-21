// Store registry: canonicalize marktguru advertiser names into a fixed whitelist
// of chains the family shops at, and build Apple Maps search links. Pure, no I/O.

export const STORE_KEYS = [
  "lidl",
  "penny",
  "kaufland",
  "edeka",
  "dm",
  "aldi",
  "netto",
  "rewe",
] as const;

export type StoreKey = (typeof STORE_KEYS)[number];

// Human-facing chain names used in Maps links and digest output.
const DISPLAY: Record<StoreKey, string> = {
  lidl: "Lidl",
  penny: "Penny",
  kaufland: "Kaufland",
  edeka: "Edeka",
  dm: "dm",
  aldi: "Aldi",
  netto: "Netto",
  rewe: "Rewe",
};

// Normalized substrings that identify a chain inside an advertiser name.
// `dm` is intentionally absent here: it is too short for a loose substring
// test (false positives) and is matched by a strict prefix check instead.
const ALIASES: Record<StoreKey, string[]> = {
  lidl: ["lidl"],
  penny: ["penny"],
  kaufland: ["kaufland"],
  edeka: ["edeka"],
  dm: [],
  aldi: ["aldi"],
  netto: ["netto"],
  rewe: ["rewe"],
};

/**
 * Map a raw marktguru advertiser name (uniqueName slug or display name) to a
 * whitelist key, or null when the store is out of scope. Case/spacing/punctuation
 * insensitive ("Aldi Nord", "aldi-nord", "ALDI SÜD" all → "aldi").
 */
export function canonicalStore(raw: string | null | undefined): StoreKey | null {
  if (!raw) return null;
  const norm = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!norm) return null;
  if (norm.startsWith("dm")) return "dm";
  for (const key of STORE_KEYS) {
    if (ALIASES[key].some((t) => norm.includes(t))) return key;
  }
  return null;
}

/** Apple Maps search URL for a chain near a PLZ, e.g. ".../?q=Lidl%2030459". */
export function mapsLink(store: StoreKey, plz: number): string {
  return `https://maps.apple.com/?q=${encodeURIComponent(`${DISPLAY[store]} ${plz}`)}`;
}
