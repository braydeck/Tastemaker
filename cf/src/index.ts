import { Hono } from "hono";
import type { Env, Doc } from "./db";
import {
  insert,
  updateById,
  deleteById,
  findById,
  query,
  queryOne,
  count,
  newId,
  nowIso,
  nowEpoch,
} from "./db";
import {
  enrichRec,
  fetchTmdbById,
  fetchOpenLibraryByKey,
  fetchOpenLibrary,
  igdbRequest,
  getWithBackoff,
  anthropicMessages,
  parseLlmJson,
  buildSystemPrompt,
  tagWithLlm,
  fetchTmdb,
  fetchIgdb,
  fetchTmdbGenreMap,
} from "./enrichment";
import {
  DIMENSIONS,
  KNOWN_DIMS,
  DIMENSION_LABELS,
  DIMENSION_DEFINITIONS,
  QUALITY_FLOORS,
  SEED_SYSTEM_PROMPT,
  CLUSTER_SYSTEM_PROMPT,
  NAMING_SYSTEM_PROMPT,
  tierName,
} from "./constants";
import {
  serialize as serializeDoc,
  getPosterUrl,
  normalizeTitle,
  yearFromDate,
  yearFromUnix,
  extractCreator,
} from "./util";
import { computeFinalRank, applyCompareResult } from "./ranking";
import { buildFeatureRow, kmeans, denormalizeCentroid, topExemplarIndices, KNOWN_DIMS as CLUSTER_DIMS } from "./cluster";
import { Layout } from "./views/layout";
import { Dashboard, Grid, Table, TierSelect, TierGroup } from "./views/library";
import { LogForm, LogCompare, LogDone } from "./views/log";
import { ItemDetail } from "./views/item";
import { Onboard, OnboardCard, OnboardDone, MaxDiffDim } from "./views/onboard";
import { Calibrate, CalibrateSaved } from "./views/calibrate";
import { Watchlist, WatchlistAdded } from "./views/watchlist";
import { Discover, DiscoverResults, Blacklist } from "./views/discover";
import { Profile, DimRow, ProfileCluster } from "./views/profile";
import { Admin } from "./views/admin";

// Deployed to Cloudflare Workers via Workers Builds (auto-deploy on push to main).
const app = new Hono<{ Bindings: Env }>();

const IMG = (env: Env) => env.TMDB_IMAGE_BASE;
const serialize = (item: Doc, env: Env) => serializeDoc(item, IMG(env));

function groupByTier(items: Doc[]): TierGroup[] {
  const groups = new Map<number | null, Doc[]>();
  for (const it of items) {
    const t = (it.tier ?? null) as number | null;
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t)!.push(it);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const an = a === null, bn = b === null;
    if (an !== bn) return an ? 1 : -1;
    return (a ?? 0) - (b ?? 0);
  });
  return keys.map((t) => ({ tier: t, items: groups.get(t)! }));
}

const isHtmx = (c: any) => c.req.header("HX-Request") != null;

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get("/health", (c) => c.json({ status: "ok" }));

// ---------------------------------------------------------------------------
// Media search API (live search for watchlist/log forms)
// ---------------------------------------------------------------------------
app.get("/api/search", async (c) => {
  const q = c.req.query("q") ?? "";
  const medium = c.req.query("medium") ?? "movie";
  if (q.length < 2) return c.json([]);
  const env = c.env;
  const results: any[] = [];
  try {
    if (medium === "movie" || medium === "tv") {
      const endpoint = medium === "movie" ? "movie" : "tv";
      const params = new URLSearchParams({ query: q, api_key: env.TMDB_API_KEY });
      const resp = await getWithBackoff(`https://api.themoviedb.org/3/search/${endpoint}?${params}`);
      const data = (await resp.json()) as any;
      for (const r of (data.results ?? []).slice(0, 20)) {
        const dateField = medium === "movie" ? "release_date" : "first_air_date";
        const year = yearFromDate(r[dateField]);
        const title = medium === "movie" ? r.title : r.name ?? "";
        results.push({
          title,
          year,
          tmdb_id: r.id,
          books_id: "",
          igdb_id: 0,
          creator: "",
          poster_url: r.poster_path ? `${IMG(env)}${r.poster_path}` : null,
          overview: (r.overview ?? "").slice(0, 120),
        });
      }
    } else if (medium === "book") {
      const params = new URLSearchParams({
        q,
        limit: "20",
        fields: "key,title,author_name,first_publish_year,cover_i,cover_edition_key,subject",
      });
      const resp = await getWithBackoff(`https://openlibrary.org/search.json?${params}`);
      const data = (await resp.json()) as any;
      for (const doc of data.docs ?? []) {
        const coverId = doc.cover_i;
        const coverEdition = doc.cover_edition_key;
        let thumb: string | null = null;
        if (coverId) thumb = `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`;
        else if (coverEdition) thumb = `https://covers.openlibrary.org/b/olid/${coverEdition}-M.jpg`;
        results.push({
          title: doc.title ?? "",
          year: doc.first_publish_year ?? null,
          tmdb_id: 0,
          books_id: doc.key ?? "",
          igdb_id: 0,
          creator: (doc.author_name ?? []).join(", "),
          poster_url: thumb,
          overview: (doc.subject ?? []).slice(0, 5).join(", "),
        });
      }
    } else if (medium === "game") {
      const body =
        `search "${q}"; ` +
        "fields name,summary,genres.name,first_release_date,cover.url," +
        "involved_companies.company.name,involved_companies.developer," +
        "parent_game,version_parent; " +
        "limit 50;";
      const raw = await igdbRequest(env, body);
      const resultIds = new Set(raw.map((r: any) => r.id));
      const igdbResults = raw
        .filter((r: any) => !r.version_parent && !resultIds.has(r.parent_game))
        .slice(0, 20);
      for (const r of igdbResults) {
        const year = yearFromUnix(r.first_release_date);
        const cover = r.cover ?? {};
        const coverUrl = cover.url ? "https:" + String(cover.url).replace("t_thumb", "t_cover_big") : null;
        const devs = (r.involved_companies ?? [])
          .filter((cc: any) => cc.developer && cc.company && typeof cc.company === "object")
          .map((cc: any) => cc.company.name);
        results.push({
          title: r.name ?? "",
          year,
          tmdb_id: 0,
          books_id: "",
          igdb_id: r.id,
          creator: devs[0] ?? "",
          poster_url: coverUrl,
          overview: (r.summary ?? "").slice(0, 120),
        });
      }
    }
  } catch (exc) {
    console.log(`[api_search] error medium=${medium} q=${q}: ${exc}`);
  }
  return c.json(results);
});

app.get("/api/library-search", async (c) => {
  const q = c.req.query("q") ?? "";
  if (q.length < 2) return c.json([]);
  const docs = await query(
    c.env,
    "MediaLogs",
    "SELECT id, title, medium, poster_url, metadata FROM MediaLogs WHERE title LIKE '%' || ? || '%' LIMIT 8",
    [q]
  );
  return c.json(
    docs.map((d) => ({
      id: String(d._id),
      title: d.title,
      medium: d.medium ?? "",
      poster_url: getPosterUrl(d, IMG(c.env)),
    }))
  );
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
const SORT_FIELDS = new Set(["title", "medium", "creator", "year", "tier"]);

app.get("/", async (c) => {
  const env = c.env;
  const medium = c.req.query("medium") ?? "";
  const view = c.req.query("view") ?? "grid";
  let sort = c.req.query("sort") ?? "tier";
  const dir = c.req.query("dir") ?? "asc";
  const clusterId = parseInt(c.req.query("cluster_id") ?? "-1", 10);
  const errorFilter = c.req.query("error") ?? "";

  const conds: string[] = [];
  const params: any[] = [];
  if (medium) {
    conds.push("medium = ?");
    params.push(medium);
  }
  if (clusterId >= 0) {
    conds.push("cluster_id = ?");
    params.push(clusterId);
  }
  if (errorFilter) {
    conds.push("enrichment_error = ?");
    params.push(errorFilter);
  }
  if (!SORT_FIELDS.has(sort)) sort = "tier";
  const sortDir = dir === "desc" ? "DESC" : "ASC";
  const orderBy = sort === "tier" ? `tier ${sortDir}, rank_in_tier ASC` : `${sort} ${sortDir}`;
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  let items = await query(env, "MediaLogs", `SELECT * FROM MediaLogs ${where} ORDER BY ${orderBy}`, params);
  items = items.map((i) => serialize(i, env));
  const tierGroups = groupByTier(items);

  const clusterDefs = (
    await query(env, "ClusterDefs", "SELECT * FROM ClusterDefs ORDER BY cluster_id ASC")
  ).map((cd) => serialize(cd, env));

  const noMatchCount = await count(
    env,
    "SELECT COUNT(*) as c FROM MediaLogs WHERE enrichment_error = 'no_api_match'"
  );

  const content =
    view === "table" ? Table(items, medium, sort, dir) : Grid(tierGroups);

  if (isHtmx(c)) return c.html(content);
  return c.html(
    Layout(
      "Library — Tastemaker",
      Dashboard({ medium, view, sort, dir, clusterId, clusterDefs, content, errorFilter, noMatchCount })
    )
  );
});

// ---------------------------------------------------------------------------
// MaxDiff onboarding
// ---------------------------------------------------------------------------
function selectMaxDiffDims(tags: Record<string, number>): MaxDiffDim[] {
  if (!tags || !Object.keys(tags).length) return [];
  const filtered = Object.entries(tags).filter(([k]) => KNOWN_DIMS.has(k));
  const sorted = [...filtered].sort((a, b) => b[1] - a[1]);
  const present = sorted.filter(([, v]) => v >= 3.0);
  let four = (present.length >= 4 ? present : sorted).slice(0, 4);
  // shuffle
  four = [...four];
  for (let i = four.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [four[i], four[j]] = [four[j], four[i]];
  }
  return four.map(([k, v]) => ({ key: k, label: DIMENSION_LABELS[k] ?? k, score: Math.round(v * 100) / 100 }));
}

app.get("/onboard", async (c) => {
  const env = c.env;
  let pool = await query(
    env,
    "MediaLogs",
    "SELECT * FROM MediaLogs WHERE tier = 1 AND psychological_tags IS NOT NULL AND psychological_tags != '{}'"
  );
  if (!pool.length) {
    return c.html(
      Layout("Onboard — Tastemaker", Onboard({ item: null, dims: [], sessionId: "", remainingIds: "", itemNum: 0, total: 0 }))
    );
  }
  // shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const items = pool.slice(0, 10);
  const sessionId = newId();
  const first = serialize(items[0], env);
  const remainingIds = items.slice(1).map((i) => String(i._id)).join(",");
  const dims = selectMaxDiffDims(first.psychological_tags ?? {});
  return c.html(
    Layout(
      "Onboard — Tastemaker",
      Onboard({ item: first, dims, sessionId, remainingIds, itemNum: 1, total: items.length })
    )
  );
});

app.post("/onboard/response", async (c) => {
  const env = c.env;
  const form = await c.req.parseBody();
  const mediaId = String(form.media_id);
  const most = String(form.most);
  const least = String(form.least);
  const sessionId = String(form.session_id);
  const remainingIds = String(form.remaining_ids ?? "");
  const itemNum = parseInt(String(form.item_num ?? "1"), 10);
  const total = parseInt(String(form.total ?? "10"), 10);

  const now = nowIso();
  const doc = await findById(env, "MediaLogs", mediaId);
  const title = doc?.title ?? "";
  for (const [utilityType, dimension] of [
    ["most", most],
    ["least", least],
  ]) {
    await insert(env, "TasteClusters", {
      media_id: mediaId,
      title,
      dimension,
      utility_type: utilityType,
      session_id: sessionId,
      timestamp: now,
    });
  }

  const remaining = remainingIds.split(",").filter(Boolean);
  if (!remaining.length) return c.html(OnboardDone());
  const [nextId, ...rest] = remaining;
  const item = serialize((await findById(env, "MediaLogs", nextId))!, env);
  const dims = selectMaxDiffDims(item.psychological_tags ?? {});
  return c.html(
    OnboardCard({
      item,
      dims,
      sessionId,
      remainingIds: rest.join(","),
      itemNum: itemNum + 1,
      total,
    })
  );
});

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------
app.get("/calibrate", async (c) => {
  const env = c.env;
  let items = await query(
    env,
    "MediaLogs",
    "SELECT * FROM MediaLogs WHERE tier = 1 AND psychological_tags IS NOT NULL AND psychological_tags != '{}' ORDER BY title ASC"
  );
  items = items.map((i) => serialize(i, env));
  return c.html(Layout("Calibrate — Tastemaker", Calibrate(items)));
});

app.post("/calibrate/save", async (c) => {
  const env = c.env;
  const form = await c.req.parseBody();
  const now = nowIso();

  const updates = new Map<string, number>(); // "mediaId__dim" -> score
  const mediaIds = new Set<string>();
  for (const [key, value] of Object.entries(form)) {
    const parts = key.split("__");
    if (parts.length !== 2) continue;
    const [mediaIdStr, dimension] = parts;
    if (!(DIMENSIONS as readonly string[]).includes(dimension)) continue;
    const score = parseFloat(String(value));
    if (Number.isNaN(score)) continue;
    updates.set(`${mediaIdStr}__${dimension}`, score);
    mediaIds.add(mediaIdStr);
  }

  const docs = new Map<string, Doc>();
  for (const mid of mediaIds) {
    const d = await findById(env, "MediaLogs", mid);
    if (d) docs.set(mid, d);
  }

  for (const [k, confirmedScore] of updates) {
    const [mediaIdStr, dimension] = k.split("__");
    const doc = docs.get(mediaIdStr);
    if (!doc) continue;
    const llmScore = (doc.psychological_tags ?? {})[dimension] ?? null;
    await env.DB.prepare(
      `INSERT INTO CalibrationAnchors (id, media_id, title, medium, dimension, confirmed_score, llm_score, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(media_id, dimension) DO UPDATE SET
         title=excluded.title, medium=excluded.medium,
         confirmed_score=excluded.confirmed_score, llm_score=excluded.llm_score, timestamp=excluded.timestamp`
    )
      .bind(newId(), mediaIdStr, doc.title, doc.medium ?? "", dimension, confirmedScore, llmScore, now)
      .run();
  }
  return c.html(CalibrateSaved());
});

// ---------------------------------------------------------------------------
// Log new entry + binary search ranking
// ---------------------------------------------------------------------------
app.get("/log", (c) =>
  c.html(Layout("Log Entry — Tastemaker", LogForm(c.req.query("title") ?? "", c.req.query("medium") ?? "")))
);

app.post("/log/submit", async (c) => {
  const env = c.env;
  const form = await c.req.parseBody();
  const title = String(form.title);
  const medium = String(form.medium);
  const tier = parseInt(String(form.tier), 10);
  let creator = String(form.creator ?? "");
  const yearStr = String(form.year ?? "");
  const tmdbId = parseInt(String(form.tmdb_id ?? "0"), 10) || 0;
  const booksId = String(form.books_id ?? "");
  const igdbId = parseInt(String(form.igdb_id ?? "0"), 10) || 0;
  const now = nowIso();

  let yearInt: number | null = /^\d+$/.test(yearStr.trim()) ? parseInt(yearStr, 10) : null;
  let finalTitle = title;
  let metadata: any = {};
  let posterUrl: string | null = null;

  if (tmdbId) {
    try {
      metadata = await fetchTmdbById(env, tmdbId, medium);
      finalTitle = metadata.title ?? metadata.name ?? title;
      const dateField = medium === "movie" ? "release_date" : "first_air_date";
      if (metadata[dateField] && !yearInt) yearInt = parseInt(metadata[dateField].slice(0, 4), 10);
      if (metadata.poster_path) posterUrl = `${IMG(env)}${metadata.poster_path}`;
      if (!creator) creator = extractCreator(metadata, medium);
    } catch {
      /* ignore */
    }
  } else if (igdbId) {
    try {
      const body =
        `fields name,summary,genres.name,first_release_date,cover.url,rating,rating_count,` +
        `involved_companies.company.name,involved_companies.developer; where id = ${igdbId}; limit 1;`;
      const results = await igdbRequest(env, body);
      if (results.length) {
        metadata = { ...results[0] };
        finalTitle = metadata.name ?? title;
        if (metadata.first_release_date && !yearInt) yearInt = yearFromUnix(metadata.first_release_date);
        const cover = metadata.cover ?? {};
        if (cover.url) posterUrl = "https:" + String(cover.url).replace("t_thumb", "t_cover_big");
        if (!creator) creator = extractCreator(metadata, "game");
      }
    } catch {
      /* ignore */
    }
  } else if (booksId) {
    try {
      const info = await fetchOpenLibraryByKey(booksId);
      if (info) {
        finalTitle = info.title ?? title;
        const ys = info.publishedDate ?? "";
        if (ys && /^\d{4}/.test(ys) && !yearInt) yearInt = parseInt(ys.slice(0, 4), 10);
        if (!creator) creator = (info.authors ?? []).join(", ");
        const thumb = info.imageLinks?.thumbnail;
        if (thumb) posterUrl = thumb;
        metadata = info;
      }
    } catch {
      /* ignore */
    }
  }

  const newIdStr = await insert(env, "MediaLogs", {
    title: finalTitle,
    creator,
    medium,
    year: yearInt,
    original_rating: null,
    tier,
    date_logged: now,
    metadata_enriched: Object.keys(metadata).length > 0,
    metadata,
    poster_url: posterUrl,
    psychological_tags: {},
    rank_in_tier: null,
    enrichment_error: null,
  });

  if (!Object.keys(metadata).length) {
    try {
      const { metadata: fm, poster_url: fp } = await enrichRec(env, finalTitle, medium);
      if (fm && Object.keys(fm).length) {
        const upd: Doc = { metadata: fm, metadata_enriched: true };
        if (fp) upd.poster_url = fp;
        const canonical = fm.title ?? fm.name;
        if (canonical) {
          upd.title = canonical;
          finalTitle = canonical;
        }
        await updateById(env, "MediaLogs", newIdStr, upd);
      }
    } catch {
      /* ignore */
    }
  }

  // Auto-rank unranked items in this tier+medium.
  const unranked = await query(
    env,
    "MediaLogs",
    "SELECT id FROM MediaLogs WHERE tier = ? AND medium = ? AND rank_in_tier IS NULL AND id != ?",
    [tier, medium, newIdStr]
  );
  if (unranked.length) {
    const maxRow = await queryOne(
      env,
      "MediaLogs",
      "SELECT rank_in_tier FROM MediaLogs WHERE tier = ? AND medium = ? AND rank_in_tier IS NOT NULL ORDER BY rank_in_tier DESC LIMIT 1",
      [tier, medium]
    );
    const start = maxRow ? maxRow.rank_in_tier + 1.0 : 1.0;
    for (let i = 0; i < unranked.length; i++) {
      await updateById(env, "MediaLogs", String(unranked[i]._id), { rank_in_tier: start + i });
    }
  }

  const ranked = await query(
    env,
    "MediaLogs",
    "SELECT id, title, rank_in_tier, metadata, medium FROM MediaLogs WHERE tier = ? AND medium = ? AND rank_in_tier IS NOT NULL AND id != ? ORDER BY rank_in_tier ASC",
    [tier, medium, newIdStr]
  );

  if (!ranked.length) {
    await updateById(env, "MediaLogs", newIdStr, { rank_in_tier: 1.0 });
    return c.html(LogDone(title, tier, 1.0));
  }

  const sessionId = newId();
  const rankedIds = ranked.map((r) => String(r._id));
  await insert(env, "EnrichmentQueue", {
    session_id: sessionId,
    new_media_id: newIdStr,
    new_title: title,
    medium,
    tier,
    low: 0,
    high: ranked.length,
    ranked_ids: rankedIds,
    created_at: now,
    expires_at: nowEpoch() + 3600,
  });

  const mid = Math.floor(ranked.length / 2);
  return c.html(LogCompare(title, serialize(ranked[mid], env), sessionId));
});

app.post("/log/compare", async (c) => {
  const env = c.env;
  const form = await c.req.parseBody();
  const sessionId = String(form.session_id);
  const result = String(form.result) as "na" | "better" | "worse";

  const session = await queryOne(env, "EnrichmentQueue", "SELECT * FROM EnrichmentQueue WHERE session_id = ?", [sessionId]);
  if (!session || (session.expires_at && session.expires_at < nowEpoch())) {
    if (session) await env.DB.prepare("DELETE FROM EnrichmentQueue WHERE session_id = ?").bind(sessionId).run();
    return c.html(
      "<p class='text-red-400 p-4 text-center'>Session expired. <a href='/log' class='underline'>Start over.</a></p>"
    );
  }

  let { low, high } = session;
  let rankedIds: string[] = session.ranked_ids ?? [];
  const mid = Math.floor((low + high) / 2);
  ({ low, high, rankedIds } = applyCompareResult({ low, high, rankedIds }, mid, result));

  if (low >= high) {
    const placeholders = rankedIds.map(() => "?").join(",");
    const rows = rankedIds.length
      ? await query(
          env,
          "MediaLogs",
          `SELECT id, rank_in_tier FROM MediaLogs WHERE id IN (${placeholders})`,
          rankedIds
        )
      : [];
    const rankMap = new Map<string, number>(rows.map((d) => [String(d._id), d.rank_in_tier]));
    const orderedRanks = rankedIds.map((rid) => rankMap.get(rid)!);
    const finalRank = computeFinalRank(orderedRanks, low);

    await updateById(env, "MediaLogs", String(session.new_media_id), { rank_in_tier: finalRank });
    await env.DB.prepare("DELETE FROM EnrichmentQueue WHERE session_id = ?").bind(sessionId).run();
    return c.html(LogDone(session.new_title, session.tier, finalRank));
  }

  await updateById(env, "EnrichmentQueue", String(session._id), { low, high, ranked_ids: rankedIds });
  const newMid = Math.floor((low + high) / 2);
  const compareDoc = await findById(env, "MediaLogs", rankedIds[newMid]);
  return c.html(LogCompare(session.new_title, serialize(compareDoc!, env), sessionId));
});

// ---------------------------------------------------------------------------
// Post-hoc metadata fetch
// ---------------------------------------------------------------------------
app.post("/item/:id/fetch-metadata", async (c) => {
  const env = c.env;
  const itemId = c.req.param("id");
  const doc = await findById(env, "MediaLogs", itemId);
  if (!doc) return c.html("<p class='text-red-400 text-xs'>Item not found.</p>");

  const title = doc.title;
  const medium = doc.medium ?? "";
  let metadata: any = {};
  let posterUrl: string | null = null;
  const updates: Doc = {};

  try {
    if (medium === "movie" || medium === "tv") {
      const endpoint = medium === "movie" ? "movie" : "tv";
      const params = new URLSearchParams({ query: title, api_key: env.TMDB_API_KEY });
      const resp = await getWithBackoff(`https://api.themoviedb.org/3/search/${endpoint}?${params}`);
      const results = ((await resp.json()) as any).results ?? [];
      if (results.length) {
        metadata = await fetchTmdbById(env, results[0].id, medium);
        if (metadata.poster_path) posterUrl = `${IMG(env)}${metadata.poster_path}`;
        const canonical = medium === "movie" ? metadata.title : metadata.name;
        if (canonical) updates.title = canonical;
        const dateField = medium === "movie" ? "release_date" : "first_air_date";
        if (metadata[dateField]) updates.year = parseInt(metadata[dateField].slice(0, 4), 10);
        const cr = extractCreator(metadata, medium);
        if (cr) updates.creator = cr;
      }
    } else if (medium === "game") {
      const body =
        `search "${title}"; ` +
        "fields name,summary,genres.name,first_release_date,cover.url," +
        "involved_companies.company.name,involved_companies.developer; limit 1;";
      const results = await igdbRequest(env, body);
      if (results.length) {
        metadata = { ...results[0] };
        updates.title = metadata.name ?? title;
        if (metadata.first_release_date) updates.year = yearFromUnix(metadata.first_release_date);
        const cover = metadata.cover ?? {};
        if (cover.url) posterUrl = "https:" + String(cover.url).replace("t_thumb", "t_cover_big");
        const cr = extractCreator(metadata, "game");
        if (cr) updates.creator = cr;
      }
    } else if (medium === "book") {
      metadata = (await fetchOpenLibrary(title, doc.creator ?? "")) ?? {};
      if (metadata && Object.keys(metadata).length) {
        if (metadata.title) updates.title = metadata.title;
        if (metadata.publishedDate) updates.year = parseInt(metadata.publishedDate.slice(0, 4), 10);
        const authors = metadata.authors ?? [];
        if (authors.length) updates.creator = authors.join(", ");
        const thumb = metadata.imageLinks?.thumbnail;
        if (thumb) posterUrl = thumb;
      }
    }
  } catch (exc) {
    return c.html(`<p class='text-red-400 text-xs'>Error: ${String(exc).slice(0, 100)}</p>`);
  }

  if (!metadata || !Object.keys(metadata).length)
    return c.html("<p class='text-neutral-500 text-xs'>No match found in API.</p>");

  Object.assign(updates, {
    metadata,
    poster_url: posterUrl,
    metadata_enriched: true,
    enrichment_error: null,
  });
  await updateById(env, "MediaLogs", itemId, updates);

  const posterHtml = posterUrl ? `<img src="${posterUrl}" class="w-16 rounded shadow mt-2">` : "";
  const canonicalTitle = updates.title ?? title;
  return c.html(
    `<p class="text-emerald-400 text-xs">✓ Metadata fetched for <strong>${canonicalTitle}</strong>. Reload to see full details.</p>${posterHtml}`
  );
});

// ---------------------------------------------------------------------------
// Manual re-enrich by explicit API ID
// ---------------------------------------------------------------------------
app.post("/item/:id/re-enrich", async (c) => {
  const env = c.env;
  const itemId = c.req.param("id");
  const form = await c.req.parseBody();
  const tmdbId = parseInt(String(form.tmdb_id ?? "0"), 10) || 0;
  const igdbId = parseInt(String(form.igdb_id ?? "0"), 10) || 0;
  const booksId = String(form.books_id ?? "");

  const doc = await findById(env, "MediaLogs", itemId);
  if (!doc) return c.html("<p class='text-red-400 text-xs'>Item not found.</p>");
  const medium = doc.medium ?? "";
  let metadata: any = {};
  let posterUrl: string | null = null;
  const updates: Doc = {};

  try {
    if (tmdbId) {
      metadata = await fetchTmdbById(env, tmdbId, medium);
      const canonical = medium === "movie" ? metadata.title : metadata.name;
      if (canonical) updates.title = canonical;
      const dateField = medium === "movie" ? "release_date" : "first_air_date";
      if (metadata[dateField]) updates.year = parseInt(metadata[dateField].slice(0, 4), 10);
      if (metadata.poster_path) posterUrl = `${IMG(env)}${metadata.poster_path}`;
      const cr = extractCreator(metadata, medium);
      if (cr) updates.creator = cr;
    } else if (igdbId) {
      const body =
        `fields name,summary,genres.name,first_release_date,cover.url,rating,rating_count,` +
        `involved_companies.company.name,involved_companies.developer; where id = ${igdbId}; limit 1;`;
      const results = await igdbRequest(env, body);
      if (results.length) {
        metadata = { ...results[0] };
        updates.title = metadata.name ?? doc.title;
        if (metadata.first_release_date) updates.year = yearFromUnix(metadata.first_release_date);
        const cover = metadata.cover ?? {};
        if (cover.url) posterUrl = "https:" + String(cover.url).replace("t_thumb", "t_cover_big");
        const cr = extractCreator(metadata, "game");
        if (cr) updates.creator = cr;
      }
    } else if (booksId) {
      const info = await fetchOpenLibraryByKey(booksId);
      if (info) {
        metadata = info;
        if (info.title) updates.title = info.title;
        const ys = info.publishedDate ?? "";
        if (ys && /^\d{4}/.test(ys)) updates.year = parseInt(ys.slice(0, 4), 10);
        const authors = info.authors ?? [];
        if (authors.length) updates.creator = authors.join(", ");
        const thumb = info.imageLinks?.thumbnail;
        if (thumb) posterUrl = thumb;
      }
    }
  } catch (exc) {
    return c.html(`<p class='text-red-400 text-xs'>Error: ${String(exc).slice(0, 120)}</p>`);
  }

  if (!metadata || !Object.keys(metadata).length)
    return c.html("<p class='text-neutral-500 text-xs'>No data returned from API.</p>");

  Object.assign(updates, {
    metadata,
    poster_url: posterUrl,
    metadata_enriched: true,
    psychological_tags: {},
    enrichment_error: null,
  });
  await updateById(env, "MediaLogs", itemId, updates);

  const canonicalTitle = updates.title ?? doc.title;
  const posterHtml = posterUrl ? `<img src="${posterUrl}" class="w-16 rounded shadow mt-2">` : "";
  return c.html(
    `<div id="re-enrich-area" class="mb-6"><p class="text-emerald-400 text-xs">✓ Metadata updated for <strong>${canonicalTitle}</strong>. <a href="/item/${itemId}" class="underline">Reload</a> to see full details.</p>${posterHtml}</div>`
  );
});

// ---------------------------------------------------------------------------
// Tier management + item CRUD
// ---------------------------------------------------------------------------
app.post("/item/:id/set-tier", async (c) => {
  const env = c.env;
  const itemId = c.req.param("id");
  const form = await c.req.parseBody();
  const tierStr = String(form.tier ?? "");
  const tierInt = /^\d+$/.test(tierStr) ? parseInt(tierStr, 10) : null;
  await updateById(env, "MediaLogs", itemId, { tier: tierInt, rank_in_tier: null });
  return c.html(TierSelect(itemId, tierInt));
});

app.post("/item/:id/edit", async (c) => {
  const env = c.env;
  const itemId = c.req.param("id");
  const form = await c.req.parseBody();
  const yearStr = String(form.year ?? "").trim();
  await updateById(env, "MediaLogs", itemId, {
    title: String(form.title).trim(),
    creator: String(form.creator ?? "").trim(),
    year: /^\d+$/.test(yearStr) ? parseInt(yearStr, 10) : null,
    poster_url: String(form.poster_url ?? "").trim() || null,
  });
  return c.redirect(`/item/${itemId}`, 303);
});

app.post("/item/:id/delete", async (c) => {
  await deleteById(c.env, "MediaLogs", c.req.param("id"));
  return c.redirect("/", 303);
});

app.get("/item/:id", async (c) => {
  const env = c.env;
  const doc = await findById(env, "MediaLogs", c.req.param("id"));
  if (!doc) return c.html("<p>Not found.</p>", 404);
  const item = serialize(doc, env);

  const dims = [...DIMENSIONS] as string[];
  if (item.medium === "game") {
    for (const gd of ["sdt_autonomy", "sdt_competence"]) {
      if (gd in (item.psychological_tags ?? {})) dims.push(gd);
    }
  }

  const metadata = item.metadata ?? {};
  const medium = item.medium ?? "";
  let overview = "";
  let genres: any[] = [];
  if (medium === "movie" || medium === "tv") {
    overview = metadata.overview ?? "";
    genres = metadata.genres ?? [];
    if (genres.length && typeof genres[0] === "object") genres = genres.map((g: any) => g.name);
  } else if (medium === "book") {
    overview = metadata.description ?? "";
    genres = metadata.categories ?? [];
  } else if (medium === "game") {
    overview = metadata.summary ?? "";
    genres = (metadata.genres ?? []).map((g: any) => (typeof g === "object" ? g.name : g));
  }

  return c.html(Layout(`${item.title} — Tastemaker`, ItemDetail({ item, dims, overview, genres })));
});

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------
app.get("/watchlist", async (c) => {
  const env = c.env;
  const items = await query(env, "Watchlist", "SELECT * FROM Watchlist ORDER BY added_at DESC");
  for (const it of items) {
    it._id = String(it._id);
    it.poster_url = getPosterUrl(it, IMG(env));
  }
  const seenStream = new Set<string>();
  const seenBuy = new Set<string>();
  const streamProviders: any[] = [];
  const buyProviders: any[] = [];
  for (const it of items) {
    for (const p of it.watch_providers ?? []) {
      if (!p.name) continue;
      if (p.type === "buy") {
        if (!seenBuy.has(p.name)) {
          seenBuy.add(p.name);
          buyProviders.push(p);
        }
      } else {
        if (!seenStream.has(p.name)) {
          seenStream.add(p.name);
          streamProviders.push(p);
        }
      }
    }
  }
  streamProviders.sort((a, b) => a.name.localeCompare(b.name));
  buyProviders.sort((a, b) => a.name.localeCompare(b.name));
  const allSources = [...new Set(items.filter((it) => it.rec_source).map((it) => it.rec_source as string))].sort();
  return c.html(Layout("Watchlist — Tastemaker", Watchlist({ items, streamProviders, buyProviders, allSources })));
});

app.post("/watchlist/enrich-all", async (c) => {
  const env = c.env;
  // Bound the batch to stay under the Workers free-tier subrequest limit (50).
  const BATCH = 12;
  const needs = await query(
    env,
    "Watchlist",
    `SELECT * FROM Watchlist WHERE
       (medium IN ('movie','tv') AND (watch_providers IS NULL OR watch_providers = '[]'))
       OR rating_score IS NULL
     LIMIT ?`,
    [BATCH]
  );
  let countDone = 0;
  for (const item of needs) {
    try {
      const medium = item.medium;
      const { metadata, poster_url, watch_providers } = await enrichRec(env, item.title, medium);
      let ratingScore: number | null = null;
      if (medium === "movie" || medium === "tv") ratingScore = metadata.vote_average ?? null;
      else if (medium === "book") ratingScore = metadata.averageRating ?? null;
      else if (medium === "game") ratingScore = metadata.rating ?? null;
      const updates: Doc = {};
      if (watch_providers.length && !(item.watch_providers ?? []).length) updates.watch_providers = watch_providers;
      if (ratingScore != null && item.rating_score == null) updates.rating_score = ratingScore;
      if (!item.poster_url && poster_url) updates.poster_url = poster_url;
      if (!(item.metadata && Object.keys(item.metadata).length) && metadata && Object.keys(metadata).length)
        updates.metadata = metadata;
      if (Object.keys(updates).length) {
        await updateById(env, "Watchlist", String(item._id), updates);
        countDone++;
      }
    } catch {
      /* ignore */
    }
  }
  if (countDone)
    return c.html(
      `<span class="text-xs text-emerald-400">✓ Enriched ${countDone} item${countDone !== 1 ? "s" : ""}. <a href="/watchlist" class="underline hover:text-white">Reload to see changes →</a></span>`
    );
  return c.html('<span class="text-xs text-neutral-500">All items already enriched.</span>');
});

app.post("/library/enrich-all", async (c) => {
  const env = c.env;
  const BATCH = 12;
  const items = await query(
    env,
    "MediaLogs",
    `SELECT * FROM MediaLogs WHERE metadata_enriched = 0 OR metadata_enriched IS NULL OR poster_url IS NULL LIMIT ?`,
    [BATCH]
  );
  let countDone = 0;
  for (const item of items) {
    const medium = item.medium ?? "";
    if (!medium) continue;
    try {
      const { metadata, poster_url } = await enrichRec(env, item.title, medium);
      if (!metadata || !Object.keys(metadata).length) continue;
      const updates: Doc = { metadata, metadata_enriched: true };
      if (poster_url && !item.poster_url) updates.poster_url = poster_url;
      const canonical = metadata.title ?? metadata.name;
      if (canonical && canonical !== item.title) updates.title = canonical;
      await updateById(env, "MediaLogs", String(item._id), updates);
      countDone++;
    } catch {
      /* ignore */
    }
  }
  if (countDone)
    return c.html(
      `<span class="text-xs text-emerald-400">✓ Enriched ${countDone} item${countDone !== 1 ? "s" : ""}. <a href="/" class="underline hover:text-white">Reload to see changes →</a></span>`
    );
  return c.html('<span class="text-xs text-neutral-500">All items already enriched.</span>');
});

app.post("/watchlist/add", async (c) => {
  const env = c.env;
  const form = await c.req.parseBody();
  const title = String(form.title);
  const medium = String(form.medium);
  const reason = String(form.reason ?? "");
  const tmdbId = parseInt(String(form.tmdb_id ?? "0"), 10) || 0;
  const booksId = String(form.books_id ?? "");
  const igdbId = parseInt(String(form.igdb_id ?? "0"), 10) || 0;
  const selYear = String(form.sel_year ?? "");
  const selCreator = String(form.sel_creator ?? "");
  const selPoster = String(form.sel_poster_url ?? "");
  const ratingScoreForm = String(form.rating_score ?? "");
  const recSource = String(form.rec_source ?? "");
  const now = nowIso();

  let finalTitle = title;
  let creator = selCreator;
  let yearInt: number | null = /^\d+$/.test(selYear.trim()) ? parseInt(selYear, 10) : null;
  let posterUrl: string | null = selPoster || null;
  let metadata: any = {};
  let watchProviders: any[] = [];

  if (tmdbId) {
    try {
      metadata = await fetchTmdbById(env, tmdbId, medium);
      finalTitle = metadata.title ?? metadata.name ?? title;
      const dateField = medium === "movie" ? "release_date" : "first_air_date";
      if (metadata[dateField]) yearInt = parseInt(metadata[dateField].slice(0, 4), 10);
      if (metadata.poster_path) posterUrl = `${IMG(env)}${metadata.poster_path}`;
      watchProviders = metadata.watch_providers ?? [];
      if (!creator) creator = extractCreator(metadata, medium);
    } catch {
      /* ignore */
    }
  } else if (igdbId) {
    try {
      const body =
        `fields name,summary,genres.name,first_release_date,cover.url,rating,rating_count,` +
        `involved_companies.company.name,involved_companies.developer; where id = ${igdbId}; limit 1;`;
      const results = await igdbRequest(env, body);
      if (results.length) {
        metadata = { ...results[0] };
        finalTitle = metadata.name ?? title;
        if (metadata.first_release_date) yearInt = yearFromUnix(metadata.first_release_date);
        const cover = metadata.cover ?? {};
        if (cover.url) posterUrl = "https:" + String(cover.url).replace("t_thumb", "t_cover_big");
        if (!creator) creator = extractCreator(metadata, "game");
      }
    } catch {
      /* ignore */
    }
  } else if (booksId) {
    try {
      const info = await fetchOpenLibraryByKey(booksId);
      if (info) {
        finalTitle = info.title ?? title;
        const ys = info.publishedDate ?? "";
        if (ys && /^\d{4}/.test(ys)) yearInt = parseInt(ys.slice(0, 4), 10);
        if (!creator) creator = (info.authors ?? []).join(", ");
        const thumb = info.imageLinks?.thumbnail;
        if (thumb) posterUrl = thumb;
        metadata = info;
      }
    } catch {
      /* ignore */
    }
  }

  let storedRating: number | null = ratingScoreForm.trim() ? parseFloat(ratingScoreForm) : null;
  if (storedRating == null && (medium === "movie" || medium === "tv")) storedRating = metadata.vote_average ?? null;
  else if (storedRating == null && medium === "book") storedRating = metadata.averageRating ?? null;
  else if (storedRating == null && medium === "game") storedRating = metadata.rating ?? null;

  await insert(env, "Watchlist", {
    title: finalTitle,
    medium,
    creator,
    year: yearInt,
    source: "manual",
    reason,
    added_at: now,
    metadata,
    poster_url: posterUrl,
    watch_providers: watchProviders,
    psychological_tags: {},
    rating_score: storedRating,
    rec_source: recSource || null,
  });
  return c.html(WatchlistAdded(finalTitle));
});

app.post("/library/add", async (c) => {
  const env = c.env;
  const form = await c.req.parseBody();
  const title = String(form.title);
  const medium = String(form.medium);
  const reason = String(form.reason ?? "");
  const selPoster = String(form.sel_poster_url ?? "");

  const existing = await queryOne(
    env,
    "MediaLogs",
    "SELECT id FROM MediaLogs WHERE lower(title) = lower(?) AND medium = ?",
    [title, medium]
  );
  if (existing) return c.html('<span class="text-xs text-yellow-500">Already in library</span>');
  const now = nowIso();
  await insert(env, "MediaLogs", {
    title,
    medium,
    tier: null,
    rating: null,
    reason,
    added_at: now,
    logged_at: now,
    metadata: {},
    poster_url: selPoster || null,
    watch_providers: [],
    psychological_tags: {},
    metadata_enriched: false,
    source: "discover_recommendation",
  });
  return c.html('<span class="text-xs text-emerald-400">✓ In library</span>');
});

app.post("/watchlist/remove/:id", async (c) => {
  await deleteById(c.env, "Watchlist", c.req.param("id"));
  return c.html("");
});

app.post("/watchlist/promote/:id", async (c) => {
  const env = c.env;
  const itemId = c.req.param("id");
  const wl = await findById(env, "Watchlist", itemId);
  if (!wl) return c.redirect("/watchlist", 303);
  const now = nowIso();
  await insert(env, "MediaLogs", {
    title: wl.title,
    creator: wl.creator ?? "",
    medium: wl.medium,
    year: wl.year ?? null,
    original_rating: null,
    tier: null,
    date_logged: now,
    metadata_enriched: false,
    metadata: wl.metadata ?? {},
    psychological_tags: wl.psychological_tags ?? {},
    rank_in_tier: null,
    enrichment_error: null,
  });
  await deleteById(env, "Watchlist", itemId);
  return c.redirect(`/log?title=${encodeURIComponent(wl.title)}&medium=${encodeURIComponent(wl.medium)}`, 303);
});

// ---------------------------------------------------------------------------
// Discover blacklist
// ---------------------------------------------------------------------------
app.post("/discover/blacklist", async (c) => {
  const env = c.env;
  const form = await c.req.parseBody();
  const title = String(form.title);
  const medium = String(form.medium);
  const existing = await queryOne(
    env,
    "DiscoverBlacklist",
    "SELECT id FROM DiscoverBlacklist WHERE lower(title) = lower(?) AND medium = ?",
    [title, medium]
  );
  if (!existing) await insert(env, "DiscoverBlacklist", { title, medium, added_at: nowIso() });
  return c.html("");
});

app.get("/discover/blacklist", async (c) => {
  const items = await query(c.env, "DiscoverBlacklist", "SELECT * FROM DiscoverBlacklist ORDER BY added_at DESC");
  return c.html(Layout("Not Interested · Tastemaker", Blacklist(items)));
});

app.post("/discover/blacklist/remove/:id", async (c) => {
  await deleteById(c.env, "DiscoverBlacklist", c.req.param("id"));
  return c.html("");
});

// ---------------------------------------------------------------------------
// Discover (LLM recommendations)
// ---------------------------------------------------------------------------
async function loadClusterDefsWithExemplars(env: Env, limitExemplars: number): Promise<Doc[]> {
  const clusterDefs = await query(env, "ClusterDefs", "SELECT * FROM ClusterDefs ORDER BY cluster_id ASC");
  for (const cd of clusterDefs) {
    cd._id = String(cd._id);
    const exemplarIds = (cd.exemplar_ids ?? []).slice(0, limitExemplars);
    const exemplars: Doc[] = [];
    for (const eid of exemplarIds) {
      const d = await findById(env, "MediaLogs", eid);
      if (d) exemplars.push(serialize(d, env));
    }
    cd.exemplars = exemplars;
  }
  return clusterDefs;
}

app.get("/discover", async (c) => {
  const cluster = parseInt(c.req.query("cluster") ?? "-1", 10);
  const clusterDefs = await loadClusterDefsWithExemplars(c.env, 3);
  return c.html(Layout("Discover — Tastemaker", Discover(clusterDefs, cluster)));
});

async function buildExclusion(env: Env): Promise<{ exclusion: Set<string>; exclusionNorm: Set<string>; exclusionStr: string }> {
  const seen = (await query(env, "MediaLogs", "SELECT title FROM MediaLogs")).map((i) => i.title.toLowerCase());
  const queued = (await query(env, "Watchlist", "SELECT title FROM Watchlist")).map((i) => i.title.toLowerCase());
  const blocked = (await query(env, "DiscoverBlacklist", "SELECT title FROM DiscoverBlacklist")).map((i) =>
    i.title.toLowerCase()
  );
  const exclusion = new Set([...seen, ...queued, ...blocked]);
  const exclusionNorm = new Set([...exclusion].map((t) => normalizeTitle(t)));
  const exclusionStr = [...exclusion].sort().join("\n");
  return { exclusion, exclusionNorm, exclusionStr };
}

async function enrichAndNormalize(env: Env, rec: any): Promise<any> {
  const title = rec.title;
  const medium = rec.medium ?? "";
  // light: 1 subrequest per rec so all ~25 fit under the free-tier cap.
  // Providers are fetched later when the user adds the rec to their watchlist.
  const { metadata, poster_url, watch_providers } = await enrichRec(env, title, medium, { light: true });
  let finalTitle = title;
  let year: number | null = null;
  let creator = "";
  if (medium === "movie" && metadata.title) {
    finalTitle = metadata.title;
    if (metadata.release_date) year = parseInt(metadata.release_date.slice(0, 4), 10);
  } else if (medium === "tv" && metadata.name) {
    finalTitle = metadata.name;
    if (metadata.first_air_date) year = parseInt(metadata.first_air_date.slice(0, 4), 10);
    const cb = metadata.created_by ?? [];
    if (cb.length) creator = cb[0].name;
  } else if (medium === "book") {
    if (metadata.title) finalTitle = metadata.title;
    if (metadata.publishedDate) year = parseInt(metadata.publishedDate.slice(0, 4), 10);
    const authors = metadata.authors ?? [];
    if (authors.length) creator = authors.join(", ");
  } else if (medium === "game" && metadata.name) {
    finalTitle = metadata.name;
    if (metadata.first_release_date) year = yearFromUnix(metadata.first_release_date);
    creator = extractCreator(metadata, "game");
  }
  let ratingScore: number | null = null;
  let ratingCount = 0;
  if (medium === "movie" || medium === "tv") {
    ratingScore = metadata.vote_average ?? null;
    ratingCount = metadata.vote_count ?? 0;
  } else if (medium === "book") {
    ratingScore = metadata.averageRating ?? null;
    ratingCount = metadata.ratingsCount ?? 0;
  } else if (medium === "game") {
    ratingScore = metadata.rating ?? null;
    ratingCount = metadata.rating_count ?? 0;
  }
  return {
    title: finalTitle,
    medium,
    creator,
    year,
    reason: rec.reason ?? "",
    metadata,
    poster_url,
    watch_providers,
    rating_score: ratingScore,
    rating_count: ratingCount,
  };
}

function passesQualityFilter(rec: any): boolean {
  const floor = QUALITY_FLOORS[rec.medium ?? ""];
  if (!floor) return true;
  const score = rec.rating_score;
  const cnt = rec.rating_count ?? 0;
  if (score == null || cnt < floor.min_count) return true;
  return score >= floor.min_score;
}

app.post("/discover/generate", async (c) => {
  const env = c.env;
  const form = await c.req.parseBody();
  const mode = String(form.mode ?? "seed");
  const seedIds = String(form.seed_ids ?? "");
  const clusterId = parseInt(String(form.cluster_id ?? "-1"), 10);
  const targetMedium = String(form.target_medium ?? "");

  const { exclusion, exclusionNorm, exclusionStr } = await buildExclusion(env);

  let system: string;
  let userMsg: string;
  let recSource: string;

  // "Looking for" is the medium constraint, NOT the seed/exemplar media. When a
  // target is chosen, restrict to it; otherwise explicitly ask for a cross-medium
  // mix so seeding only (say) TV shows doesn't bias the results toward TV.
  const mediumConstraint = targetMedium
    ? `\nIMPORTANT: Recommend ${targetMedium}s only. Every item in the array must have "medium": "${targetMedium}".`
    : `\nIMPORTANT: Recommend a deliberate MIX across all media — movies, TV, books, AND games. Do NOT limit recommendations to the same medium as the example titles; the medium of the examples is irrelevant. Match on shared qualities and aim for variety in format, ideally with at least a few of each medium.`;

  if (mode === "seed") {
    const ids = seedIds.split(",").map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return c.html("<p class='text-neutral-500 text-sm'>Select at least one seed title.</p>");
    const seedDocs: Doc[] = [];
    for (const sid of ids) {
      const d = await findById(env, "MediaLogs", sid);
      if (d) seedDocs.push(d);
    }
    if (!seedDocs.length) return c.html("<p class='text-neutral-500 text-sm'>Seed titles not found.</p>");

    let seedsStr = "";
    for (const doc of seedDocs) {
      const tags = doc.psychological_tags ?? {};
      const tagStr = Object.entries(tags)
        .filter(([k]) => KNOWN_DIMS.has(k))
        .map(([k, v]) => `${DIMENSION_LABELS[k] ?? k}=${Math.round((v as number) * 10) / 10}`)
        .join(", ");
      seedsStr += `- ${doc.title} (${doc.medium ?? ""})`;
      if (tagStr) seedsStr += `\n  Profile: ${tagStr}`;
      seedsStr += "\n";
    }
    userMsg =
      `The user enjoys these titles:\n${seedsStr}\n` +
      `Titles to EXCLUDE (${exclusion.size} total):\n${exclusionStr}` +
      mediumConstraint;
    system = SEED_SYSTEM_PROMPT;
    recSource = "seed";
  } else {
    const cd = await queryOne(env, "ClusterDefs", "SELECT * FROM ClusterDefs WHERE cluster_id = ?", [clusterId]);
    if (!cd) return c.html("<p class='text-neutral-500 text-sm'>Cluster not found. Run clustering first.</p>");
    const centroid = cd.centroid ?? {};
    const centroidStr = DIMENSIONS.filter((d) => d in centroid)
      .map((d) => `  ${DIMENSION_LABELS[d] ?? d}: ${Number(centroid[d] ?? 3.0).toFixed(1)}`)
      .join("\n");
    const exemplarIds = (cd.exemplar_ids ?? []).slice(0, 10);
    const exemplarDocs: Doc[] = [];
    for (const eid of exemplarIds) {
      const d = await findById(env, "MediaLogs", eid);
      if (d) exemplarDocs.push(d);
    }
    const exemplarTitles = exemplarDocs.map((d) => `  - ${d.title} (${d.medium ?? ""})`).join("\n");
    userMsg =
      `Taste cluster: "${cd.name}"\n${cd.description ?? ""}\n\n` +
      `Psychological profile (1.0–5.0):\n${centroidStr}\n\n` +
      `Example titles from this cluster:\n${exemplarTitles}\n\n` +
      `Titles to EXCLUDE (${exclusion.size} total):\n${exclusionStr}` +
      mediumConstraint;
    system = CLUSTER_SYSTEM_PROMPT;
    recSource = cd.name;
  }

  let recsRaw: any[];
  try {
    const raw = await anthropicMessages(env, {
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      system,
      messages: [{ role: "user", content: userMsg }],
    });
    recsRaw = parseLlmJson(raw);
  } catch (exc) {
    return c.html(`<p class='text-red-400 text-sm'>Error: ${String(exc).slice(0, 200)}</p>`);
  }

  const results: any[] = [];
  const filteredOut: string[] = [];
  // Each rec costs 1 subrequest (light enrichment) + the 1 LLM call above, so a
  // full 25-rec batch stays well under the Workers free-tier 50-subrequest cap.
  for (const rec of recsRaw) {
    if (!rec || typeof rec !== "object" || !rec.title) continue;
    const t = rec.title;
    if (exclusion.has(t.toLowerCase()) || exclusionNorm.has(normalizeTitle(t))) {
      filteredOut.push(t);
      continue;
    }
    const enriched = await enrichAndNormalize(env, rec);
    const finalT = enriched.title ?? t;
    if (exclusion.has(finalT.toLowerCase()) || exclusionNorm.has(normalizeTitle(finalT))) {
      filteredOut.push(finalT);
      continue;
    }
    if (!passesQualityFilter(enriched)) {
      const score = enriched.rating_score;
      filteredOut.push(score ? `${finalT} (score: ${Number(score).toFixed(1)})` : finalT);
      continue;
    }
    results.push(enriched);
  }

  return c.html(DiscoverResults(results, filteredOut, recSource));
});

// ---------------------------------------------------------------------------
// Taste profile
// ---------------------------------------------------------------------------
app.get("/profile", async (c) => {
  const env = c.env;

  const avgVector = (docs: Doc[]): Record<string, number> => {
    const sums: Record<string, number> = {};
    const counts: Record<string, number> = {};
    for (const d of docs) {
      for (const [k, v] of Object.entries(d.psychological_tags ?? {})) {
        if (KNOWN_DIMS.has(k)) {
          sums[k] = (sums[k] ?? 0) + (v as number);
          counts[k] = (counts[k] ?? 0) + 1;
        }
      }
    }
    const out: Record<string, number> = {};
    for (const k of Object.keys(sums)) out[k] = Math.round((sums[k] / counts[k]) * 100) / 100;
    return out;
  };

  const tier12 = await query(
    env,
    "MediaLogs",
    "SELECT psychological_tags FROM MediaLogs WHERE tier IN (1,2) AND psychological_tags IS NOT NULL AND psychological_tags != '{}'"
  );
  const tier5 = await query(
    env,
    "MediaLogs",
    "SELECT psychological_tags FROM MediaLogs WHERE tier = 5 AND psychological_tags IS NOT NULL AND psychological_tags != '{}'"
  );
  const lovedVec = avgVector(tier12);
  const dislikedVec = avgVector(tier5);

  const dimRows: DimRow[] = DIMENSIONS.map((dim) => {
    const loved = lovedVec[dim] ?? null;
    const disliked = dislikedVec[dim] ?? null;
    const delta = loved != null && disliked != null ? Math.round((loved - disliked) * 100) / 100 : null;
    return {
      key: dim,
      label: DIMENSION_LABELS[dim],
      definition: DIMENSION_DEFINITIONS[dim] ?? "",
      loved,
      disliked,
      delta,
      bar_pct: loved ? Math.round(((loved - 1) / 4) * 100 * 10) / 10 : 0,
    };
  });
  const byScore = dimRows.filter((r) => r.loved).sort((a, b) => (b.loved ?? 0) - (a.loved ?? 0));
  const byDelta = dimRows.filter((r) => r.delta != null).sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0));

  const clusterDefs = await query(env, "ClusterDefs", "SELECT * FROM ClusterDefs ORDER BY cluster_id ASC");
  const clusters: ProfileCluster[] = [];
  for (const cd of clusterDefs) {
    const exemplarIds = (cd.exemplar_ids ?? []).slice(0, 3);
    const exemplars: Doc[] = [];
    for (const eid of exemplarIds) {
      const d = await findById(env, "MediaLogs", eid);
      if (d) exemplars.push(serialize(d, env));
    }
    const centroid = cd.centroid ?? {};
    const centroidRows = DIMENSIONS.filter((d) => d in centroid)
      .map((d) => ({
        label: DIMENSION_LABELS[d] ?? d,
        score: centroid[d] ?? 3.0,
        bar_pct: Math.round((((centroid[d] ?? 3.0) - 1) / 4) * 100 * 10) / 10,
      }))
      .sort((a, b) => b.score - a.score);
    clusters.push({
      cluster_id: cd.cluster_id,
      name: cd.name,
      description: cd.description ?? "",
      size: cd.size ?? 0,
      exemplars,
      centroid_rows: centroidRows,
    });
  }

  const votes: Record<string, { most: number; least: number }> = {};
  for (const doc of await query(env, "TasteClusters", "SELECT dimension, utility_type FROM TasteClusters")) {
    const dim = doc.dimension;
    const ut = doc.utility_type;
    if (dim && (ut === "most" || ut === "least") && KNOWN_DIMS.has(dim)) {
      (votes[dim] ??= { most: 0, least: 0 })[ut as "most" | "least"]++;
    }
  }
  const clusterRows = Object.entries(votes)
    .map(([k, v]) => ({ label: DIMENSION_LABELS[k] ?? k, most: v.most, least: v.least }))
    .sort((a, b) => b.most - b.least - (a.most - a.least));

  const total = await count(env, "SELECT COUNT(*) as c FROM MediaLogs");
  const tierCounts: Record<number, number> = {};
  for (const t of [1, 2, 3, 4, 5]) {
    tierCounts[t] = await count(env, "SELECT COUNT(*) as c FROM MediaLogs WHERE tier = ?", [t]);
  }
  const enriched = await count(
    env,
    "SELECT COUNT(*) as c FROM MediaLogs WHERE psychological_tags IS NOT NULL AND psychological_tags != '{}'"
  );

  return c.html(
    Layout(
      "Taste Profile — Tastemaker",
      Profile({ clusters, byScore, byDelta, clusterRows, total, tierCounts, enriched, lovedCount: tier12.length })
    )
  );
});

// ---------------------------------------------------------------------------
// Admin: enrichment + clustering (replace `python enrichment.py` / `cluster.py`)
// ---------------------------------------------------------------------------
app.get("/admin", async (c) => {
  const env = c.env;
  const total = await count(env, "SELECT COUNT(*) as c FROM MediaLogs");
  const scored = await count(
    env,
    "SELECT COUNT(*) as c FROM MediaLogs WHERE psychological_tags IS NOT NULL AND psychological_tags != '{}'"
  );
  const unscored = await count(
    env,
    "SELECT COUNT(*) as c FROM MediaLogs WHERE (psychological_tags IS NULL OR psychological_tags = '{}') AND enrichment_error IS NULL"
  );
  const errored = await count(env, "SELECT COUNT(*) as c FROM MediaLogs WHERE enrichment_error IS NOT NULL");
  const clusters = await count(env, "SELECT COUNT(*) as c FROM ClusterDefs");
  return c.html(Layout("Maintenance — Tastemaker", Admin({ total, scored, unscored, errored, clusters })));
});

app.post("/admin/enrich", async (c) => {
  const env = c.env;
  const BATCH = 8; // bounded for the free-tier subrequest limit; call repeatedly.
  // Target items missing psychological scores. Skip ones that already errored so
  // the loop can't re-select the same failures forever (clear the error via the
  // item's "Fix / Re-search metadata" to retry).
  const NEEDS = "(psychological_tags IS NULL OR psychological_tags = '{}') AND enrichment_error IS NULL";
  const records = await query(env, "MediaLogs", `SELECT * FROM MediaLogs WHERE ${NEEDS} LIMIT ?`, [BATCH]);
  if (!records.length) return c.json({ done: true, enriched: 0, errored: 0, remaining: 0 });

  const basePrompt = await buildSystemPrompt(env, "other");
  const gamePrompt = await buildSystemPrompt(env, "game");
  const genreMap = await fetchTmdbGenreMap(env);

  let enriched = 0;
  let errored = 0;
  for (const doc of records) {
    const medium = doc.medium;
    const systemPrompt = medium === "game" ? gamePrompt : basePrompt;
    let metadata = doc.metadata && Object.keys(doc.metadata).length ? doc.metadata : null;
    try {
      if (!metadata) {
        if (medium === "movie" || medium === "tv") metadata = await fetchTmdb(env, doc.title, medium, genreMap);
        else if (medium === "game") metadata = await fetchIgdb(env, doc.title);
        else metadata = await fetchOpenLibrary(doc.title, doc.creator ?? "");
        if (metadata == null) {
          await updateById(env, "MediaLogs", String(doc._id), { enrichment_error: "no_api_match" });
          errored++;
          continue;
        }
        await updateById(env, "MediaLogs", String(doc._id), { metadata });
      }
    } catch (exc) {
      await updateById(env, "MediaLogs", String(doc._id), { enrichment_error: `api_error: ${String(exc).slice(0, 120)}` });
      errored++;
      continue;
    }
    doc.metadata = metadata;
    try {
      const tags = await tagWithLlm(env, doc, systemPrompt);
      await updateById(env, "MediaLogs", String(doc._id), {
        psychological_tags: tags,
        metadata_enriched: true,
        enrichment_error: null,
      });
      enriched++;
    } catch (exc) {
      await updateById(env, "MediaLogs", String(doc._id), { enrichment_error: `llm_error: ${String(exc).slice(0, 120)}` });
      errored++;
    }
  }
  const remaining = await count(env, `SELECT COUNT(*) as c FROM MediaLogs WHERE ${NEEDS}`);
  return c.json({ done: remaining === 0, enriched, errored, remaining });
});

async function runClustering(env: Env, k: number): Promise<{ k: number; assigned: number }> {
  const docs = await query(
    env,
    "MediaLogs",
    "SELECT id, title, medium, tier, psychological_tags FROM MediaLogs WHERE tier IN (1,2) AND psychological_tags IS NOT NULL AND psychological_tags != '{}'"
  );
  if (docs.length < k) throw new Error(`Need at least k=${k} enriched Tier 1/2 items, have ${docs.length}.`);

  const ids = docs.map((d) => String(d._id));
  const X = docs.map((d) => buildFeatureRow(d.psychological_tags));
  const { labels, centroids } = kmeans(X, k, 42, 10);

  await env.DB.prepare("UPDATE MediaLogs SET cluster_id = NULL").run();
  for (let i = 0; i < ids.length; i++) {
    await updateById(env, "MediaLogs", ids[i], { cluster_id: labels[i] });
  }

  for (let clusterId = 0; clusterId < k; clusterId++) {
    const memberIdx = labels.map((l, i) => (l === clusterId ? i : -1)).filter((i) => i >= 0);
    const memberRows = memberIdx.map((i) => X[i]);
    const centroidNorm = centroids[clusterId];
    const centroid = denormalizeCentroid(centroidNorm);
    const top = topExemplarIndices(memberRows, centroidNorm, 10);
    const topDocIds = top.map((i) => ids[memberIdx[i]]);
    const exemplarTitles = top.map((i) => docs[memberIdx[i]].title);

    const centroidStr = CLUSTER_DIMS.map((d) => `  ${DIMENSION_LABELS[d]}: ${centroid[d].toFixed(1)}`).join("\n");
    const titlesStr = exemplarTitles.map((t) => `  - ${t}`).join("\n");
    const userMsg = `Dimension centroid (1.0 low → 5.0 high):\n${centroidStr}\n\nTop titles in this cluster:\n${titlesStr}`;

    let name = `Cluster ${clusterId}`;
    let description = "";
    try {
      const raw = await anthropicMessages(env, {
        model: "claude-haiku-4-5",
        max_tokens: 256,
        system: NAMING_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMsg }],
      });
      const result = parseLlmJson(raw);
      name = result.name;
      description = result.description;
    } catch (exc) {
      description = `(naming failed: ${exc})`;
    }

    await env.DB.prepare(
      `INSERT INTO ClusterDefs (id, cluster_id, name, description, centroid, size, exemplar_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cluster_id) DO UPDATE SET
         name=excluded.name, description=excluded.description, centroid=excluded.centroid,
         size=excluded.size, exemplar_ids=excluded.exemplar_ids`
    )
      .bind(newId(), clusterId, name, description, JSON.stringify(centroid), memberIdx.length, JSON.stringify(topDocIds))
      .run();
  }
  return { k, assigned: docs.length };
}

app.post("/admin/recluster", async (c) => {
  const k = parseInt(c.req.query("k") ?? "4", 10);
  try {
    const res = await runClustering(c.env, k);
    return c.json({ ok: true, ...res });
  } catch (exc) {
    return c.json({ ok: false, error: String(exc) }, 400);
  }
});

export default {
  fetch: app.fetch,
  // Cron-triggered reclustering (mirrors running cluster.py). Enable via
  // [triggers] crons in wrangler.toml.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runClustering(env, 4).catch((e) => console.log(`recluster failed: ${e}`)));
  },
};
