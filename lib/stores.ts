/**
 * Resolves store names (as a user might type them in chat) to a real base
 * domain we can point Tavily's `site:` search at.
 *
 * A curated map covers the retailers people actually ask about; anything
 * else falls back to a best-effort slug (e.g. "Joe's Hardware" -> joeshardware.com).
 */

export type Store = {
  /** The name as the user/model wrote it, e.g. "Best Buy" */
  name: string;
  /** A bare domain, e.g. "bestbuy.com" */
  baseUrl: string;
};

const KNOWN_STORE_DOMAINS: Record<string, string> = {
  "best buy": "bestbuy.com",
  walmart: "walmart.com",
  target: "target.com",
  amazon: "amazon.com",
  costco: "costco.com",
  "sam's club": "samsclub.com",
  "home depot": "homedepot.com",
  "the home depot": "homedepot.com",
  "lowe's": "lowes.com",
  lowes: "lowes.com",
  kroger: "kroger.com",
  safeway: "safeway.com",
  "whole foods": "wholefoodsmarket.com",
  "whole foods market": "wholefoodsmarket.com",
  "trader joe's": "traderjoes.com",
  "trader joes": "traderjoes.com",
  "kohl's": "kohls.com",
  kohls: "kohls.com",
  "macy's": "macys.com",
  macys: "macys.com",
  newegg: "newegg.com",
  "b&h": "bhphotovideo.com",
  "b&h photo": "bhphotovideo.com",
  walgreens: "walgreens.com",
  cvs: "cvs.com",
  staples: "staples.com",
  "office depot": "officedepot.com",
  ikea: "ikea.com",
  wayfair: "wayfair.com",
  ebay: "ebay.com",
  apple: "apple.com",
  "dick's sporting goods": "dickssportinggoods.com",
  gamestop: "gamestop.com",
  aldi: "aldi.us",
  publix: "publix.com",
  meijer: "meijer.com",
  "bj's wholesale": "bjs.com",
  "bj's": "bjs.com",
  petco: "petco.com",
  petsmart: "petsmart.com",
  microcenter: "microcenter.com",
  "micro center": "microcenter.com",
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

export function resolveStore(rawName: string): Store {
  const name = rawName.trim();
  const known = KNOWN_STORE_DOMAINS[name.toLowerCase()];
  const baseUrl = known ?? `${slugify(name)}.com`;
  return { name, baseUrl };
}

/** Merge new stores into an existing list, de-duping by domain. */
export function mergeStores(existing: Store[], incoming: Store[]): Store[] {
  const merged = [...existing];
  for (const store of incoming) {
    if (!merged.some((s) => s.baseUrl === store.baseUrl)) {
      merged.push(store);
    }
  }
  return merged;
}
