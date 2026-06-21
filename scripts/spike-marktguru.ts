import { createFetcher } from "../src/net/fetcher";
import { loadKeys, createMarktguruProvider } from "../src/providers/marktguru";

const f = createFetcher();
const keys = await loadKeys(f);
console.log("keys ok:", !!keys.apiKey, !!keys.clientKey);
const p = createMarktguruProvider({ fetcher: f, zipCode: 30459, keys });
const offers = await p.search("Kartoffeln");
console.log("offers:", offers.length, offers[0]);
