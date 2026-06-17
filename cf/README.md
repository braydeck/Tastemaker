# Tastemaker on Cloudflare (Workers + D1)

A standalone port of the Python/FastAPI/MongoDB app to the Cloudflare Workers
runtime. Runs free: Workers (compute) + D1 (SQLite) + KV (IGDB token cache).
No cold-start penalty — the slow `/discover` Anthropic call is I/O wait, which
doesn't count against Workers CPU limits.

Stack: **Hono** (routing) + `hono/html` server-side rendering (replaces Jinja2).
Tailwind / HTMX / Alpine load from CDN exactly as before.

## One-time setup

```bash
cd cf
npm install

# 1. Create the D1 database, paste the printed database_id into wrangler.toml
npx wrangler d1 create tastemaker

# 2. Create the KV namespace, paste the printed id into wrangler.toml
npx wrangler kv namespace create IGDB_KV

# 3. Apply the schema (remote = production D1)
npx wrangler d1 execute tastemaker --remote --file=./schema.sql

# 4. Set secrets (same values as the old .env)
npx wrangler secret put TMDB_API_KEY
npx wrangler secret put IGDB_CLIENT_ID
npx wrangler secret put IGDB_CLIENT_SECRET
npx wrangler secret put ANTHROPIC_API_KEY
```

## Migrate existing MongoDB data

```bash
# Export from Atlas -> migration.sql (preserves _id strings & cross-references)
MONGODB_URI="mongodb+srv://..." npx tsx scripts/migrate.ts

# Load into production D1
npx wrangler d1 execute tastemaker --remote --file=migration.sql
```

(Use `--local` instead of `--remote` for both schema and migration to populate
the local dev database.)

## Deploy

```bash
npx wrangler deploy          # publishes to https://tastemaker.<subdomain>.workers.dev
```

## Lock it down (Cloudflare Access — free)

The deployed URL is public by default. In the Cloudflare dashboard →
**Zero Trust → Access → Applications → Add a self-hosted application**, point it
at the Worker's hostname and add an Allow policy for your own email (or Google
login). No app code changes; up to 50 users free.

## Local development

```bash
npx wrangler d1 execute tastemaker --local --file=./schema.sql
npx wrangler dev --local
```

## Re-running the batch jobs (replaces `python enrichment.py` / `cluster.py`)

These were CLI scripts; they're now authenticated routes:

- **Enrich** un-tagged items (metadata + LLM psychological tags):
  `POST /admin/enrich` — processes a bounded batch per call (see note below);
  returns `{enriched, errored, remaining}`. Call repeatedly until `remaining: 0`.
- **Recompute clusters** (k-means + LLM cluster naming):
  `POST /admin/recluster?k=4`. Also wired to a cron `scheduled()` handler —
  uncomment `[triggers]` in `wrangler.toml` to run it weekly.

```bash
# loop the enrichment until done
while true; do
  curl -s -X POST https://<your-host>/admin/enrich
  # stop when the JSON shows "remaining":0
done
```

## Free-tier note: subrequest limit

Cloudflare's **Workers Free** plan caps a single request at **50 subrequests**
(`fetch` calls). This is *per request*, not per day — running a route many times
a day is fine. Only the bulk routes need batching to fit one request under 50:

- `/discover/generate` — uses *light* enrichment (1 subrequest per rec instead of
  2), so a full 25-recommendation batch + the LLM call totals ~26 — safely under
  the cap, all recs enriched. Streaming providers aren't fetched for the discover
  card (to save the second call); they're fetched when you add a rec to the
  watchlist, which is where they're shown anyway.
- `/library/enrich-all`, `/watchlist/enrich-all` — 12 items per click.
- `/admin/enrich` — 8 items per call (loop until `remaining: 0`).

These caps only bound a *single* request; total daily usage is governed by the
100k requests/day allowance, which a personal library won't approach. If you ever
want them gone entirely, **Workers Paid ($5/mo)** raises the limit to 1000.

## What maps to what

| Python | Cloudflare |
|---|---|
| `main.py` routes | `src/index.ts` (Hono) |
| `templates/*.html` | `src/views/*.ts` (`hono/html`) |
| `enrichment.py` | `src/enrichment.ts` + `src/igdbToken.ts` (KV) |
| `cluster.py` (sklearn KMeans) | `src/cluster.ts` (pure-TS KMeans) |
| MongoDB collections | D1 tables (`schema.sql`) |
| `.igdb_token` file | KV namespace `IGDB_KV` |
| `db.py` (pymongo) | `src/db.ts` (D1 helpers) |
