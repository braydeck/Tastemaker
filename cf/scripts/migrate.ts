/**
 * One-time MongoDB -> D1 migration.
 *
 * Reads every collection from the existing Atlas database and emits a single
 * migration.sql file of INSERT statements that preserve original _id strings
 * (so media_id / exemplar_ids cross-references stay intact).
 *
 * Usage (run from cf/):
 *   MONGODB_URI="mongodb+srv://..." npx tsx scripts/migrate.ts
 *
 * Then load it into D1:
 *   wrangler d1 execute tastemaker --remote --file=migration.sql
 *   # (use --local to populate the local dev database instead)
 */
import { MongoClient, ObjectId } from "mongodb";
import { writeFileSync } from "node:fs";

const URI = process.env.MONGODB_URI;
if (!URI) {
  console.error("Set MONGODB_URI in the environment.");
  process.exit(1);
}

const JSON_FIELDS: Record<string, string[]> = {
  MediaLogs: ["metadata", "psychological_tags", "watch_providers"],
  Watchlist: ["metadata", "psychological_tags", "watch_providers"],
  ClusterDefs: ["centroid", "exemplar_ids"],
};
const BOOL_FIELDS: Record<string, string[]> = { MediaLogs: ["metadata_enriched"] };
const DATE_FIELDS = new Set(["date_logged", "added_at", "logged_at", "timestamp", "created_at"]);

// Column order per table (matches schema.sql).
const TABLES: Record<string, string[]> = {
  MediaLogs: [
    "id", "title", "creator", "medium", "year", "original_rating", "tier", "rank_in_tier",
    "date_logged", "metadata_enriched", "metadata", "poster_url", "enrichment_error",
    "psychological_tags", "cluster_id", "reason", "source", "rating", "added_at", "logged_at",
    "watch_providers",
  ],
  Watchlist: [
    "id", "title", "creator", "medium", "year", "source", "reason", "added_at", "metadata",
    "poster_url", "psychological_tags", "watch_providers", "rating_score", "rec_source",
  ],
  CalibrationAnchors: ["id", "media_id", "title", "medium", "dimension", "confirmed_score", "llm_score", "timestamp"],
  ClusterDefs: ["id", "cluster_id", "name", "description", "centroid", "size", "exemplar_ids"],
  TasteClusters: ["id", "media_id", "title", "dimension", "utility_type", "session_id", "timestamp"],
  DiscoverBlacklist: ["id", "title", "medium", "added_at"],
};

function sqlStr(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

function sqlValue(table: string, col: string, raw: any): string {
  if (raw === undefined || raw === null) return "NULL";
  if (JSON_FIELDS[table]?.includes(col)) return sqlStr(JSON.stringify(raw));
  if (BOOL_FIELDS[table]?.includes(col)) return raw ? "1" : "0";
  if (raw instanceof ObjectId) return sqlStr(raw.toString());
  if (raw instanceof Date) return sqlStr(raw.toISOString());
  if (DATE_FIELDS.has(col) && typeof raw === "object" && typeof raw.toISOString === "function")
    return sqlStr(raw.toISOString());
  if (typeof raw === "boolean") return raw ? "1" : "0";
  if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : "NULL";
  if (typeof raw === "object") return sqlStr(JSON.stringify(raw));
  return sqlStr(String(raw));
}

function rowFor(table: string, doc: any): string {
  const cols = TABLES[table];
  const values = cols.map((col) => {
    if (col === "id") return sqlValue(table, col, doc._id);
    return sqlValue(table, col, doc[col]);
  });
  return `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${values.join(", ")});`;
}

async function main() {
  const client = new MongoClient(URI!);
  await client.connect();
  const db = client.db("Tastemaker");

  // No BEGIN/COMMIT wrapper: `wrangler d1 execute` manages its own transaction
  // and rejects explicit BEGIN TRANSACTION statements.
  const lines: string[] = [];
  const counts: Record<string, number> = {};

  for (const table of Object.keys(TABLES)) {
    const docs = await db.collection(table).find({}).toArray();
    counts[table] = docs.length;
    for (const doc of docs) lines.push(rowFor(table, doc));
  }

  writeFileSync("migration.sql", lines.join("\n") + "\n");
  await client.close();

  console.log("Wrote migration.sql");
  for (const [t, n] of Object.entries(counts)) console.log(`  ${t}: ${n} rows`);
  console.log("\nNext: wrangler d1 execute tastemaker --remote --file=migration.sql");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
