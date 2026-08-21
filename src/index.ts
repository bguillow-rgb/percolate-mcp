#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { checkRateLimit } from "./db.js";
import { logCall, setClientInfo, SERVER_VERSION } from "./telemetry.js";
import {
  attribution,
  candidatePool,
  Coffee,
  coffeeCard,
  dialIn,
  displayName,
  mustResolve,
  priceUsd,
  searchCoffees,
  sharedFlavors,
  similarityScore,
  trendingCoffees,
} from "./coffees.js";

const ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const server = new McpServer({ name: "percolate", version: SERVER_VERSION });

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

async function respond(payload: Record<string, unknown>): Promise<ToolResult> {
  const body = { ...payload, attribution: await attribution() };
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

/** Wrap a handler with rate limiting, error normalization, and call logging. */
function guarded<A>(
  toolName: string,
  fn: (args: A) => Promise<ToolResult>
): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    const started = Date.now();
    try {
      checkRateLimit();
      const result = await fn(args);
      logCall({ tool_name: toolName, args, success: true, duration_ms: Date.now() - started });
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logCall({
        tool_name: toolName,
        args,
        success: false,
        error: message,
        duration_ms: Date.now() - started,
      });
      return errorResult(message);
    }
  };
}

// ---------------------------------------------------------------------------
server.registerTool(
  "search_coffees",
  {
    title: "Search the Percolate catalog",
    annotations: ANNOTATIONS,
    description:
      "Search 1,100+ curated specialty coffees in the Percolate database. Filter by category (espresso, single_origin, blend, decaf, dark), roast level, brew method, and price (USD). Returns tasting profiles, brew methods, and where-to-buy links.",
    inputSchema: {
      query: z.string().optional().describe("Free-text search: coffee or roaster name"),
      category: z.enum(["espresso", "single_origin", "blend", "decaf", "dark"]).optional().describe("Coffee category to filter by; omit to search all"),
      roast_level: z.enum(["light", "medium-light", "medium", "medium-dark", "dark"]).optional().describe("Roast level to filter by; omit to include all roasts"),
      brew_method: z.string().optional().describe("e.g. 'espresso', 'pourover', 'french press', 'drip'"),
      price_min: z.number().min(0).optional().describe("Minimum price in USD"),
      price_max: z.number().min(0).optional().describe("Maximum price in USD"),
      limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
    },
  },
  guarded("search_coffees", async (args) => {
    const rows = await searchCoffees(args);
    return respond({ result_count: rows.length, coffees: rows.map((c) => coffeeCard(c)) });
  })
);

server.registerTool(
  "get_coffee",
  {
    title: "Get coffee details",
    annotations: ANNOTATIONS,
    description:
      "Detailed record for one coffee: roast level, body/acidity/sweetness profile, flavor notes, suited brew methods, food and brew pairings, price, and retailer links. Accepts a Percolate id or a name.",
    inputSchema: {
      id_or_name: z.string().describe("Coffee id or a name like 'Bean Box Taste of New York City'"),
    },
  },
  guarded("get_coffee", async ({ id_or_name }) => {
    const c = await mustResolve(id_or_name);
    return respond({ coffee: coffeeCard(c) });
  })
);

server.registerTool(
  "find_similar",
  {
    title: "Find similar coffees",
    annotations: ANNOTATIONS,
    description:
      "Coffees with a similar profile to a given one, ranked by shared flavor notes and roast/body/acidity/sweetness proximity. Deterministic scoring over Percolate's structured tasting data.",
    inputSchema: {
      coffee: z.string().describe("Coffee id or name"),
      limit: z.number().int().min(1).max(15).optional().describe("Max results (default 5)"),
    },
  },
  guarded("find_similar", async ({ coffee, limit }) => {
    const ref = await mustResolve(coffee);
    const pool = await candidatePool(ref);
    const ranked = pool
      .map((c) => ({ c, score: similarityScore(ref, c) }))
      .sort((x, y) => y.score - x.score)
      .slice(0, limit ?? 5);
    return respond({
      reference: displayName(ref),
      similar_coffees: ranked.map(({ c, score }) =>
        coffeeCard(c, {
          similarity: Math.round(score * 100) / 100,
          shared_flavors: sharedFlavors(ref, c),
        })
      ),
    });
  })
);

server.registerTool(
  "get_recommendations",
  {
    title: "Get personalized recommendations",
    annotations: ANNOTATIONS,
    description:
      "Personalized coffee picks from flavor preferences (e.g. 'chocolate', 'berry', 'caramel'), a budget in USD, roast preference, and the brew gear you own.",
    inputSchema: {
      preferences: z
        .array(z.string())
        .min(1)
        .describe("Flavors the drinker enjoys, e.g. ['chocolate','caramel','nutty']"),
      budget: z.number().min(0).optional().describe("Max price in USD per bag"),
      roast_level: z.enum(["light", "medium-light", "medium", "medium-dark", "dark"]).optional().describe("Roast level to filter by; omit to include all roasts"),
      brew_method: z.string().optional().describe("What you brew with, e.g. 'espresso', 'pourover'"),
      limit: z.number().int().min(1).max(10).optional().describe("Max results (default 5)"),
    },
  },
  guarded("get_recommendations", async ({ preferences, budget, roast_level, brew_method, limit }) => {
    const wanted = preferences.map((t) => t.toLowerCase().trim());
    const pool = await searchCoffees({ price_max: budget, roast_level, brew_method }, { maxRows: 400 });
    const scored = pool
      .map((c) => {
        const flavors = (c.attributes?.flavors ?? []).map((f) => f.toLowerCase());
        const hits = wanted.filter((w) => flavors.some((f) => f.includes(w) || w.includes(f)));
        return { c, hits, score: hits.length / wanted.length + (c.popularity_tier ?? 3) / 10 };
      })
      .filter((x) => x.hits.length > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, limit ?? 5);
    return respond({
      criteria: {
        preferences,
        budget: budget ?? null,
        roast_level: roast_level ?? null,
        brew_method: brew_method ?? null,
      },
      recommendations: scored.map(({ c, hits }) => coffeeCard(c, { matched_flavors: hits })),
      note: scored.length
        ? undefined
        : "No coffees matched those flavors within the constraints. Try broader flavors or a higher budget.",
    });
  })
);

server.registerTool(
  "compare_coffees",
  {
    title: "Compare two coffees",
    annotations: ANNOTATIONS,
    description:
      "Side-by-side comparison: roast, body/acidity/sweetness, shared and distinct flavors, brew methods, and price difference.",
    inputSchema: {
      coffee_a: z.string().describe("First coffee — id or name"),
      coffee_b: z.string().describe("Second coffee — id or name"),
    },
  },
  guarded("compare_coffees", async ({ coffee_a, coffee_b }) => {
    const [a, b] = await Promise.all([mustResolve(coffee_a), mustResolve(coffee_b)]);
    const only = (x: Coffee, other: Coffee) => {
      const otherSet = new Set((other.attributes?.flavors ?? []).map((v) => v.toLowerCase()));
      return (x.attributes?.flavors ?? []).filter((v) => !otherSet.has(v.toLowerCase()));
    };
    return respond({
      comparison: {
        coffee_a: coffeeCard(a),
        coffee_b: coffeeCard(b),
        shared_flavors: sharedFlavors(a, b),
        only_in_a: only(a, b),
        only_in_b: only(b, a),
        similarity: Math.round(similarityScore(a, b) * 100) / 100,
        price_delta_usd:
          priceUsd(a) != null && priceUsd(b) != null
            ? Math.round((priceUsd(a)! - priceUsd(b)!) * 100) / 100
            : null,
      },
    });
  })
);

server.registerTool(
  "trending_coffees",
  {
    title: "Trending coffees",
    annotations: ANNOTATIONS,
    description:
      "Coffees Percolate users are adding to their collections most over the last 30 days (falls back to catalog popularity when live activity data is unavailable). The method used is labeled in the response.",
    inputSchema: {
      limit: z.number().int().min(1).max(20).optional().describe("Max results (default 10)"),
    },
  },
  guarded("trending_coffees", async ({ limit }) => {
    const { method, coffees } = await trendingCoffees(limit ?? 10);
    return respond({
      method,
      window: method === "collection_adds_last_30_days" ? "last 30 days" : "all-time catalog popularity",
      trending: coffees.map(({ coffee, collection_adds_30d }) =>
        coffeeCard(coffee, collection_adds_30d == null ? {} : { collection_adds_30d })
      ),
    });
  })
);

server.registerTool(
  "dial_in_suggestion",
  {
    title: "Dial in this coffee",
    annotations: ANNOTATIONS,
    description:
      "Brew guidance for a specific coffee: curated recipes from the Percolate catalog (ratio, temperature, grind) when available, or a roast-based starting point. Optionally scoped to your brew method.",
    inputSchema: {
      coffee: z.string().describe("Coffee id or name"),
      brew_method: z.string().optional().describe("Your brewer, e.g. 'V60', 'espresso', 'french press'"),
    },
  },
  guarded("dial_in_suggestion", async ({ coffee, brew_method }) => {
    const c = await mustResolve(coffee);
    const { method, recipes } = dialIn(c, brew_method);
    return respond({
      coffee: displayName(c),
      roast_level: coffeeCard(c).roast_level,
      method,
      recipes,
      suited_brew_methods: c.attributes?.brews ?? [],
    });
  })
);

server.registerTool(
  "what_to_brew",
  {
    title: "What should I brew?",
    annotations: ANNOTATIONS,
    description:
      "A coffee suggestion for right now, based on time of day (evening picks lean decaf), mood, and the brew method you're using — scored over Percolate's tasting profiles.",
    inputSchema: {
      time_of_day: z.enum(["morning", "afternoon", "evening"]).optional().describe("When the coffee will be drunk — shifts the pick toward lighter or lower-caffeine options later in the day"),
      mood: z.string().optional().describe("e.g. 'need focus', 'lazy weekend', 'something comforting', 'adventurous'"),
      brew_method: z.string().optional().describe("What you're brewing with"),
    },
  },
  guarded("what_to_brew", async ({ time_of_day, mood, brew_method }) => {
    const text = (mood ?? "").toLowerCase();
    const want: string[] = [];
    let category: string | undefined;
    let roast_level: string | undefined;
    if (time_of_day === "evening") category = "decaf";
    if (time_of_day === "morning") want.push("citrus", "berry", "floral", "bright");
    if (/comfort|cozy|lazy|relax/.test(text)) {
      want.push("chocolate", "caramel", "nutty");
      roast_level = "medium-dark";
    }
    if (/focus|work|deadline/.test(text)) want.push("chocolate", "caramel");
    if (/adventur|new|surprise|funky/.test(text)) want.push("berry", "fruity", "floral", "tropical");
    if (!want.length) want.push("chocolate", "caramel", "berry");
    const pool = await searchCoffees({ category, roast_level, brew_method }, { maxRows: 400 });
    const scored = pool
      .map((c) => {
        const flavors = (c.attributes?.flavors ?? []).map((f) => f.toLowerCase());
        const hits = want.filter((w) => flavors.some((f) => f.includes(w)));
        return { c, hits, score: hits.length + (c.popularity_tier ?? 3) / 10 + (c.score ?? 0) / 100 };
      })
      .sort((x, y) => y.score - x.score)
      .slice(0, 3);
    return respond({
      criteria: {
        time_of_day: time_of_day ?? null,
        mood: mood ?? null,
        brew_method: brew_method ?? null,
      },
      matched_profile: want,
      suggestions: scored.map(({ c, hits }, i) =>
        coffeeCard(c, { rank: i + 1, matched_flavors: hits })
      ),
    });
  })
);

// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
server.server.oninitialized = () => setClientInfo(server.server.getClientVersion());
await server.connect(transport);
console.error("Percolate MCP server running (stdio, read-only)");
