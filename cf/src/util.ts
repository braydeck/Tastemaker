import type { Doc } from "./db";

// Resolve the display poster URL the same way main.py's get_poster_url does.
export function getPosterUrl(item: Doc, imageBase: string): string | null {
  if (item.poster_url) return item.poster_url;
  const metadata = item.metadata ?? {};
  const medium = item.medium ?? "";
  if (medium === "movie" || medium === "tv") {
    const p = metadata.poster_path;
    return p ? `${imageBase}${p}` : null;
  }
  if (medium === "book") {
    return metadata.imageLinks?.thumbnail ?? null;
  }
  return null;
}

// Mirror of serialize(): ensure _id is a string and poster_url is resolved.
export function serialize(item: Doc, imageBase: string): Doc {
  if (!item) return item;
  item._id = String(item._id ?? item.id);
  item.poster_url = getPosterUrl(item, imageBase);
  return item;
}

export function fmt1(n: number | null | undefined): string {
  return n == null ? "" : Number(n).toFixed(1);
}
export function fmt2(n: number | null | undefined): string {
  return n == null ? "" : Number(n).toFixed(2);
}

// Lowercase, strip leading article and punctuation (main.py _normalize_title).
export function normalizeTitle(title: string): string {
  let t = title.toLowerCase().trim();
  for (const article of ["the ", "a ", "an "]) {
    if (t.startsWith(article)) {
      t = t.slice(article.length);
      break;
    }
  }
  return t.replace(/[^\w\s]/g, "").trim();
}

// Year from a TMDB date string like "2024-05-01".
export function yearFromDate(date: string | undefined | null): number | null {
  if (date && /^\d{4}/.test(date)) return parseInt(date.slice(0, 4), 10);
  return null;
}

// Year from an IGDB unix timestamp (seconds).
export function yearFromUnix(ts: number | undefined | null): number | null {
  if (!ts) return null;
  return new Date(ts * 1000).getUTCFullYear();
}

// Extract creator (director / created_by / dev) from TMDB or IGDB metadata.
export function extractCreator(metadata: any, medium: string): string {
  if (medium === "movie") {
    const crew = metadata.credits?.crew ?? [];
    const directors = crew.filter((c: any) => c.job === "Director").map((c: any) => c.name);
    return directors[0] ?? "";
  }
  if (medium === "tv") {
    const cb = metadata.created_by ?? [];
    if (cb.length) return cb[0].name;
    const crew = metadata.credits?.crew ?? [];
    const eps = crew.filter((c: any) => c.job === "Executive Producer").map((c: any) => c.name);
    return eps[0] ?? "";
  }
  if (medium === "game") {
    const devs = (metadata.involved_companies ?? [])
      .filter((c: any) => c.developer && c.company && typeof c.company === "object")
      .map((c: any) => c.company.name);
    return devs[0] ?? "";
  }
  return "";
}
