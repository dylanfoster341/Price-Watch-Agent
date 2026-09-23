/**
 * Pure helpers for pulling a trustworthy price out of a page's HTML —
 * shared between the plain-fetch path (lib/tavily.ts) and the
 * headless-browser render path (lib/browser.ts).
 */

// Matches "$12.99", "$1,234", "$3" etc.
export const PRICE_RE = /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?/;
// Matches "$0.25/oz", "$4.99 per lb", "$1.10 / fl oz" etc.
export const UNIT_PRICE_RE =
  /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\s?(?:\/|per)\s?(?:fl\s?)?(?:oz|lb|lbs|ct|count|each|ea|g|kg|l|gal|item)\b/i;

export function extractPriceFromText(text: string): {
  price: string | null;
  unitPrice: string | null;
} {
  const unitMatch = text.match(UNIT_PRICE_RE);
  const priceMatch = text.match(PRICE_RE);
  return {
    price: priceMatch ? priceMatch[0].replace(/\s/g, "") : null,
    unitPrice: unitMatch ? unitMatch[0].replace(/\s+/g, " ").trim() : null,
  };
}

export function formatUsd(value: unknown): string | null {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return `$${n.toFixed(2)}`;
}

/** Walks a parsed JSON-LD value looking for a schema.org Product/Offer price. */
export function findPriceInJsonLd(node: unknown, depth = 0): string | null {
  if (!node || depth > 6) return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findPriceInJsonLd(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;

  // A node can be a Product with nested `offers`, or directly an Offer with `price`.
  if (typeof obj.price !== "undefined") {
    const formatted = formatUsd(obj.price);
    if (formatted) return formatted;
  }
  if (obj.offers) {
    const found = findPriceInJsonLd(obj.offers, depth + 1);
    if (found) return found;
  }
  if (obj["@graph"]) {
    const found = findPriceInJsonLd(obj["@graph"], depth + 1);
    if (found) return found;
  }

  return null;
}

/** Extracts every `<script type="application/ld+json">` block's parsed content. */
export function parseJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    try {
      blocks.push(JSON.parse(match[1].trim()));
    } catch {
      // Not valid JSON (truncated, commented out, etc.) — skip it.
    }
  }
  return blocks;
}

/** Looks for an Open Graph / product meta price tag as a fallback to JSON-LD. */
export function findMetaPrice(html: string): string | null {
  const re =
    /<meta[^>]+(?:property|name)=["'](?:product:price:amount|og:price:amount)["'][^>]+content=["']([\d.,]+)["']/i;
  const reversed =
    /content=["']([\d.,]+)["'][^>]+(?:property|name)=["'](?:product:price:amount|og:price:amount)["']/i;
  const match = html.match(re) ?? html.match(reversed);
  return match ? formatUsd(match[1].replace(/,/g, "")) : null;
}

/** Reads every JSON-LD block and meta tag on a rendered/fetched page for a price. */
export function findStructuredPrice(html: string): string | null {
  for (const block of parseJsonLdBlocks(html)) {
    const price = findPriceInJsonLd(block);
    if (price) return price;
  }
  return findMetaPrice(html);
}
