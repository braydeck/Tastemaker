// Port of enrichment.py: TMDB / Open Library / IGDB / Anthropic clients with
// exponential backoff, plus the LLM tagging + system-prompt builder used by the
// admin enrichment route. All HTTP via fetch (Workers-compatible).

import type { Env, Doc } from "./db";
import {
  TMDB_BASE,
  IGDB_API_URL,
  BASE_SYSTEM_PROMPT,
  GAME_SYSTEM_PROMPT,
  DEFAULT_ANCHORS,
} from "./constants";
import { getIgdbToken, fetchIgdbToken } from "./igdbToken";

const MAX_RETRIES = 5;
const BACKOFF_BASE = 1; // seconds
const BACKOFF_MAX = 32; // seconds
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(seconds: number): Promise<void> {
  return new Promise((r) => setTimeout(r, seconds * 1000));
}

function backoffWait(attempt: number): Promise<void> {
  return sleep(Math.min(BACKOFF_BASE * 2 ** attempt, BACKOFF_MAX));
}

// ---------------------------------------------------------------------------
// HTTP helpers with exponential backoff
// ---------------------------------------------------------------------------

export async function getWithBackoff(url: string): Promise<Response> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url);
    } catch (e) {
      if (attempt === MAX_RETRIES - 1) throw e;
      await backoffWait(attempt);
      continue;
    }
    if (RETRY_STATUS.has(resp.status)) {
      if (attempt === MAX_RETRIES - 1) throw new Error(`HTTP ${resp.status} for ${url}`);
      await backoffWait(attempt);
      continue;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    return resp;
  }
  throw new Error("getWithBackoff: max retries exceeded");
}

export async function postWithBackoff(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, { method: "POST", ...init });
    } catch (e) {
      if (attempt === MAX_RETRIES - 1) throw e;
      await backoffWait(attempt);
      continue;
    }
    if (RETRY_STATUS.has(resp.status)) {
      if (attempt === MAX_RETRIES - 1) throw new Error(`HTTP ${resp.status} for ${url}`);
      await backoffWait(attempt);
      continue;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    return resp;
  }
  throw new Error("postWithBackoff: max retries exceeded");
}

function tmdbUrl(path: string, params: Record<string, string | number>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  return `${TMDB_BASE}${path}?${qs.toString()}`;
}

// ---------------------------------------------------------------------------
// IGDB request (401 token refresh + backoff)
// ---------------------------------------------------------------------------

export async function igdbRequest(env: Env, body: string): Promise<any> {
  let token = await getIgdbToken(env);
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const resp = await fetch(IGDB_API_URL, {
      method: "POST",
      headers: { "Client-ID": env.IGDB_CLIENT_ID, Authorization: `Bearer ${token}` },
      body,
    });
    if (resp.status === 401) {
      token = await fetchIgdbToken(env);
      continue;
    }
    if (RETRY_STATUS.has(resp.status)) {
      if (attempt === MAX_RETRIES - 1) throw new Error(`IGDB HTTP ${resp.status}`);
      await backoffWait(attempt);
      continue;
    }
    if (!resp.ok) throw new Error(`IGDB HTTP ${resp.status}`);
    return await resp.json();
  }
  throw new Error("igdbRequest: max retries exceeded");
}

// ---------------------------------------------------------------------------
// TMDB
// ---------------------------------------------------------------------------

export async function fetchTmdbGenreMap(env: Env): Promise<Record<number, string>> {
  const map: Record<number, string> = {};
  for (const mediaType of ["movie", "tv"]) {
    try {
      const resp = await getWithBackoff(
        tmdbUrl(`/genre/${mediaType}/list`, { api_key: env.TMDB_API_KEY })
      );
      const data = (await resp.json()) as any;
      for (const g of data.genres ?? []) map[g.id] = g.name;
    } catch {
      /* ignore */
    }
  }
  return map;
}

// Fetch full TMDB metadata + US watch providers for a known TMDB ID.
export async function fetchTmdbById(env: Env, tmdbId: number, medium: string): Promise<any> {
  const endpoint = medium === "movie" ? "movie" : "tv";
  const resp = await getWithBackoff(
    tmdbUrl(`/${endpoint}/${tmdbId}`, {
      api_key: env.TMDB_API_KEY,
      append_to_response: "credits",
    })
  );
  const data = (await resp.json()) as any;
  try {
    const wpResp = await getWithBackoff(
      tmdbUrl(`/${endpoint}/${tmdbId}/watch/providers`, { api_key: env.TMDB_API_KEY })
    );
    const us = ((await wpResp.json()) as any).results?.US ?? {};
    data.watch_providers = [
      ...(us.flatrate ?? []).map((p: any) => ({
        name: p.provider_name,
        logo_path: p.logo_path,
        type: "stream",
      })),
      ...(us.buy ?? []).map((p: any) => ({
        name: p.provider_name,
        logo_path: p.logo_path,
        type: "buy",
      })),
    ];
  } catch {
    data.watch_providers = [];
  }
  return data;
}

export interface EnrichResult {
  metadata: any;
  poster_url: string | null;
  watch_providers: any[];
}

// Fetch metadata, poster_url, watch_providers for a title via TMDB / OL / IGDB.
// opts.light skips the extra subrequests (TMDB watch-providers, OL work detail)
// so a batch of these stays well under the Workers free-tier subrequest cap.
export async function enrichRec(
  env: Env,
  title: string,
  medium: string,
  opts: { light?: boolean } = {}
): Promise<EnrichResult> {
  let metadata: any = {};
  let posterUrl: string | null = null;
  let watchProviders: any[] = [];
  try {
    if (medium === "movie" || medium === "tv") {
      const endpoint = medium === "movie" ? "movie" : "tv";
      const resp = await getWithBackoff(
        tmdbUrl(`/search/${endpoint}`, { query: title, api_key: env.TMDB_API_KEY })
      );
      const results = ((await resp.json()) as any).results ?? [];
      if (results.length) {
        metadata = { ...results[0] };
        if (metadata.poster_path) posterUrl = `${env.TMDB_IMAGE_BASE}${metadata.poster_path}`;
        if (!opts.light) try {
          const wpResp = await getWithBackoff(
            tmdbUrl(`/${endpoint}/${metadata.id}/watch/providers`, { api_key: env.TMDB_API_KEY })
          );
          const us = ((await wpResp.json()) as any).results?.US ?? {};
          watchProviders = [
            ...(us.flatrate ?? []).map((p: any) => ({
              name: p.provider_name,
              logo_path: p.logo_path,
              type: "stream",
            })),
            ...(us.buy ?? []).map((p: any) => ({
              name: p.provider_name,
              logo_path: p.logo_path,
              type: "buy",
            })),
          ];
          metadata.watch_providers = watchProviders;
        } catch {
          /* ignore */
        }
      }
    } else if (medium === "book") {
      metadata = (await fetchOpenLibrary(title, "", opts.light)) ?? {};
      if (metadata && Object.keys(metadata).length) {
        posterUrl = metadata.imageLinks?.thumbnail ?? null;
      }
    } else if (medium === "game") {
      const body =
        `search "${title}"; ` +
        "fields name,summary,genres.name,themes.name,first_release_date,cover.url," +
        "rating,rating_count,involved_companies.company.name,involved_companies.developer; " +
        "limit 1;";
      const results = await igdbRequest(env, body);
      if (results.length) {
        metadata = { ...results[0] };
        const cover = metadata.cover ?? {};
        if (cover.url) posterUrl = "https:" + String(cover.url).replace("t_thumb", "t_cover_big");
      }
    }
  } catch {
    /* swallow — matches Python's broad except */
  }
  return { metadata, poster_url: posterUrl, watch_providers: watchProviders };
}

// Search TMDB (uses genre map to resolve genre_ids), returns best match.
export async function fetchTmdb(
  env: Env,
  title: string,
  medium: string,
  genreMap: Record<number, string>
): Promise<any | null> {
  const endpoint = medium === "movie" ? "movie" : "tv";
  const resp = await getWithBackoff(
    tmdbUrl(`/search/${endpoint}`, { query: title, api_key: env.TMDB_API_KEY })
  );
  const results = ((await resp.json()) as any).results ?? [];
  if (!results.length) return null;
  const result = { ...results[0] };
  result.genres = (result.genre_ids ?? []).map((gid: number) => genreMap[gid] ?? String(gid));
  return result;
}

// Search IGDB, filtering DLC/edition variants, returns best match.
export async function fetchIgdb(env: Env, title: string): Promise<any | null> {
  const body =
    `search "${title}"; ` +
    "fields name,summary,genres.name,themes.name,first_release_date,cover.url," +
    "rating,rating_count,involved_companies.company.name,involved_companies.developer," +
    "parent_game,version_parent; " +
    "limit 10;";
  const raw = await igdbRequest(env, body);
  const resultIds = new Set(raw.map((r: any) => r.id));
  const results = raw.filter(
    (r: any) => !r.version_parent && !resultIds.has(r.parent_game)
  );
  if (!results.length) return null;
  const result = { ...results[0] };
  const cover = result.cover ?? {};
  if (cover.url) result.cover_url = "https:" + String(cover.url).replace("t_thumb", "t_cover_big");
  return result;
}

// ---------------------------------------------------------------------------
// Open Library
// ---------------------------------------------------------------------------

function normalizeOlDoc(doc: any, description = ""): any {
  const year = doc.first_publish_year;
  let authors = doc.author_name ?? doc.authors ?? [];
  if (authors.length && typeof authors[0] === "object") {
    authors = authors.map((a: any) => a.name ?? "");
  }
  let subjects = doc.subject ?? doc.subjects ?? [];
  if (subjects.length && typeof subjects[0] === "object") {
    subjects = subjects.map((s: any) => (typeof s === "object" ? s.name ?? s : String(s)));
  }
  const coverId = doc.cover_i;
  const coverEdition = doc.cover_edition_key;
  const covers = doc.covers ?? [];
  const imageLinks: any = {};
  if (coverId) {
    imageLinks.thumbnail = `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`;
  } else if (coverEdition) {
    imageLinks.thumbnail = `https://covers.openlibrary.org/b/olid/${coverEdition}-M.jpg`;
  } else if (covers.length) {
    const cid = covers.find((c: number) => c > 0);
    if (cid) imageLinks.thumbnail = `https://covers.openlibrary.org/b/id/${cid}-M.jpg`;
  }
  if (!description) {
    const descRaw = doc.description ?? "";
    description = typeof descRaw === "object" ? descRaw.value ?? "" : descRaw;
  }
  return {
    title: doc.title ?? "",
    publishedDate: year ? String(year) : "",
    authors,
    description,
    categories: subjects.slice(0, 10),
    imageLinks,
    ol_key: doc.key ?? "",
  };
}

export async function fetchOpenLibrary(
  title: string,
  creator: string,
  light = false
): Promise<any | null> {
  let q = title;
  if (creator) q += ` ${creator}`;
  const params = new URLSearchParams({
    q,
    limit: "1",
    fields: "key,title,author_name,first_publish_year,cover_i,cover_edition_key,subject",
  });
  const resp = await getWithBackoff(`https://openlibrary.org/search.json?${params.toString()}`);
  const docs = ((await resp.json()) as any).docs ?? [];
  if (!docs.length) return null;
  const doc = docs[0];
  let description = "";
  const workKey = doc.key ?? "";
  if (workKey && !light) {
    try {
      const workResp = await getWithBackoff(`https://openlibrary.org${workKey}.json`);
      const workData = (await workResp.json()) as any;
      const descRaw = workData.description ?? "";
      description = typeof descRaw === "object" ? descRaw.value ?? "" : descRaw;
    } catch {
      /* ignore */
    }
  }
  return normalizeOlDoc(doc, description);
}

export async function fetchOpenLibraryByKey(olKey: string): Promise<any | null> {
  if (!olKey) return null;
  const url = olKey.startsWith("/")
    ? `https://openlibrary.org${olKey}.json`
    : `https://openlibrary.org/works/${olKey}.json`;
  const resp = await getWithBackoff(url);
  const data = (await resp.json()) as any;
  const authors: string[] = [];
  for (const a of data.authors ?? []) {
    const ref = a.author ?? a;
    const authorKey = ref && typeof ref === "object" ? ref.key : null;
    if (authorKey) {
      try {
        const ar = await getWithBackoff(`https://openlibrary.org${authorKey}.json`);
        authors.push(((await ar.json()) as any).name ?? "");
      } catch {
        /* ignore */
      }
    }
  }
  data.authors = authors;
  return normalizeOlDoc(data);
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

export interface AnthropicBody {
  model: string;
  max_tokens: number;
  system: string | any[];
  messages: { role: string; content: string }[];
}

// Returns the assistant's text content. Retries on 429/5xx.
export async function anthropicMessages(env: Env, body: AnthropicBody): Promise<string> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (resp.status === 429 || (resp.status >= 500 && resp.status <= 504)) {
      if (attempt === MAX_RETRIES - 1) throw new Error(`Anthropic HTTP ${resp.status}`);
      await backoffWait(attempt);
      continue;
    }
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Anthropic HTTP ${resp.status}: ${txt.slice(0, 200)}`);
    }
    const data = (await resp.json()) as any;
    return (data.content?.[0]?.text ?? "").trim();
  }
  throw new Error("anthropicMessages: max retries exceeded");
}

// Strip a leading ```...``` fence if present, then JSON.parse.
export function parseLlmJson(raw: string): any {
  let s = raw.trim();
  if (s.startsWith("```")) {
    const firstNl = s.indexOf("\n");
    if (firstNl >= 0) s = s.slice(firstNl + 1);
    const lastFence = s.lastIndexOf("```");
    if (lastFence >= 0) s = s.slice(0, lastFence);
    s = s.trim();
  }
  return JSON.parse(s);
}

// ---------------------------------------------------------------------------
// LLM tagging (used by the admin enrichment route, replaces enrichment.py main)
// ---------------------------------------------------------------------------

function extractGenresStr(metadata: any): string {
  const raw = metadata.genres ?? [];
  if (!raw.length) return "";
  if (typeof raw[0] === "object") return raw.map((g: any) => g.name ?? "").join(", ");
  return raw.map((g: any) => String(g)).join(", ");
}

export function buildUserMessage(doc: Doc): string {
  const medium = doc.medium ?? "";
  const metadata = doc.metadata ?? {};
  let summary = "";
  let genresStr = "";
  let tagsStr = "";
  if (medium === "movie" || medium === "tv") {
    summary = metadata.overview ?? "";
    genresStr = extractGenresStr(metadata);
  } else if (medium === "game") {
    summary = metadata.summary ?? "";
    genresStr = extractGenresStr(metadata);
    const themes = metadata.themes ?? [];
    tagsStr = themes.map((t: any) => (typeof t === "object" ? t.name ?? "" : String(t))).join(", ");
  } else {
    summary = metadata.description ?? "";
    genresStr = (metadata.categories ?? []).join(", ");
    tagsStr = metadata.maturityRating ?? "";
  }
  return (
    "Score the following work:\n\n" +
    `Title: ${doc.title ?? ""}\n` +
    `Medium: ${medium}\n` +
    `Creator: ${doc.creator || "Unknown"}\n` +
    `Year: ${doc.year || "Unknown"}\n` +
    `Summary: ${(summary || "").slice(0, 500)}\n` +
    `Genres: ${genresStr}\n` +
    `Additional tags: ${tagsStr}`
  );
}

// Build system prompt for a medium, injecting CalibrationAnchors as ground truth.
export async function buildSystemPrompt(env: Env, medium: string): Promise<string> {
  const base = medium === "game" ? GAME_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT;
  const { results } = await env.DB.prepare(
    "SELECT title, medium, dimension, confirmed_score FROM CalibrationAnchors"
  ).all<any>();
  const anchors = results ?? [];
  let calibrationBlock: string;
  if (!anchors.length) {
    calibrationBlock = DEFAULT_ANCHORS;
  } else {
    const grouped: Record<string, Record<string, number>> = {};
    for (const a of anchors) {
      const key = `${a.title} (${a.medium})`;
      (grouped[key] ??= {})[a.dimension] = a.confirmed_score;
    }
    const lines = ["Calibration examples (user-confirmed scores — treat these as ground truth):"];
    for (const [item, dims] of Object.entries(grouped)) {
      const scores = Object.entries(dims)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      lines.push(`- ${item}: ${scores}`);
    }
    calibrationBlock = lines.join("\n");
  }
  return base.replace("{calibration_block}", calibrationBlock);
}

export async function tagWithLlm(env: Env, doc: Doc, systemPrompt: string): Promise<any> {
  const raw = await anthropicMessages(env, {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildUserMessage(doc) }],
  });
  return parseLlmJson(raw);
}
