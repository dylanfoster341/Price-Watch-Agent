import { chromium, type Browser } from "playwright";
import { findStructuredPrice } from "./price-extract";

const RENDER_TIMEOUT_MS = 15000;
const POST_LOAD_SETTLE_MS = 1500;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// A shared, lazily-launched browser instance, reused across requests in this
// Node process. Stashed on `globalThis` so Next's dev-mode hot reloading
// (which re-evaluates this module on every edit) doesn't leak a fresh
// Chromium process each time — same pattern used for a shared DB client.
declare global {
  var __pwaBrowserPromise: Promise<Browser> | undefined;
}

function getBrowser(): Promise<Browser> {
  if (!globalThis.__pwaBrowserPromise) {
    globalThis.__pwaBrowserPromise = chromium.launch({ headless: true });
  }
  return globalThis.__pwaBrowserPromise;
}

export type RenderedPriceResult =
  | { status: "ok"; price: string }
  | { status: "no-price" }
  | { status: "error"; message: string };

/**
 * Loads a page in a real (headless) browser — so client-side-rendered
 * pricing has a chance to actually run — and reads its declared price from
 * the fully-rendered HTML. Meant as a fallback for when a plain server-side
 * fetch (lib/tavily.ts's fetchStructuredPrice) can't get a verified price,
 * either because the site renders price via JS or because it's fussy about
 * non-browser requests. Note: a stock headless browser can still be
 * detected and blocked by aggressive bot protection (Akamai/PerimeterX-
 * style) — this raises the odds, it doesn't guarantee a result.
 */
export async function fetchRenderedPrice(url: string): Promise<RenderedPriceResult> {
  let context;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
    });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: RENDER_TIMEOUT_MS });
    // Give client-rendered pricing widgets a moment to fetch and paint.
    await page.waitForTimeout(POST_LOAD_SETTLE_MS);

    const html = await page.content();
    const price = findStructuredPrice(html);

    return price ? { status: "ok", price } : { status: "no-price" };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name === "TimeoutError"
          ? "Page took too long to load."
          : error.message
        : "Unknown render error.";
    return { status: "error", message };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}
