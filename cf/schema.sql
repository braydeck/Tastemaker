-- Tastemaker D1 schema. Mongo collections map 1:1 to tables; nested objects /
-- arrays are stored as JSON text columns. Mongo ObjectId -> TEXT primary keys.

CREATE TABLE IF NOT EXISTS MediaLogs (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  creator           TEXT,
  medium            TEXT NOT NULL,
  year              INTEGER,
  original_rating   REAL,
  tier              INTEGER,
  rank_in_tier      REAL,
  date_logged       TEXT,
  metadata_enriched INTEGER DEFAULT 0,
  metadata          TEXT,            -- JSON
  poster_url        TEXT,
  enrichment_error  TEXT,
  psychological_tags TEXT,           -- JSON object {dimension: score}
  cluster_id        INTEGER,
  -- extra fields used by library/add + promote flows
  reason            TEXT,
  source            TEXT,
  rating            REAL,
  added_at          TEXT,
  logged_at         TEXT,
  watch_providers   TEXT             -- JSON (only set by some import paths)
);

CREATE TABLE IF NOT EXISTS Watchlist (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  creator           TEXT,
  medium            TEXT NOT NULL,
  year              INTEGER,
  source            TEXT,
  reason            TEXT,
  added_at          TEXT,
  metadata          TEXT,            -- JSON
  poster_url        TEXT,
  psychological_tags TEXT,           -- JSON
  watch_providers   TEXT,            -- JSON array
  rating_score      REAL,
  rec_source        TEXT
);

CREATE TABLE IF NOT EXISTS CalibrationAnchors (
  id              TEXT PRIMARY KEY,
  media_id        TEXT NOT NULL,
  title           TEXT,
  medium          TEXT,
  dimension       TEXT NOT NULL,
  confirmed_score REAL,
  llm_score       REAL,
  timestamp       TEXT,
  UNIQUE (media_id, dimension)
);

CREATE TABLE IF NOT EXISTS ClusterDefs (
  id           TEXT PRIMARY KEY,
  cluster_id   INTEGER UNIQUE NOT NULL,
  name         TEXT,
  description  TEXT,
  centroid     TEXT,                 -- JSON {dimension: score}
  size         INTEGER,
  exemplar_ids TEXT                  -- JSON array of MediaLogs ids
);

CREATE TABLE IF NOT EXISTS TasteClusters (
  id           TEXT PRIMARY KEY,
  media_id     TEXT NOT NULL,
  title        TEXT,
  dimension    TEXT,
  utility_type TEXT,                 -- 'most' | 'least'
  session_id   TEXT,
  timestamp    TEXT
);

CREATE TABLE IF NOT EXISTS EnrichmentQueue (
  id           TEXT PRIMARY KEY,
  session_id   TEXT UNIQUE,
  new_media_id TEXT NOT NULL,
  new_title    TEXT,
  medium       TEXT,
  tier         INTEGER,
  low          INTEGER,
  high         INTEGER,
  ranked_ids   TEXT,                 -- JSON array
  created_at   TEXT,
  expires_at   INTEGER               -- epoch seconds; emulates Mongo TTL (3600s)
);

CREATE TABLE IF NOT EXISTS DiscoverBlacklist (
  id        TEXT PRIMARY KEY,
  title     TEXT NOT NULL,
  medium    TEXT,
  added_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_medialogs_medium     ON MediaLogs(medium);
CREATE INDEX IF NOT EXISTS idx_medialogs_tier       ON MediaLogs(tier);
CREATE INDEX IF NOT EXISTS idx_medialogs_cluster    ON MediaLogs(cluster_id);
CREATE INDEX IF NOT EXISTS idx_watchlist_medium     ON Watchlist(medium);
CREATE INDEX IF NOT EXISTS idx_calib_media          ON CalibrationAnchors(media_id);
CREATE INDEX IF NOT EXISTS idx_tasteclusters_sess   ON TasteClusters(session_id);
CREATE INDEX IF NOT EXISTS idx_enrqueue_session     ON EnrichmentQueue(session_id);
