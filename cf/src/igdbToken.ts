// IGDB OAuth token, cached in KV (replaces the .igdb_token file). Twitch
// client-credentials flow; refreshed when <60s of life remains.

import type { Env } from "./db";
import { IGDB_TOKEN_URL } from "./constants";
import { postWithBackoff } from "./enrichment";

const KV_KEY = "igdb_token";

interface CachedToken {
  access_token: string;
  expires_at: number; // epoch seconds
}

async function loadCached(env: Env): Promise<string | null> {
  const raw = await env.IGDB_KV.get(KV_KEY);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as CachedToken;
    if (data.expires_at > Date.now() / 1000 + 60) return data.access_token;
  } catch {
    /* fall through to refresh */
  }
  return null;
}

export async function fetchIgdbToken(env: Env): Promise<string> {
  const params = new URLSearchParams({
    client_id: env.IGDB_CLIENT_ID,
    client_secret: env.IGDB_CLIENT_SECRET,
    grant_type: "client_credentials",
  });
  const resp = await postWithBackoff(`${IGDB_TOKEN_URL}?${params.toString()}`);
  const data = (await resp.json()) as { access_token: string; expires_in: number };
  await env.IGDB_KV.put(
    KV_KEY,
    JSON.stringify({
      access_token: data.access_token,
      expires_at: Date.now() / 1000 + data.expires_in,
    })
  );
  return data.access_token;
}

export async function getIgdbToken(env: Env): Promise<string> {
  return (await loadCached(env)) ?? (await fetchIgdbToken(env));
}
