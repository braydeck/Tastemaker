"""
Phase 2: Metadata + LLM enrichment pipeline.
Run after ingestion: python enrichment.py

For a full first run:
    python enrichment.py

To re-tag all already-enriched records with a new dimension set
(skips external API re-fetch — uses stored metadata):
    python enrichment.py --retag

Execution order per record:
  1. Fetch external metadata if not already stored (TMDB / Google Books / IGDB)
  2. Run LLM psychological tagging (claude-sonnet-4-20250514)
  3. Update MediaLogs document in MongoDB
"""

import json
import os
import sys
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import anthropic
import requests
from dotenv import load_dotenv

from db import get_db

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

TMDB_BASE = "https://api.themoviedb.org/3"
IGDB_API_URL = "https://api.igdb.com/v4/games"
IGDB_TOKEN_URL = "https://id.twitch.tv/oauth2/token"
IGDB_TOKEN_FILE = Path(__file__).parent / ".igdb_token"

MAX_RETRIES = 5
BACKOFF_BASE = 1   # seconds
BACKOFF_MAX = 32   # seconds

# Deprecated dimensions removed in the v2 dimension redesign.
# Used to clean up CalibrationAnchors on --retag.
DEPRECATED_DIMENSIONS = ["ugt_social", "world_to_character_ratio"]

# ---------------------------------------------------------------------------
# Prompt constants (module-level — edit here to tune)
# ---------------------------------------------------------------------------

BASE_SYSTEM_PROMPT = """You are a media analysis engine. Your task is to score a given work across
a set of psychological and structural dimensions. You must return ONLY a
valid JSON object — no preamble, no explanation, no markdown.

Score each dimension as a float from 1.0 to 5.0.

Dimension definitions:

ugt_cognitive: Degree to which the work rewards intellectual engagement,
system-thinking, and information processing.
  1.0 = passive, undemanding (comfort TV)
  5.0 = maximally demanding

ugt_affective: Degree to which the work prioritizes emotional experience,
tension, or mood regulation.
  1.0 = emotionally flat
  5.0 = high emotional intensity

narrative_complexity: Structural complexity of plotting, timelines,
unreliable narration, and thematic layering.
  1.0 = linear and simple
  5.0 = maximally complex

tonal_register: Affective temperature of the work.
  1.0 = warm / optimistic / comedic
  5.0 = cold / bleak / nihilistic

pacing_density: Information or plot density per unit time or page.
  1.0 = sparse, meditative
  5.0 = dense, relentless

world_building_depth: Richness and depth of the fictional world.
  1.0 = no world-building; real world or entirely contained setting
  5.0 = richly developed fictional world with deep lore and internal logic

character_interiority: Depth of psychological portrayal and inner life.
  1.0 = characters are functional; minimal psychology or inner life
  5.0 = deep psychological interiority; consciousness and subjectivity are primary

moral_architecture: Structure of the ethical framework.
  1.0 = clear moral universe, unambiguous good vs. evil
  3.0 = morally complex but the work adjudicates
  5.0 = genuinely relativist or nihilist, no authorial adjudication

diegetic_trust: Degree to which the work withholds explanation and
trusts the audience to infer.
  1.0 = over-explains everything
  5.0 = maximally withholding

scope: Scale of the narrative world and stakes.
  1.0 = intimate, small cast, contained stakes
  5.0 = epic, civilizational stakes

humor: Degree to which comedy is a primary register of the work.
  1.0 = entirely serious; no comedic register
  3.0 = mixed; comedy and drama balanced
  5.0 = predominantly comedic; humor is the primary mode

{calibration_block}

Return format (exactly this structure, no other text):
{{
  "ugt_cognitive": float,
  "ugt_affective": float,
  "narrative_complexity": float,
  "tonal_register": float,
  "pacing_density": float,
  "world_building_depth": float,
  "character_interiority": float,
  "moral_architecture": float,
  "diegetic_trust": float,
  "scope": float,
  "humor": float
}}"""

# Game-specific prompt: same as BASE but adds sdt_autonomy and sdt_competence.
GAME_SYSTEM_PROMPT = """You are a media analysis engine. Your task is to score a given work across
a set of psychological and structural dimensions. You must return ONLY a
valid JSON object — no preamble, no explanation, no markdown.

Score each dimension as a float from 1.0 to 5.0.

Dimension definitions:

ugt_cognitive: Degree to which the work rewards intellectual engagement,
system-thinking, and information processing.
  1.0 = passive, undemanding
  5.0 = maximally demanding

ugt_affective: Degree to which the work prioritizes emotional experience,
tension, or mood regulation.
  1.0 = emotionally flat
  5.0 = high emotional intensity

narrative_complexity: Structural complexity of plotting, timelines,
unreliable narration, and thematic layering.
  1.0 = linear and simple
  5.0 = maximally complex

tonal_register: Affective temperature of the work.
  1.0 = warm / optimistic / light
  5.0 = cold / bleak / nihilistic

pacing_density: Information or mechanical density per unit play time.
  1.0 = sparse, relaxed
  5.0 = dense, relentless

world_building_depth: Richness and depth of the fictional world.
  1.0 = minimal setting
  5.0 = richly developed world with deep lore and internal logic

character_interiority: Depth of psychological portrayal and inner life.
  1.0 = characters are functional; minimal inner life
  5.0 = deep psychological interiority

moral_architecture: Structure of the ethical framework.
  1.0 = clear moral universe, unambiguous good vs. evil
  3.0 = morally complex but the work adjudicates
  5.0 = genuinely relativist or nihilist

diegetic_trust: Degree to which the work withholds explanation and
trusts the player to infer.
  1.0 = over-explains everything
  5.0 = maximally withholding

scope: Scale of the narrative world and stakes.
  1.0 = intimate, contained stakes
  5.0 = epic, civilizational stakes

humor: Degree to which comedy is a primary register of the work.
  1.0 = entirely serious
  3.0 = mixed tone
  5.0 = predominantly comedic

sdt_autonomy: Degree to which the game grants meaningful player agency
and self-determination through branching choices.
  1.0 = fully linear, no meaningful choice
  5.0 = deep branching agency; choices substantially shape outcomes

sdt_competence: Degree to which the game rewards mastery of its
systems, mechanics, and strategic depth.
  1.0 = no systems to master; purely narrative
  5.0 = deeply systemic; high mechanical ceiling

{calibration_block}

Return format (exactly this structure, no other text):
{{
  "ugt_cognitive": float,
  "ugt_affective": float,
  "narrative_complexity": float,
  "tonal_register": float,
  "pacing_density": float,
  "world_building_depth": float,
  "character_interiority": float,
  "moral_architecture": float,
  "diegetic_trust": float,
  "scope": float,
  "humor": float,
  "sdt_autonomy": float,
  "sdt_competence": float
}}"""

DEFAULT_ANCHORS = """Calibration examples (user-confirmed scores — treat these as ground truth):
- Andor (tv): ugt_cognitive=4.2, narrative_complexity=4.5, tonal_register=4.2,
  pacing_serialization=5.0, diegetic_trust=4.0, scope=4.5, moral_architecture=4.0,
  world_building_depth=3.5, character_interiority=3.8, humor=1.2
- Slow Horses (tv): ugt_cognitive=4.1, tonal_register=4.2, pacing_density=2.8,
  character_interiority=4.2, world_building_depth=1.5, scope=1.8,
  narrative_complexity=4.2, humor=1.5
- Piranesi (book): ugt_cognitive=4.6, narrative_complexity=4.8,
  diegetic_trust=4.9, character_interiority=3.5, world_building_depth=3.8,
  scope=2.0, humor=1.8
- Baldur's Gate 3 (game): sdt_autonomy=5.0, sdt_competence=4.8,
  ugt_cognitive=4.0, scope=4.5, world_building_depth=4.8, character_interiority=3.5"""

# ---------------------------------------------------------------------------
# HTTP helpers with exponential backoff
# ---------------------------------------------------------------------------

def _backoff_wait(attempt: int) -> None:
    time.sleep(min(BACKOFF_BASE * (2 ** attempt), BACKOFF_MAX))


def get_with_backoff(url: str, **kwargs) -> requests.Response:
    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.get(url, timeout=10, **kwargs)
            if resp.status_code in (429, 500, 502, 503, 504):
                if attempt == MAX_RETRIES - 1:
                    resp.raise_for_status()
                _backoff_wait(attempt)
                continue
            resp.raise_for_status()
            return resp
        except requests.ConnectionError:
            if attempt == MAX_RETRIES - 1:
                raise
            _backoff_wait(attempt)
    raise RuntimeError("get_with_backoff: max retries exceeded")


def post_with_backoff(url: str, **kwargs) -> requests.Response:
    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.post(url, timeout=10, **kwargs)
            if resp.status_code in (429, 500, 502, 503, 504):
                if attempt == MAX_RETRIES - 1:
                    resp.raise_for_status()
                _backoff_wait(attempt)
                continue
            resp.raise_for_status()
            return resp
        except requests.ConnectionError:
            if attempt == MAX_RETRIES - 1:
                raise
            _backoff_wait(attempt)
    raise RuntimeError("post_with_backoff: max retries exceeded")


# ---------------------------------------------------------------------------
# IGDB token management (cached in .igdb_token)
# ---------------------------------------------------------------------------

def _load_cached_igdb_token() -> str | None:
    if not IGDB_TOKEN_FILE.exists():
        return None
    try:
        data = json.loads(IGDB_TOKEN_FILE.read_text())
        if data.get("expires_at", 0) > time.time() + 60:
            return data["access_token"]
    except (json.JSONDecodeError, KeyError):
        pass
    return None


def _fetch_igdb_token() -> str:
    resp = post_with_backoff(
        IGDB_TOKEN_URL,
        params={
            "client_id": os.environ["IGDB_CLIENT_ID"],
            "client_secret": os.environ["IGDB_CLIENT_SECRET"],
            "grant_type": "client_credentials",
        },
    )
    data = resp.json()
    IGDB_TOKEN_FILE.write_text(json.dumps({
        "access_token": data["access_token"],
        "expires_at": time.time() + data["expires_in"],
    }))
    return data["access_token"]


def get_igdb_token() -> str:
    return _load_cached_igdb_token() or _fetch_igdb_token()


def igdb_request(body: str, token: str) -> tuple[requests.Response, str]:
    """POST to IGDB with 401 token refresh + backoff. Returns (response, active_token)."""
    for attempt in range(MAX_RETRIES):
        resp = requests.post(
            IGDB_API_URL,
            headers={
                "Client-ID": os.environ["IGDB_CLIENT_ID"],
                "Authorization": f"Bearer {token}",
            },
            data=body,
            timeout=10,
        )
        if resp.status_code == 401:
            token = _fetch_igdb_token()
            continue
        if resp.status_code in (429, 500, 502, 503, 504):
            if attempt == MAX_RETRIES - 1:
                resp.raise_for_status()
            _backoff_wait(attempt)
            continue
        resp.raise_for_status()
        return resp, token
    raise RuntimeError("igdb_request: max retries exceeded")


# ---------------------------------------------------------------------------
# External metadata fetchers
# ---------------------------------------------------------------------------

def fetch_tmdb_genre_map() -> dict[int, str]:
    """Fetch movie + TV genre ID → name from TMDB at startup."""
    genre_map: dict[int, str] = {}
    for media_type in ("movie", "tv"):
        try:
            resp = get_with_backoff(
                f"{TMDB_BASE}/genre/{media_type}/list",
                params={"api_key": os.environ["TMDB_API_KEY"]},
            )
            for g in resp.json().get("genres", []):
                genre_map[g["id"]] = g["name"]
        except Exception:
            pass
    return genre_map


def fetch_tmdb(title: str, medium: str, genre_map: dict) -> dict | None:
    endpoint = "movie" if medium == "movie" else "tv"
    resp = get_with_backoff(
        f"{TMDB_BASE}/search/{endpoint}",
        params={"query": title, "api_key": os.environ["TMDB_API_KEY"]},
    )
    results = resp.json().get("results", [])
    if not results:
        return None
    result = dict(results[0])
    result["genres"] = [genre_map.get(gid, str(gid)) for gid in result.get("genre_ids", [])]
    return result


def fetch_igdb(title: str, token: str) -> tuple[dict | None, str]:
    body = (
        f'search "{title}"; '
        "fields name,summary,genres.name,themes.name,first_release_date,cover.url,"
        "rating,rating_count,involved_companies.company.name,involved_companies.developer,"
        "parent_game,version_parent; "
        "limit 10;"
    )
    resp, token = igdb_request(body, token)
    raw = resp.json()
    result_ids = {r["id"] for r in raw}
    results = [
        r for r in raw
        if not r.get("version_parent")
        and r.get("parent_game") not in result_ids
    ]
    if not results:
        return None, token
    result = dict(results[0])
    cover = result.get("cover") or {}
    if cover.get("url"):
        result["cover_url"] = "https:" + cover["url"].replace("t_thumb", "t_cover_big")
    return result, token


def fetch_google_books(title: str, creator: str) -> dict | None:
    query = f"intitle:{title}"
    if creator:
        query += f"+inauthor:{creator}"
    resp = get_with_backoff(
        "https://www.googleapis.com/books/v1/volumes",
        params={"q": query, "key": os.environ["GOOGLE_BOOKS_API_KEY"], "maxResults": 1},
    )
    items = resp.json().get("items", [])
    if not items:
        return None
    return items[0].get("volumeInfo", {})


# ---------------------------------------------------------------------------
# Normalization helpers
# ---------------------------------------------------------------------------

def fetch_tmdb_director(tmdb_id: int) -> str | None:
    """Fetch director name from TMDB movie credits endpoint."""
    resp = get_with_backoff(
        f"{TMDB_BASE}/movie/{tmdb_id}/credits",
        params={"api_key": os.environ["TMDB_API_KEY"]},
    )
    crew = resp.json().get("crew", [])
    directors = [m["name"] for m in crew if m.get("job") == "Director"]
    return directors[0] if directors else None


def normalize_from_metadata(doc: dict) -> dict:
    """Extract canonical title/year/creator from stored metadata (no extra API calls).
    Returns a $set dict of only the fields that differ from what's stored."""
    metadata = doc.get("metadata") or {}
    medium = doc.get("medium", "")
    updates: dict = {}

    if medium == "movie":
        title = metadata.get("title") or ""
        release_date = metadata.get("release_date") or ""
        year = int(release_date[:4]) if len(release_date) >= 4 else None
        # creator for movies requires a credits API call; handled in the normalize loop
    elif medium == "tv":
        title = metadata.get("name") or ""
        air_date = metadata.get("first_air_date") or ""
        year = int(air_date[:4]) if len(air_date) >= 4 else None
        created_by = metadata.get("created_by") or []
        creator = created_by[0]["name"] if created_by else None
        if creator and creator != doc.get("creator"):
            updates["creator"] = creator
    elif medium == "book":
        title = metadata.get("title") or ""
        pub_date = metadata.get("publishedDate") or ""
        year = int(pub_date[:4]) if len(pub_date) >= 4 else None
        authors = metadata.get("authors") or []
        creator = ", ".join(authors) if authors else None
        if creator and creator != doc.get("creator"):
            updates["creator"] = creator
    elif medium == "game":
        title = metadata.get("name") or ""
        frd = metadata.get("first_release_date")
        year = datetime.utcfromtimestamp(frd).year if frd else None
    else:
        return {}

    if title and title != doc.get("title"):
        updates["title"] = title
    if year is not None and year != doc.get("year"):
        updates["year"] = year

    return updates


# ---------------------------------------------------------------------------
# System prompt builder (dynamic anchor injection)
# ---------------------------------------------------------------------------

def build_system_prompt(db, medium: str) -> str:
    """Build system prompt for a given medium, injecting calibration anchors."""
    base = GAME_SYSTEM_PROMPT if medium == "game" else BASE_SYSTEM_PROMPT

    anchors = list(db["CalibrationAnchors"].find(
        {},
        {"title": 1, "medium": 1, "dimension": 1, "confirmed_score": 1, "_id": 0},
    ))
    if not anchors:
        calibration_block = DEFAULT_ANCHORS
    else:
        grouped: dict = defaultdict(dict)
        for a in anchors:
            key = f"{a['title']} ({a['medium']})"
            grouped[key][a["dimension"]] = a["confirmed_score"]
        lines = ["Calibration examples (user-confirmed scores — treat these as ground truth):"]
        for item, dims in grouped.items():
            scores = ", ".join(f"{k}={v}" for k, v in dims.items())
            lines.append(f"- {item}: {scores}")
        calibration_block = "\n".join(lines)

    return base.format(calibration_block=calibration_block)


# ---------------------------------------------------------------------------
# LLM user message construction
# ---------------------------------------------------------------------------

def _extract_genres_str(metadata: dict, medium: str) -> str:
    genres_raw = metadata.get("genres", [])
    if not genres_raw:
        return ""
    if isinstance(genres_raw[0], dict):
        return ", ".join(g.get("name", "") for g in genres_raw)
    return ", ".join(str(g) for g in genres_raw)


def build_user_message(doc: dict) -> str:
    medium = doc.get("medium", "")
    metadata = doc.get("metadata", {})

    if medium in ("movie", "tv"):
        summary = metadata.get("overview", "")
        genres_str = _extract_genres_str(metadata, medium)
        tags_str = ""
    elif medium == "game":
        summary = metadata.get("summary", "")
        genres_str = _extract_genres_str(metadata, medium)
        themes = metadata.get("themes") or []
        tags_str = ", ".join(
            t.get("name", "") if isinstance(t, dict) else str(t) for t in themes
        )
    else:  # book
        summary = metadata.get("description", "")
        genres_str = ", ".join(metadata.get("categories", []))
        tags_str = metadata.get("maturityRating", "")

    return (
        "Score the following work:\n\n"
        f"Title: {doc.get('title', '')}\n"
        f"Medium: {medium}\n"
        f"Creator: {doc.get('creator', '') or 'Unknown'}\n"
        f"Year: {doc.get('year') or 'Unknown'}\n"
        f"Summary: {(summary or '')[:500]}\n"
        f"Genres: {genres_str}\n"
        f"Additional tags: {tags_str}"
    )


# ---------------------------------------------------------------------------
# LLM tagger (with rate-limit backoff)
# ---------------------------------------------------------------------------

def tag_with_llm(client: anthropic.Anthropic, doc: dict, system_prompt: str) -> dict:
    for attempt in range(MAX_RETRIES):
        try:
            msg = client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=512,
                system=[{
                    "type": "text",
                    "text": system_prompt,
                    "cache_control": {"type": "ephemeral"},
                }],
                messages=[{"role": "user", "content": build_user_message(doc)}],
            )
            raw = msg.content[0].text.strip()
            if raw.startswith("```"):
                raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
            return json.loads(raw)
        except anthropic.RateLimitError:
            if attempt == MAX_RETRIES - 1:
                raise
            _backoff_wait(attempt)
        except json.JSONDecodeError:
            raise  # Caller sets enrichment_error; don't retry malformed JSON


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    retag = "--retag" in sys.argv
    normalize = "--normalize" in sys.argv
    db = get_db()
    ai_client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    if normalize:
        print("--normalize mode: canonicalizing title/year/creator from stored metadata...")
        docs_with_metadata = list(db["MediaLogs"].find({"metadata": {"$ne": {}}}))
        print(f"  Found {len(docs_with_metadata)} docs with stored metadata.\n")

        changed = 0
        for doc in docs_with_metadata:
            updates = normalize_from_metadata(doc)

            # Movie director: requires a TMDB credits call (skipped if already set)
            if doc.get("medium") == "movie" and not doc.get("creator"):
                tmdb_id = (doc.get("metadata") or {}).get("id")
                if tmdb_id:
                    try:
                        director = fetch_tmdb_director(tmdb_id)
                        if director:
                            updates["creator"] = director
                    except Exception:
                        pass

            if updates:
                old_title = doc["title"]
                db["MediaLogs"].update_one({"_id": doc["_id"]}, {"$set": updates})
                changed += 1
                if "title" in updates:
                    print(f"  {old_title!r} → {updates['title']!r}")

        print(f"\n  Updated {changed} docs.")

        # Reset no_api_match docs so the main loop retries them
        reset_result = db["MediaLogs"].update_many(
            {"enrichment_error": "no_api_match"},
            {"$set": {"metadata_enriched": False, "enrichment_error": None}},
        )
        if reset_result.modified_count:
            print(f"  Reset {reset_result.modified_count} no_api_match docs for retry.")
        print()

    if retag:
        print("--retag mode: resetting enrichment status for docs with stored metadata...")
        result = db["MediaLogs"].update_many(
            {"metadata": {"$ne": {}}},
            {"$set": {"metadata_enriched": False, "enrichment_error": None}},
        )
        print(f"  Reset {result.modified_count} docs.")

        removed = db["CalibrationAnchors"].delete_many(
            {"dimension": {"$in": DEPRECATED_DIMENSIONS}}
        )
        if removed.deleted_count:
            print(f"  Removed {removed.deleted_count} deprecated CalibrationAnchor entries "
                  f"({', '.join(DEPRECATED_DIMENSIONS)}).")
        print()

    # Build prompts once per medium type (anchors are the same for all records)
    print("Building system prompts from CalibrationAnchors...")
    base_prompt = build_system_prompt(db, "other")
    game_prompt = build_system_prompt(db, "game")

    print("Fetching TMDB genre map...")
    genre_map = fetch_tmdb_genre_map()

    print("Loading IGDB token...")
    igdb_token = get_igdb_token()

    records = list(db["MediaLogs"].find({"metadata_enriched": False}))
    total = len(records)

    if total == 0:
        print("No un-enriched records found. All done.")
        return

    print(f"Found {total} records to process. Starting...\n")

    enriched = errored = 0

    for i, doc in enumerate(records, 1):
        title = doc["title"]
        medium = doc["medium"]
        system_prompt = game_prompt if medium == "game" else base_prompt
        print(f"[{i}/{total}] Enriching: {title} ({medium})", end=" — ", flush=True)

        # Step 1: External metadata — skip if already stored
        metadata_stored = bool(doc.get("metadata"))
        if metadata_stored:
            metadata = doc["metadata"]
        else:
            try:
                if medium in ("movie", "tv"):
                    metadata = fetch_tmdb(title, medium, genre_map)
                elif medium == "game":
                    metadata, igdb_token = fetch_igdb(title, igdb_token)
                else:
                    metadata = fetch_google_books(title, doc.get("creator", ""))

                if metadata is None:
                    db["MediaLogs"].update_one(
                        {"_id": doc["_id"]},
                        {"$set": {"enrichment_error": "no_api_match"}},
                    )
                    print("no_api_match")
                    errored += 1
                    continue

                db["MediaLogs"].update_one(
                    {"_id": doc["_id"]},
                    {"$set": {"metadata": metadata}},
                )
            except Exception as exc:
                db["MediaLogs"].update_one(
                    {"_id": doc["_id"]},
                    {"$set": {"enrichment_error": f"api_error: {str(exc)[:120]}"}},
                )
                print("api_error")
                errored += 1
                continue

        # Step 2: LLM psychological tagging
        doc["metadata"] = metadata
        try:
            tags = tag_with_llm(ai_client, doc, system_prompt)
            db["MediaLogs"].update_one(
                {"_id": doc["_id"]},
                {"$set": {
                    "psychological_tags": tags,
                    "metadata_enriched": True,
                    "enrichment_error": None,
                }},
            )
            print("OK")
            enriched += 1
        except json.JSONDecodeError:
            db["MediaLogs"].update_one(
                {"_id": doc["_id"]},
                {"$set": {"enrichment_error": "llm_tagging_failed"}},
            )
            print("llm_tagging_failed")
            errored += 1
        except Exception as exc:
            db["MediaLogs"].update_one(
                {"_id": doc["_id"]},
                {"$set": {"enrichment_error": f"llm_error: {str(exc)[:120]}"}},
            )
            print("llm_error")
            errored += 1

    print("\n" + "=" * 50)
    print("Enrichment complete")
    print(f"  Enriched: {enriched}")
    print(f"  Errored:  {errored}")
    print("=" * 50)


if __name__ == "__main__":
    main()
