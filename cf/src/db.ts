// D1 data layer. Mongo documents are modeled as plain objects with a string
// `_id` (matching the old serialize() shape) so route logic ports cleanly.
// JSON columns are (de)serialized here.

export interface Env {
  DB: D1Database;
  IGDB_KV: KVNamespace;
  TMDB_API_KEY: string;
  IGDB_CLIENT_ID: string;
  IGDB_CLIENT_SECRET: string;
  ANTHROPIC_API_KEY: string;
  TMDB_IMAGE_BASE: string;
}

export type Doc = Record<string, any>;

// JSON-encoded columns per table.
const JSON_FIELDS: Record<string, string[]> = {
  MediaLogs: ["metadata", "psychological_tags", "watch_providers"],
  Watchlist: ["metadata", "psychological_tags", "watch_providers"],
  ClusterDefs: ["centroid", "exemplar_ids"],
  EnrichmentQueue: ["ranked_ids"],
};

const BOOL_FIELDS: Record<string, string[]> = {
  MediaLogs: ["metadata_enriched"],
};

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

function jParse(s: any): any {
  if (s == null) return null;
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Convert a raw D1 row into a doc, parsing JSON columns and coercing booleans.
// The PK column `id` is exposed as `_id` to match the legacy serialize() shape.
function rowToDoc(table: string, row: Record<string, any> | null): Doc | null {
  if (!row) return null;
  const jsonFields = JSON_FIELDS[table] ?? [];
  const boolFields = BOOL_FIELDS[table] ?? [];
  const doc: Doc = {};
  for (const [k, v] of Object.entries(row)) {
    if (jsonFields.includes(k)) doc[k] = jParse(v);
    else if (boolFields.includes(k)) doc[k] = !!v;
    else doc[k] = v;
  }
  if ("id" in doc) doc._id = doc.id;
  return doc;
}

// Serialize a JS value for binding into a SQL statement.
function serialize(table: string, key: string, value: any): any {
  if (value === undefined) return null;
  const jsonFields = JSON_FIELDS[table] ?? [];
  if (jsonFields.includes(key)) {
    return value == null ? null : JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return value;
}

// ---------------------------------------------------------------------------
// Generic CRUD
// ---------------------------------------------------------------------------

export async function insert(env: Env, table: string, doc: Doc): Promise<string> {
  const data = { ...doc };
  if (!data.id) data.id = newId();
  delete data._id;
  const keys = Object.keys(data);
  const placeholders = keys.map(() => "?").join(", ");
  const values = keys.map((k) => serialize(table, k, data[k]));
  await env.DB.prepare(
    `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`
  )
    .bind(...values)
    .run();
  return data.id as string;
}

export async function updateById(
  env: Env,
  table: string,
  id: string,
  updates: Doc
): Promise<void> {
  const data = { ...updates };
  delete data._id;
  delete data.id;
  const keys = Object.keys(data);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => serialize(table, k, data[k]));
  await env.DB.prepare(`UPDATE ${table} SET ${setClause} WHERE id = ?`)
    .bind(...values, id)
    .run();
}

export async function deleteById(env: Env, table: string, id: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
}

export async function findById(env: Env, table: string, id: string): Promise<Doc | null> {
  const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`)
    .bind(id)
    .first<Record<string, any>>();
  return rowToDoc(table, row);
}

// Run an arbitrary SELECT and map rows for the given table.
export async function query(
  env: Env,
  table: string,
  sql: string,
  params: any[] = []
): Promise<Doc[]> {
  const stmt = params.length ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
  const { results } = await stmt.all<Record<string, any>>();
  return (results ?? []).map((r) => rowToDoc(table, r)!) as Doc[];
}

export async function queryOne(
  env: Env,
  table: string,
  sql: string,
  params: any[] = []
): Promise<Doc | null> {
  const stmt = params.length ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
  const row = await stmt.first<Record<string, any>>();
  return rowToDoc(table, row);
}

export async function count(env: Env, sql: string, params: any[] = []): Promise<number> {
  const stmt = params.length ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
  const row = await stmt.first<{ c: number }>();
  return row?.c ?? 0;
}
