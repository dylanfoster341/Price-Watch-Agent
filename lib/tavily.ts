import type { Store } from "./stores";
import { PRICE_RE, extractPriceFromText, findStructuredPrice } from "./price-extract";

export type PriceResult = {
  store: string;
  baseUrl: string;
  price: string | null;
  unitPrice: string | null;
  url: string | null;
  title: string | null;
  /**
   * true = the price came from structured data (schema.org JSON-LD or an
   * Open Graph price tag) read directly off the fetched product page — the
   * same data the site itself declares, not a guess.
   * false = we couldn't confirm it that way and fell back to pattern-
   * matching a number out of a search-result snippet, which is much less
   * trustworthy.
   */
  verified: boolean;
  /** Set when we couldn't find anything useful (or trustworthy) for this store. */
  note?: string;
};

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const SEARCH_TIMEOUT_MS = 6000;
const FETCH_TIMEOUT_MS = 4000;
const MAX_CANDIDATE_PAGES = 2;
// Hard ceiling on the whole per-store pipeline (search + page fetches +
// fallback). Sized to comfortably fit the worst case of every stage timing
// out in sequence (search 6s + parallel page fetches 4s ≈ 10s), with slack.
// Without this, a slow/hanging step could leave a single store's lookup
// running far longer than a serverless function's own timeout allows —
// better to fail one store fast and clearly than to make the whole request
// hang past that limit and come back as a dead connection.
const STORE_TIMEOUT_MS = 12000;

// A real browser UA + Accept headers. Doesn't defeat serious bot protection
// (Akamai/PerimeterX-style walls some big retailers run), but avoids being
// trivially blocked as an obvious script.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

type PageFetchResult =
  | { status: "ok"; price: string }
  | { status: "no-structured-price" }
  | { status: "blocked"; httpStatus: number }
  | { status: "error"; message: string };

/** Fetches a product page directly (no JS execution) and reads its declared price. */
async function fetchStructuredPrice(url: string): Promise<PageFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, signal: controller.signal });
    if (!res.ok) {
      return { status: "blocked", httpStatus: res.status };
    }

    const html = await res.text();
    const price = findStructuredPrice(html);
    return price ? { status: "ok", price } : { status: "no-structured-price" };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name === "AbortError"
          ? "Request timed out."
          : error.message
        : "Unknown fetch error.";
    return { status: "error", message };
  } finally {
    clearTimeout(timeout);
  }
}

async function searchTavily(query: string, apiKey: string, domain: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    const res = await fetch(TAVILY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        api_key: apiKey,
        query,
        // "basic" depth tends to surface review/Q&A pages that mention a price
        // in passing (an old purchase, a "why'd it go up" complaint) rather
        // than the actual listing. "advanced" reliably finds the real
        // product/category page.
        search_depth: "advanced",
        max_results: 5,
        include_answer: false,
        // The real filter — restricts results to this store's domain.
        include_domains: [domain],
      }),
    });

    if (!res.ok) {
      throw new Error(`Tavily search failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as {
      results?: { title: string; url: string; content: string }[];
    };
    return data.results ?? [];
  } finally {
    clearTimeout(timeout);
  }
}

/** True if `url`'s hostname is `domain` or a subdomain of it (e.g. www.bestbuy.com). */
function isOnDomain(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const target = domain.toLowerCase().replace(/^www\./, "");
    return host === target || host.endsWith(`.${target}`);
  } catch {
    return false;
  }
}

async function priceLookupForStore(item: string, store: Store, apiKey: string): Promise<PriceResult> {
  try {
    // Deliberately no "price" keyword and no `site:` prefix — both bias
    // the search toward review/Q&A pages that mention a price in passing
    // rather than the actual product or category listing. include_domains
    // (below) is the real scoping mechanism.
    const results = await searchTavily(`${item} buy`, apiKey, store.baseUrl);

    // include_domains still occasionally leaks an off-domain result
    // (a YouTube review, a forum post) — only trust results actually
    // hosted on this store's domain.
    const onDomain = results.filter((r) => isOnDomain(r.url, store.baseUrl));

    // Review/Q&A pages ("/reviews/...", "/questions/...") tend to have
    // stale or incidental dollar amounts, not the current price — try
    // real listing pages first.
    const isReviewish = (url: string) => /\/(reviews?|questions?|qa)\b/i.test(url);
    // A genuine single-product URL (Walmart's /ip/, Target's /p/ or
    // /A-<id>, Best Buy/Amazon-style /product/, /dp/, /sku/) is far more
    // likely to have one clear, correct price than a category or search
    // page — put those first regardless of Tavily's relevance ranking.
    const looksLikeProductPage = (url: string) =>
      /\/(ip|dp|product|sku)\/|\/p\/|\/A-\d+(?:$|[/?])/i.test(url);

    const rank = (r: { url: string }) =>
      (looksLikeProductPage(r.url) ? 0 : 1) + (isReviewish(r.url) ? 2 : 0);
    const candidates = [...onDomain]
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, MAX_CANDIDATE_PAGES);

    if (candidates.length === 0) {
      return {
        store: store.name,
        baseUrl: store.baseUrl,
        price: null,
        unitPrice: null,
        url: null,
        title: null,
        verified: false,
        note:
          results.length > 0
            ? `Search returned results, but none were actually on ${store.baseUrl}.`
            : "No search results found.",
      };
    }

    // Tier 1: try every candidate with a plain fetch (cheap) IN PARALLEL —
    // not one after another — so a blocked/slow candidate doesn't add to
    // the wait for the others. Prefer the highest-priority candidate that
    // came back with a price, not just whichever happened to finish first.
    const fetchedByCandidate = await Promise.all(
      candidates.map((candidate) => fetchStructuredPrice(candidate.url)),
    );
    const tier1Index = fetchedByCandidate.findIndex((f) => f.status === "ok");
    if (tier1Index !== -1) {
      const winner = fetchedByCandidate[tier1Index];
      const candidate = candidates[tier1Index];
      return {
        store: store.name,
        baseUrl: store.baseUrl,
        price: winner.status === "ok" ? winner.price : null,
        unitPrice: null,
        url: candidate.url,
        title: candidate.title,
        verified: true,
      };
    }

    // Tier 2: plain fetch didn't turn up a verified price on any candidate
    // (blocked, or the site only renders price via client-side JS — a
    // headless-browser render could sometimes recover that, but that
    // approach doesn't run in a serverless deployment, so it's deliberately
    // not attempted here). Fall back to pattern-matching a dollar amount
    // out of the best snippet, but mark it clearly as unverified so it's
    // never presented as confirmed.
    const withPriceInSnippet = candidates.find((r) => PRICE_RE.test(r.content));
    const fallback = withPriceInSnippet ?? candidates[0];
    const { price, unitPrice } = extractPriceFromText(fallback.content);

    return {
      store: store.name,
      baseUrl: store.baseUrl,
      price,
      unitPrice,
      url: fallback.url,
      title: fallback.title,
      verified: false,
      note: price
        ? "Estimated from a search snippet — couldn't confirm this on the live product page (likely bot-blocked, or the price only shows for a real signed-in browsing session). Treat as unconfirmed."
        : "Found a page, but couldn't find or confirm a price on it.",
    };
  } catch (error) {
    console.error(`Price search failed for ${store.baseUrl}:`, error);
    return {
      store: store.name,
      baseUrl: store.baseUrl,
      price: null,
      unitPrice: null,
      url: null,
      title: null,
      verified: false,
      note: `Search failed: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
}

/** For each saved store, find the item's product page and read its real price. */
export async function getPricesForStores(
  item: string,
  stores: Store[],
): Promise<PriceResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error("TAVILY_API_KEY is not configured on the server.");
  }

  return Promise.all(
    stores.map((store) => {
      // A hard ceiling on this store's whole pipeline. If it's not done by
      // then, stop waiting and report a timeout rather than let one slow
      // store hold up (or outlast) the response to the browser.
      const timeout = new Promise<PriceResult>((resolve) => {
        setTimeout(
          () =>
            resolve({
              store: store.name,
              baseUrl: store.baseUrl,
              price: null,
              unitPrice: null,
              url: null,
              title: null,
              verified: false,
              note: "Search timed out for this store.",
            }),
          STORE_TIMEOUT_MS,
        );
      });

      return Promise.race([priceLookupForStore(item, store, apiKey), timeout]);
    }),
  );
}
