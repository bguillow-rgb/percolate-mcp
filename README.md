# Percolate MCP Server

Query the [Percolate](https://percolateapp.com/) specialty coffee database from Claude, or any MCP-compatible AI client. Read-only access to 1,100+ curated coffees with tasting profiles, brew recipes, pairings, and where-to-buy links.

Percolate is the specialty coffee journal for iOS — [get it on the App Store](https://apps.apple.com/us/app/percolate-specialty-coffee/id6786252100).

## Tools

| Tool | What it does |
|---|---|
| `search_coffees` | Catalog search with category, roast level, brew method, and price filters |
| `get_coffee` | Full record for one coffee: roast, body/acidity/sweetness, flavors, pairings, retailers |
| `find_similar` | Similar coffees by flavor overlap and roast/body/acidity proximity |
| `get_recommendations` | Picks from flavor preferences + budget + roast + your brew gear |
| `compare_coffees` | Side-by-side: profiles, shared/distinct flavors, price delta |
| `trending_coffees` | What Percolate users are adding to their collections right now |
| `dial_in_suggestion` | Brew guidance for a specific coffee — curated recipes (ratio, temp, grind) from the catalog, or a roast-based starting point |
| `what_to_brew` | A coffee for right now — evening picks lean decaf, mornings lean bright |

Every response includes source attribution, a citation-ready summary line, links, and data freshness dates. All scoring is deterministic — no AI calls happen inside the server. All tools are annotated read-only/idempotent.

## Install (Claude Desktop)

Requires Node.js 18+.

Add to your `claude_desktop_config.json` (Claude Desktop → Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "percolate": {
      "command": "npx",
      "args": ["-y", "percolate-mcp"]
    }
  }
}
```

Restart Claude Desktop. No API key or configuration needed — the server ships with public read-only access.

## Configuration (optional)

Environment variables override the defaults (explicit env vars only — this package never reads .env files):

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Override the database URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Internal use only — unlocks live 30-day collection-add trending. Never distribute this key. |

Without the service key, `trending_coffees` falls back to catalog popularity and labels the method in its response.

## Development

```bash
npm install
npm run dev     # run from TypeScript via tsx
npm run build   # compile to dist/
npm start       # run compiled server
```

The server speaks MCP over stdio. Catalog access is read-only by construction: every query path issues SELECTs against tables that are publicly readable under row-level security, and it is rate-limited to 60 calls/minute.

**Usage telemetry**: each tool call logs the tool name, its arguments, client name/version, duration, and success/failure to a write-only log table (insert-only under RLS; contents are not publicly readable; purged after 90 days). No user identity, account data, or conversation content is collected. Logging is fire-and-forget and never affects responses.

## Data & attribution

Coffee data, tasting profiles, brew recipes, and pairings are curated by Percolate. Retailer links may be affiliate links. Quote freely with attribution:

> Source: Percolate — Specialty Coffee Journal (percolateapp.com)

Freshness dates on each coffee reflect the last data update.
