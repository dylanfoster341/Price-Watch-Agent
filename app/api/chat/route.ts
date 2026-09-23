import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import { anthropic, CLAUDE_MODEL } from "@/lib/anthropic";
import { getSession, setSessionStores } from "@/lib/session";
import { mergeStores, resolveStore } from "@/lib/stores";
import { getPricesForStores } from "@/lib/tavily";

// A price check can involve multiple stores' worth of Tavily searches and
// page fetches plus a couple of Claude round-trips — comfortably under a
// minute, but well past most platforms' default ~10s function timeout.
// This tells Vercel (and other platforms that read it) to allow more time.
export const maxDuration = 30;

const SYSTEM_PROMPT = `
You are the Discount Detective, the deadpan lead investigator at Price Watch Agent.
You talk like a world-weary noir detective who has seen every "limited time offer" trick
in the book — dry, understated, a little suspicious of anyone charging a markup. You are
NOT hostile or mean, just flatly unimpressed by bad deals and quietly delighted by good
ones. Stay in this voice in every reply, whether or not you use a tool.

You have two tools:

- update_store_list: call this ONLY when the user is asking you to persistently track or
  remember stores for future turns (e.g. "watch Best Buy and Target", "add Costco too", "keep
  an eye on these stores from now on"). Pass the raw store names; the tool resolves them to
  real domains and remembers them for the rest of the session. Do NOT call this just because
  a price-check message happens to mention store names — see get_item_prices below.
- get_item_prices: call this when the user asks you to check, compare, or find the price of
  a specific item.
  - If the user names specific stores IN THAT SAME MESSAGE (e.g. "compare milk between
    Walmart and Target", "what's this cost at Costco vs Best Buy"), pass exactly those
    store names in the "stores" argument. This searches ONLY those stores for this one
    request — it does NOT change what's persistently saved, and it does NOT also pull in
    whatever else happens to be saved from earlier in the conversation. Never silently
    widen a comparison the user explicitly scoped to N stores into more than N stores.
  - If the user does NOT name any stores in that message (just "what's the price of X?"),
    omit "stores" — this searches every store currently saved for the session. If nothing
    has been saved yet and none were named, do NOT call this tool — ask the user which
    stores to check first (in character).

Only call a tool when the user's message actually calls for it. If the user is just
chatting, asking a general question, or saying something unrelated to prices or stores,
reply normally in character with no tool call — do not force tool use every turn.

Each result from get_item_prices has a "verified" flag:

- verified: true means the price was read directly off the store's own product page (its
  structured product data), not guessed. Present these as solid numbers.
- verified: false with a price means we couldn't confirm the price on the actual product
  page (it was blocked, or didn't expose structured data) and this is a rough estimate
  pulled from a search snippet instead. You MUST flag these as unconfirmed — say something
  like "unconfirmed" or "couldn't verify this one" in character, and tell the user to
  click through before trusting it. Never present an unverified number with the same
  confidence as a verified one.
- verified: false with no price means we found nothing usable — say so plainly.

Present results as a GitHub-flavored Markdown table with columns: Store | Price | Status |
Link. Status is "Confirmed" for verified results, "Unconfirmed" for estimated ones, or
"Not found" when there's no price. Use the returned URL as a Markdown link (e.g.
"[View](https://...)") — never show a raw bare URL, and never show a link that wasn't in
the tool results. After the table, add one or two in-character sentences of commentary —
which store is the actual best deal (weighting confirmed prices over unconfirmed ones),
any suspiciously high or low numbers, and a nudge to verify anything marked unconfirmed.
Never invent a price, a verified status, or a link that didn't come from the tool results.
`.trim();

const TOOLS: Tool[] = [
  {
    name: "update_store_list",
    description:
      "Save the stores the user wants price-tracked for this session, resolving each " +
      "name to its real base domain (e.g. 'Best Buy' -> bestbuy.com). Call this whenever " +
      "the user mentions one or more store names to add.",
    input_schema: {
      type: "object",
      properties: {
        stores: {
          type: "array",
          items: { type: "string" },
          description: "Store names as the user wrote them, e.g. [\"Best Buy\", \"Walmart\"]",
        },
      },
      required: ["stores"],
    },
  },
  {
    name: "get_item_prices",
    description:
      "Search for the price of a specific item. For each store searched, tries to read " +
      "the price directly off the actual product page (verified: true); if that page is " +
      "blocked or lacks structured price data, falls back to an estimate from the search " +
      "result (verified: false) and says so. By default searches every store saved for " +
      "this session — pass \"stores\" to scope this one request to specific stores instead " +
      "(without changing what's saved). Requires either saved stores or an explicit " +
      "\"stores\" argument.",
    input_schema: {
      type: "object",
      properties: {
        item: {
          type: "string",
          description: "The product to price-check, e.g. '2% milk, 1 gallon' or 'iPhone 16 Pro 128GB'",
        },
        stores: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional. Only set this when the user named specific stores in this same " +
            "message (e.g. 'compare X between Walmart and Target' -> [\"Walmart\", \"Target\"]). " +
            "Scopes this one search to exactly these stores instead of the full saved list. " +
            "Omit entirely to search all currently saved stores.",
        },
      },
      required: ["item"],
    },
  },
];

type ChatMessage = { role: "user" | "assistant"; content: string };

const MAX_MESSAGE_LENGTH = 4000;
const MAX_HISTORY = 40;
const MAX_TOOL_ITERATIONS = 5;

function isChatMessage(value: unknown): value is ChatMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (("role" in value && (value as { role: unknown }).role === "user") ||
      (value as { role: unknown }).role === "assistant") &&
    typeof (value as { content: unknown }).content === "string"
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const rawMessages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(rawMessages) || !rawMessages.every(isChatMessage)) {
    return Response.json(
      { error: "\"messages\" must be an array of { role, content } objects." },
      { status: 400 },
    );
  }

  const history = rawMessages.slice(-MAX_HISTORY) as ChatMessage[];
  const lastMessage = history[history.length - 1];
  if (!lastMessage || lastMessage.role !== "user" || !lastMessage.content.trim()) {
    return Response.json({ error: "The last message must be a non-empty user message." }, { status: 400 });
  }
  if (history.some((m) => m.content.length > MAX_MESSAGE_LENGTH)) {
    return Response.json(
      { error: `Each message must be ${MAX_MESSAGE_LENGTH} characters or fewer.` },
      { status: 400 },
    );
  }

  const session = await getSession();
  let stores = session.stores;

  const messages: MessageParam[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  try {
    let reply: string | null = null;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });

      if (response.stop_reason !== "tool_use") {
        reply = response.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim();
        break;
      }

      messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter(
        (block): block is ToolUseBlock => block.type === "tool_use",
      );

      const toolResults: ToolResultBlockParam[] = await Promise.all(
        toolUses.map(async (toolUse): Promise<ToolResultBlockParam> => {
          if (toolUse.name === "update_store_list") {
            const input = toolUse.input as { stores?: unknown };
            const names = Array.isArray(input.stores)
              ? input.stores.filter((s): s is string => typeof s === "string")
              : [];
            const resolved = names.map(resolveStore);
            stores = mergeStores(stores, resolved);
            setSessionStores(session.id, stores);

            return {
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: JSON.stringify({ savedStores: stores }),
            };
          }

          if (toolUse.name === "get_item_prices") {
            const input = toolUse.input as { item?: unknown; stores?: unknown };
            const item = typeof input.item === "string" ? input.item : "";

            if (!item.trim()) {
              return {
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: JSON.stringify({ error: "No item provided." }),
                is_error: true,
              };
            }

            // An explicit "stores" argument scopes THIS search to exactly those
            // stores — resolved fresh, not merged with (or required to be part
            // of) the persistently saved list. Only fall back to the saved list
            // when the user didn't name specific stores for this request.
            const requestedNames = Array.isArray(input.stores)
              ? input.stores.filter((s): s is string => typeof s === "string")
              : [];
            const searchStores = requestedNames.length > 0 ? requestedNames.map(resolveStore) : stores;

            if (searchStores.length === 0) {
              return {
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: JSON.stringify({
                  error: "No stores saved yet. Ask the user which stores to check.",
                }),
                is_error: true,
              };
            }

            try {
              const results = await getPricesForStores(item, searchStores);
              return {
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: JSON.stringify({ item, results }),
              };
            } catch (error) {
              return {
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: JSON.stringify({
                  error: error instanceof Error ? error.message : "Price search failed.",
                }),
                is_error: true,
              };
            }
          }

          return {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({ error: `Unknown tool: ${toolUse.name}` }),
            is_error: true,
          };
        }),
      );

      messages.push({ role: "user", content: toolResults });
    }

    if (reply === null) {
      reply =
        "The trail went cold — too many leads, not enough answers. Try narrowing down your request.";
    }

    return Response.json({ reply, stores });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      console.error("Anthropic authentication error:", error.message);
      return Response.json({ error: "Server is misconfigured (invalid API key)." }, { status: 500 });
    }
    if (error instanceof Anthropic.RateLimitError) {
      return Response.json({ error: "Rate limited, please try again shortly." }, { status: 429 });
    }
    if (error instanceof Anthropic.APIError) {
      console.error("Anthropic API error:", error.status, error.message);
      return Response.json({ error: "Failed to get a response." }, { status: 502 });
    }

    console.error("Unexpected error in /api/chat:", error);
    return Response.json({ error: "Something went wrong." }, { status: 500 });
  }
}
