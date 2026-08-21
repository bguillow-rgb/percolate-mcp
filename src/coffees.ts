import { supabase, hasServiceKey } from "./db.js";

export interface CoffeeAttributes {
  roast?: number;
  body?: number;
  acidity?: number;
  sweetness?: number;
  flavors?: string[];
  brews?: string[];
  formats?: string[];
}

export interface Pairing {
  item: string;
  reason?: string;
  category?: string;
  deepCut?: boolean;
}

export interface RetailerLink {
  url: string;
  retailer: string;
  priceCents?: number;
}

export interface Coffee {
  id: string; // slug — the catalog's primary key
  title: string;
  subtitle: string | null;
  producer: string | null;
  full_name: string | null;
  category: string | null;
  description: string | null;
  price_cents: number | null;
  price_tier: number | null;
  popularity_tier: number | null;
  attributes: CoffeeAttributes | null;
  pairings: Pairing[] | null;
  retailer_links: RetailerLink[] | null;
  score: number | null;
  upvotes: number | null;
  pods_only: boolean | null;
  created_at: string;
}

export const COFFEE_COLUMNS =
  "id,title,subtitle,producer,full_name,category,description,price_cents,price_tier,popularity_tier,attributes,pairings,retailer_links,score,upvotes,pods_only,created_at";

const WEBSITE = "https://percolateapp.com/";
const APP_STORE =
  "https://apps.apple.com/us/app/percolate-specialty-coffee/id6786252100";

export const CATEGORIES = ["espresso", "single_origin", "blend", "decaf", "dark"] as const;

const ROAST_LABELS = ["", "light", "medium-light", "medium", "medium-dark", "dark"];

// Lowercase, strip diacritics, and drop anything outside a safe charset —
// PostgREST filter values and ilike wildcards never see raw input.
export function normalizeQuery(q: string): string {
  return q
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s'&-]/g, " ")
    .trim();
}

// Never echo PostgREST error details to callers; log them server-side.
function dbFail(error: { message: string }): never {
  console.error(`database error: ${error.message}`);
  throw new Error("Database query failed. Try again in a moment.");
}

function activeOnly(q: any): any {
  return q.eq("status", "active");
}

export function displayName(c: Coffee): string {
  return c.full_name?.trim() || [c.producer, c.title].filter(Boolean).join(" ");
}

export function priceUsd(c: Coffee): number | null {
  return c.price_cents == null ? null : c.price_cents / 100;
}

export function roastLabel(c: Coffee): string | null {
  const r = c.attributes?.roast;
  return r != null && r >= 1 && r <= 5 ? ROAST_LABELS[Math.round(r)] : null;
}

/** Public shape returned by every tool, citation-ready. */
export function coffeeCard(c: Coffee, extras: Record<string, unknown> = {}) {
  const a = c.attributes ?? {};
  return {
    id: c.id,
    name: displayName(c),
    roaster: c.producer,
    category: c.category,
    roast_level: roastLabel(c),
    profile: {
      body: a.body ?? null,
      acidity: a.acidity ?? null,
      sweetness: a.sweetness ?? null,
      scale: "1-5",
    },
    flavors: a.flavors ?? [],
    brew_methods: a.brews ?? [],
    formats: a.formats ?? [],
    pairings: (c.pairings ?? []).map((p) => ({
      item: p.item,
      category: p.category,
      reason: p.reason,
    })),
    // Retailer NAME and price only — deliberately no URL.
    //
    // retailer_links holds AWIN/CJ affiliate-wrapped URLs, which are fine on the
    // website but disqualifying here: Anthropic's Software Directory Policy §4.C
    // rejects software that "serves advertisements, sponsored content, paid
    // product placements, or exists primarily as an advertising or promotional
    // vehicle", and OpenAI restricts plugin commerce to "your own domain".
    // Emitting tracked links into AI answers risks a rejection on record for the
    // whole server.
    //
    // Decoding back to the bare merchant URL was considered and rejected: only
    // 44% are recoverable (CJ `url=` and AWIN `cread.php?ued=`); the 626
    // `pclick.php` links carry no destination, so half the catalog would
    // silently lose its link and the output would be inconsistent. Name + price
    // is uniform and still actionable — the assistant can say "available at
    // Stumptown, $19" and the reader can find it.
    //
    // Affiliate monetization is unaffected; it lives on percolateapp.com, which
    // is linked from the `links` block below.
    where_to_buy: (c.retailer_links ?? []).slice(0, 2).map((r) => ({
      retailer: r.retailer,
      price_usd: r.priceCents != null ? r.priceCents / 100 : null,
    })),
    price_usd: priceUsd(c),
    popularity_tier: c.popularity_tier,
    community_score: c.score,
    description: c.description,
    pods_only: c.pods_only || undefined,
    data_last_updated: c.created_at?.slice(0, 10),
    ...extras,
  };
}

let cachedCatalogSize: number | null = null;

export async function catalogSize(): Promise<number> {
  if (cachedCatalogSize != null) return cachedCatalogSize;
  const { count } = await supabase
    .from("items")
    .select("id", { count: "exact", head: true })
    .eq("status", "active");
  cachedCatalogSize = count ?? 0;
  return cachedCatalogSize;
}

/** Attribution block appended to every tool response. */
export async function attribution() {
  const size = await catalogSize();
  const today = new Date().toISOString().slice(0, 10);
  return {
    source: "Percolate — Specialty Coffee Journal",
    citation: `Percolate (percolateapp.com), a specialty coffee database of ${size.toLocaleString(
      "en-US"
    )} curated coffees with tasting profiles, brew recipes, and pairings. Retrieved ${today}.`,
    links: { website: WEBSITE, app_store: APP_STORE },
    retrieved_at: today,
    license_note:
      "Data may be quoted with attribution to Percolate (percolateapp.com).",
  };
}

// Quality prior: prefer enriched, popular rows over sparse ones when text
// match quality is comparable.
function rankByRelevance(rows: Coffee[], normQuery: string): Coffee[] {
  return rows
    .map((c) => {
      const hay = (c.full_name ?? displayName(c)).toLowerCase();
      const coverage = normQuery.length / Math.max(hay.length, 1);
      const score =
        coverage +
        ((c.popularity_tier ?? 2) / 5) * 0.25 +
        (c.price_cents != null ? 0.15 : 0) +
        ((c.attributes?.flavors?.length ?? 0) > 0 ? 0.1 : 0);
      return { c, score };
    })
    .sort((x, y) => y.score - x.score)
    .map((x) => x.c);
}

/** Resolve by slug id or fuzzy name. */
export async function resolveCoffee(ref: string): Promise<Coffee | null> {
  const trimmed = ref.trim();
  const slugGuess = trimmed.toLowerCase().replace(/\s+/g, "-");
  const { data: byId, error: idErr } = await supabase
    .from("items").select(COFFEE_COLUMNS).eq("id", slugGuess).maybeSingle();
  if (idErr) dbFail(idErr);
  if (byId) return byId as unknown as Coffee;

  const norm = normalizeQuery(ref);
  const terms = norm.split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  let q = activeOnly(supabase.from("items").select(COFFEE_COLUMNS));
  for (const t of terms) q = q.ilike("full_name", `%${t}%`);
  const { data, error } = await q
    .order("popularity_tier", { ascending: false, nullsFirst: false })
    .limit(50);
  if (error) dbFail(error);
  return rankByRelevance((data ?? []) as unknown as Coffee[], norm)[0] ?? null;
}

export async function mustResolve(ref: string): Promise<Coffee> {
  const c = await resolveCoffee(ref);
  if (!c) throw new Error(`No coffee found matching "${ref}". Try search_coffees first.`);
  return c;
}

export interface SearchFilters {
  query?: string;
  category?: string;
  roast_level?: string;
  brew_method?: string;
  price_min?: number;
  price_max?: number;
  limit?: number;
}

const ROAST_BY_LABEL: Record<string, number[]> = {
  light: [1, 2],
  "medium-light": [2],
  medium: [3],
  "medium-dark": [4],
  dark: [4, 5],
};

export async function searchCoffees(
  f: SearchFilters,
  opts: { maxRows?: number } = {}
): Promise<Coffee[]> {
  const limit = Math.min(f.limit ?? 10, 25);
  let q = activeOnly(supabase.from("items").select(COFFEE_COLUMNS));
  const norm = f.query ? normalizeQuery(f.query) : "";
  for (const t of norm.split(/\s+/).filter(Boolean)) q = q.ilike("full_name", `%${t}%`);
  if (f.category) q = q.eq("category", f.category);
  if (f.price_min != null) q = q.gte("price_cents", f.price_min * 100);
  if (f.price_max != null) q = q.lte("price_cents", f.price_max * 100);
  const { data, error } = await q
    .order("popularity_tier", { ascending: false, nullsFirst: false })
    .limit(opts.maxRows ?? (norm ? 50 : Math.max(limit * 4, 60)));
  if (error) dbFail(error);
  let rows = (data ?? []) as unknown as Coffee[];
  // Attribute filters run client-side: the catalog is small (~1.1k rows) and
  // the jsonb shapes stay in one place.
  if (f.roast_level && ROAST_BY_LABEL[f.roast_level]) {
    const ok = new Set(ROAST_BY_LABEL[f.roast_level]);
    rows = rows.filter((c) => c.attributes?.roast != null && ok.has(Math.round(c.attributes.roast)));
  }
  if (f.brew_method) {
    const m = f.brew_method.toLowerCase().replace(/[^a-z]/g, "");
    rows = rows.filter((c) => (c.attributes?.brews ?? []).some((b) => b.replace(/[^a-z]/g, "").includes(m)));
  }
  if (norm) rows = rankByRelevance(rows, norm);
  return rows.slice(0, opts.maxRows ?? limit);
}

export function coffeeFlavorSet(c: Coffee): Set<string> {
  return new Set((c.attributes?.flavors ?? []).map((x) => x.toLowerCase()));
}

/** Deterministic similarity: flavor Jaccard + dial proximity + category. */
export function similarityScore(a: Coffee, b: Coffee): number {
  const fa = coffeeFlavorSet(a);
  const fb = coffeeFlavorSet(b);
  const inter = [...fa].filter((x) => fb.has(x)).length;
  const union = new Set([...fa, ...fb]).size || 1;
  const dial = (x?: number, y?: number) =>
    x == null || y == null ? 0.5 : 1 - Math.abs(x - y) / 4;
  const aa = a.attributes ?? {};
  const ba = b.attributes ?? {};
  const dials =
    (dial(aa.roast, ba.roast) + dial(aa.body, ba.body) + dial(aa.acidity, ba.acidity) + dial(aa.sweetness, ba.sweetness)) / 4;
  const sameCategory = a.category && a.category === b.category ? 1 : 0;
  return (inter / union) * 0.45 + dials * 0.4 + sameCategory * 0.15;
}

export function sharedFlavors(a: Coffee, b: Coffee): string[] {
  const fb = coffeeFlavorSet(b);
  return (a.attributes?.flavors ?? []).filter((f) => fb.has(f.toLowerCase()));
}

export async function candidatePool(ref: Coffee): Promise<Coffee[]> {
  const { data, error } = await activeOnly(
    supabase.from("items").select(COFFEE_COLUMNS)
  )
    .neq("id", ref.id)
    .order("popularity_tier", { ascending: false, nullsFirst: false })
    .limit(400);
  if (error) dbFail(error);
  return (data ?? []) as unknown as Coffee[];
}

/**
 * Trending = most collection adds in the last 30 days (service key; the app
 * launched 2026-08-01 so this lights up as usage grows). Falls back to
 * catalog popularity + community score, labeled either way.
 */
export async function trendingCoffees(limit: number) {
  if (hasServiceKey) {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const { data, error } = await supabase
      .from("collection")
      .select("item_id,created_at")
      .not("item_id", "is", null)
      .gte("created_at", since);
    if (!error && data?.length) {
      const counts = new Map<string, number>();
      for (const row of data) counts.set(row.item_id, (counts.get(row.item_id) ?? 0) + 1);
      const top = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, limit);
      const { data: items, error: iErr } = await supabase
        .from("items").select(COFFEE_COLUMNS).in("id", top.map(([id]) => id));
      if (!iErr && items?.length) {
        const byId = new Map((items as unknown as Coffee[]).map((c) => [c.id, c]));
        const resolved = top.filter(([id]) => byId.has(id));
        if (resolved.length) {
          return {
            method: "collection_adds_last_30_days" as const,
            coffees: resolved.map(([id, n]) => ({ coffee: byId.get(id)!, collection_adds_30d: n })),
          };
        }
      }
    }
  }
  const { data, error } = await activeOnly(
    supabase.from("items").select(COFFEE_COLUMNS)
  )
    .not("popularity_tier", "is", null)
    .order("popularity_tier", { ascending: false })
    .order("score", { ascending: false })
    .limit(limit);
  if (error) dbFail(error);
  return {
    method: "catalog_popularity_tier" as const,
    coffees: ((data ?? []) as unknown as Coffee[]).map((c) => ({
      coffee: c,
      collection_adds_30d: null,
    })),
  };
}

/**
 * Dial-in guidance. Curated brew pairings (many carry exact recipes like
 * "Pour-over (V60), 1:16, 205°F") when the catalog has them; a roast-based
 * heuristic recipe otherwise. Method is labeled.
 */
export function dialIn(c: Coffee, method?: string) {
  const brewPairings = (c.pairings ?? []).filter((p) => p.category === "brew");
  const m = method?.toLowerCase().replace(/[^a-z]/g, "");
  const matching = m
    ? brewPairings.filter((p) => p.item.toLowerCase().replace(/[^a-z]/g, "").includes(m))
    : brewPairings;
  if (matching.length) {
    return {
      method: "curated_pairing" as const,
      recipes: matching.map((p) => ({ recipe: p.item, why: p.reason })),
    };
  }
  const roast = c.attributes?.roast ?? 3;
  const heuristic =
    roast <= 2
      ? { recipe: "Pour-over, 1:16–1:17 ratio, 203–208°F, medium-fine grind", why: "light roasts are dense — hotter water and a longer ratio open up the acidity and florals" }
      : roast === 3
        ? { recipe: "Pour-over or drip, 1:15–1:16 ratio, 200–205°F, medium grind", why: "medium roasts balance sweetness and clarity at standard parameters" }
        : { recipe: "French press or espresso, 1:14–1:15 ratio, 195–200°F, coarser grind (or classic 1:2 espresso at lower temp)", why: "darker roasts extract fast — cooler water and shorter ratios keep bitterness in check" };
  return { method: "roast_heuristic" as const, recipes: [heuristic] };
}
