import json
import os
import random
import re
import uuid
from collections import defaultdict
from datetime import datetime, timezone

import anthropic
from bson import ObjectId
from dotenv import load_dotenv
from fastapi import FastAPI, Form, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pymongo import ASCENDING, DESCENDING

from db import get_db
from enrichment import (
    IGDB_API_URL,
    TMDB_BASE,
    fetch_google_books,
    get_igdb_token,
    get_with_backoff,
    igdb_request,
)

load_dotenv()

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w300"
TMDB_KEY = os.environ.get("TMDB_API_KEY", "")
BOOKS_KEY = os.environ.get("GOOGLE_BOOKS_API_KEY", "")

# Universal dimensions (all media). Games additionally have sdt_autonomy + sdt_competence
# stored in psychological_tags but those are not in this list for the calibration/onboard UI.
DIMENSIONS = [
    "ugt_cognitive", "ugt_affective", "narrative_complexity",
    "tonal_register", "pacing_density",
    "world_building_depth", "character_interiority",
    "moral_architecture", "diegetic_trust", "scope", "humor",
]

DIMENSION_LABELS = {
    "ugt_cognitive": "Intellectual Depth",
    "ugt_affective": "Emotional Intensity",
    "narrative_complexity": "Narrative Complexity",
    "tonal_register": "Dark / Bleak Tone",
    "pacing_density": "Dense Pacing",
    "world_building_depth": "World-Building Depth",
    "character_interiority": "Character Interiority",
    "moral_architecture": "Moral Ambiguity",
    "diegetic_trust": "Show Don't Tell",
    "scope": "Epic Scale",
    "humor": "Humor",
    # Game-only (shown in calibrate if present in psychological_tags)
    "sdt_autonomy": "Agency & Choice",
    "sdt_competence": "Mastery & Systems",
}

DIMENSION_DEFINITIONS = {
    "ugt_cognitive": "Rewards intellectual engagement and system-thinking",
    "ugt_affective": "Prioritizes emotional experience and mood regulation",
    "narrative_complexity": "Structural complexity of plotting and thematic layering",
    "tonal_register": "Affective temperature: warm/optimistic ↔ cold/bleak",
    "pacing_density": "Information or plot density per unit time or page",
    "world_building_depth": "Richness of the fictional world's lore and internal logic",
    "character_interiority": "Depth of psychological portrayal and inner life",
    "moral_architecture": "Clear good/evil ↔ genuine moral relativism",
    "diegetic_trust": "Withholds explanation, trusts audience to infer",
    "scope": "Scale of narrative world and stakes",
    "humor": "Degree to which comedy is a primary register (1=serious, 5=comedic)",
    # Game-only
    "sdt_autonomy": "Grants meaningful player agency through branching choices",
    "sdt_competence": "Rewards mastery of systems and mechanical depth",
}

TIER_NAMES = {
    1: "Tier 1 — Essential",
    2: "Tier 2 — Great",
    3: "Tier 3 — Good",
    4: "Tier 4 — Fine",
    5: "Tier 5 — Didn't Work For Me",
    None: "Untiered",
}

TIER_BADGE_CLASSES = {
    1: "bg-yellow-500 text-black",
    2: "bg-slate-400 text-black",
    3: "bg-amber-600 text-white",
    4: "bg-neutral-500 text-white",
    5: "bg-neutral-800 text-neutral-400",
    None: "bg-neutral-700 text-neutral-500",
}

MEDIUM_DOT_CLASSES = {
    "movie": "bg-blue-500",
    "tv": "bg-purple-500",
    "book": "bg-emerald-500",
    "game": "bg-orange-500",
}

QUALITY_FLOORS = {
    "movie": {"score_field": "vote_average",  "count_field": "vote_count",   "min_score": 7.0, "min_count": 200},
    "tv":    {"score_field": "vote_average",  "count_field": "vote_count",   "min_score": 7.5, "min_count": 100},
    "book":  {"score_field": "averageRating", "count_field": "ratingsCount", "min_score": 3.6, "min_count": 50},
    "game":  {"score_field": "rating",        "count_field": "rating_count", "min_score": 75,  "min_count": 10},
}

# Expose constants to all templates
templates.env.globals.update({
    "TIER_NAMES": TIER_NAMES,
    "TIER_BADGE_CLASSES": TIER_BADGE_CLASSES,
    "MEDIUM_DOT_CLASSES": MEDIUM_DOT_CLASSES,
    "DIMENSION_LABELS": DIMENSION_LABELS,
    "DIMENSION_DEFINITIONS": DIMENSION_DEFINITIONS,
    "DIMENSIONS": DIMENSIONS,
})


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def startup() -> None:
    db = get_db()
    db["EnrichmentQueue"].create_index(
        [("created_at", ASCENDING)],
        expireAfterSeconds=3600,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def get_poster_url(item: dict) -> str | None:
    if item.get("poster_url"):
        return item["poster_url"]
    metadata = item.get("metadata") or {}
    medium = item.get("medium", "")
    if medium in ("movie", "tv"):
        p = metadata.get("poster_path")
        return f"{TMDB_IMAGE_BASE}{p}" if p else None
    if medium == "book":
        links = metadata.get("imageLinks") or {}
        url = links.get("thumbnail") or links.get("smallThumbnail")
        return url.replace("http://", "https://") if url else None
    return None


def fetch_tmdb_by_id(tmdb_id: int, medium: str) -> dict:
    """Fetch full TMDB metadata + US watch providers for a known TMDB ID."""
    endpoint = "movie" if medium == "movie" else "tv"
    resp = get_with_backoff(f"{TMDB_BASE}/{endpoint}/{tmdb_id}", params={"api_key": TMDB_KEY})
    data = dict(resp.json())
    try:
        wp_resp = get_with_backoff(
            f"{TMDB_BASE}/{endpoint}/{tmdb_id}/watch/providers",
            params={"api_key": TMDB_KEY},
        )
        us = wp_resp.json().get("results", {}).get("US", {})
        data["watch_providers"] = [
            {"name": p["provider_name"], "logo_path": p["logo_path"], "type": "stream"}
            for p in us.get("flatrate", [])
        ] + [
            {"name": p["provider_name"], "logo_path": p["logo_path"], "type": "buy"}
            for p in us.get("buy", [])
        ]
    except Exception:
        data["watch_providers"] = []
    return data


def enrich_rec(title: str, medium: str) -> tuple[dict, str | None, list]:
    """Fetch metadata, poster_url, watch_providers for a title via TMDB or Google Books."""
    metadata: dict = {}
    poster_url: str | None = None
    watch_providers: list = []
    try:
        if medium in ("movie", "tv"):
            endpoint = "movie" if medium == "movie" else "tv"
            resp = get_with_backoff(
                f"{TMDB_BASE}/search/{endpoint}",
                params={"query": title, "api_key": TMDB_KEY},
            )
            results = resp.json().get("results", [])
            if results:
                metadata = dict(results[0])
                if metadata.get("poster_path"):
                    poster_url = f"{TMDB_IMAGE_BASE}{metadata['poster_path']}"
                try:
                    wp_resp = get_with_backoff(
                        f"{TMDB_BASE}/{endpoint}/{metadata['id']}/watch/providers",
                        params={"api_key": TMDB_KEY},
                    )
                    us = wp_resp.json().get("results", {}).get("US", {})
                    watch_providers = [
                        {"name": p["provider_name"], "logo_path": p["logo_path"], "type": "stream"}
                        for p in us.get("flatrate", [])
                    ] + [
                        {"name": p["provider_name"], "logo_path": p["logo_path"], "type": "buy"}
                        for p in us.get("buy", [])
                    ]
                    metadata["watch_providers"] = watch_providers
                except Exception:
                    pass
        elif medium == "book":
            metadata = fetch_google_books(title, "") or {}
            if metadata:
                links = metadata.get("imageLinks") or {}
                url = links.get("thumbnail") or links.get("smallThumbnail")
                if url:
                    poster_url = url.replace("http://", "https://")
        elif medium == "game":
            token = get_igdb_token()
            body = (
                f'search "{title}"; '
                "fields name,summary,genres.name,themes.name,first_release_date,cover.url,"
                "rating,rating_count,involved_companies.company.name,involved_companies.developer; "
                "limit 1;"
            )
            resp, _ = igdb_request(body, token)
            results = resp.json()
            if results:
                metadata = dict(results[0])
                cover = metadata.get("cover") or {}
                if cover.get("url"):
                    poster_url = "https:" + cover["url"].replace("t_thumb", "t_cover_big")
    except Exception:
        pass
    return metadata, poster_url, watch_providers


def serialize(item: dict) -> dict:
    item["_id"] = str(item["_id"])
    item["poster_url"] = get_poster_url(item)
    return item


def group_by_tier(items: list[dict]) -> list[tuple]:
    groups: dict = defaultdict(list)
    for item in items:
        groups[item.get("tier")].append(item)
    return [
        (t, groups[t])
        for t in sorted(groups.keys(), key=lambda x: (x is None, x or 0))
    ]


KNOWN_DIMS = set(DIMENSIONS) | {"sdt_autonomy", "sdt_competence"}

def select_maxdiff_dims(tags: dict) -> list[tuple[str, str, float]]:
    """Return 4 (key, label, score) tuples from dims scoring >= 3.0 (present traits).
    Only considers current known dimensions; ignores deprecated keys in stored tags.
    Falls back to top 4 if fewer than 4 dims clear the threshold."""
    if not tags:
        return []
    filtered = {k: v for k, v in tags.items() if k in KNOWN_DIMS}
    sorted_dims = sorted(filtered.items(), key=lambda x: x[1], reverse=True)
    present = [(k, v) for k, v in sorted_dims if v >= 3.0]
    four = present[:4] if len(present) >= 4 else sorted_dims[:4]
    random.shuffle(four)
    return [(k, DIMENSION_LABELS.get(k, k), round(v, 2)) for k, v in four]


def compute_taste_vector(db) -> dict[str, float]:
    """Average psychological_tags across Tier 1 + Tier 2 items."""
    items = list(db["MediaLogs"].find(
        {"tier": {"$in": [1, 2]}, "psychological_tags": {"$ne": {}}},
        {"psychological_tags": 1},
    ))
    vectors = [i["psychological_tags"] for i in items]
    if not vectors:
        return {}
    dims = set().union(*[v.keys() for v in vectors])
    return {d: round(sum(v.get(d, 0) for v in vectors) / len(vectors), 2) for d in dims}


# ---------------------------------------------------------------------------
# Media search API (live search for watchlist/log forms)
# ---------------------------------------------------------------------------

@app.get("/api/search")
async def api_search(
    q: str = Query(default=""),
    medium: str = Query(default="movie"),
) -> JSONResponse:
    """Search TMDB or Google Books and return up to 6 candidates as JSON."""
    if len(q) < 2:
        return JSONResponse([])
    results = []
    try:
        if medium in ("movie", "tv"):
            endpoint = "movie" if medium == "movie" else "tv"
            resp = get_with_backoff(
                f"{TMDB_BASE}/search/{endpoint}",
                params={"query": q, "api_key": TMDB_KEY},
            )
            for r in resp.json().get("results", [])[:6]:
                date_field = "release_date" if medium == "movie" else "first_air_date"
                year_str = r.get(date_field, "")
                year = int(year_str[:4]) if year_str and year_str[:4].isdigit() else None
                title = r.get("title") if medium == "movie" else r.get("name", "")
                results.append({
                    "title": title,
                    "year": year,
                    "tmdb_id": r["id"],
                    "books_id": "",
                    "igdb_id": 0,
                    "creator": "",
                    "poster_url": f"{TMDB_IMAGE_BASE}{r['poster_path']}" if r.get("poster_path") else None,
                    "overview": (r.get("overview") or "")[:120],
                })
        elif medium == "book":
            resp = get_with_backoff(
                "https://www.googleapis.com/books/v1/volumes",
                params={"q": q, "key": BOOKS_KEY, "maxResults": 6},
            )
            for item in resp.json().get("items", []):
                info = item.get("volumeInfo", {})
                year_str = info.get("publishedDate", "")
                year = int(year_str[:4]) if year_str and year_str[:4].isdigit() else None
                links = info.get("imageLinks") or {}
                thumb = links.get("thumbnail") or links.get("smallThumbnail")
                results.append({
                    "title": info.get("title", ""),
                    "year": year,
                    "tmdb_id": 0,
                    "books_id": item["id"],
                    "igdb_id": 0,
                    "creator": ", ".join(info.get("authors", [])),
                    "poster_url": thumb.replace("http://", "https://") if thumb else None,
                    "overview": (info.get("description") or "")[:120],
                })
        elif medium == "game":
            token = get_igdb_token()
            body = (
                f'search "{q}"; '
                "fields name,summary,genres.name,first_release_date,cover.url,"
                "involved_companies.company.name,involved_companies.developer; "
                "limit 6;"
            )
            resp, _ = igdb_request(body, token)
            for r in resp.json():
                year = None
                if r.get("first_release_date"):
                    year = datetime.utcfromtimestamp(r["first_release_date"]).year
                cover = r.get("cover") or {}
                cover_url = None
                if cover.get("url"):
                    cover_url = "https:" + cover["url"].replace("t_thumb", "t_cover_big")
                devs = [
                    c["company"]["name"]
                    for c in (r.get("involved_companies") or [])
                    if c.get("developer") and isinstance(c.get("company"), dict)
                ]
                results.append({
                    "title": r.get("name", ""),
                    "year": year,
                    "tmdb_id": 0,
                    "books_id": "",
                    "igdb_id": r["id"],
                    "creator": devs[0] if devs else "",
                    "poster_url": cover_url,
                    "overview": (r.get("summary") or "")[:120],
                })
    except Exception:
        pass
    return JSONResponse(results)


# ---------------------------------------------------------------------------
# Library search (for Discover seed picker)
# ---------------------------------------------------------------------------

@app.get("/api/library-search")
async def library_search(q: str = Query(default="")) -> JSONResponse:
    if len(q) < 2:
        return JSONResponse([])
    db = get_db()
    docs = list(db["MediaLogs"].find(
        {"title": {"$regex": q, "$options": "i"}},
        {"title": 1, "medium": 1, "poster_url": 1, "metadata": 1},
    ).limit(8))
    return JSONResponse([{
        "id": str(d["_id"]),
        "title": d["title"],
        "medium": d.get("medium", ""),
        "poster_url": get_poster_url(d),
    } for d in docs])


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------

SORT_FIELDS = {"title", "medium", "creator", "year", "tier"}

@app.get("/", response_class=HTMLResponse)
async def dashboard(
    request: Request,
    medium: str = "",
    view: str = "grid",
    sort: str = "tier",
    dir: str = "asc",
    cluster_id: int = -1,
) -> HTMLResponse:
    db = get_db()
    query: dict = {}
    if medium:
        query["medium"] = medium
    if cluster_id >= 0:
        query["cluster_id"] = cluster_id

    sort_field = sort if sort in SORT_FIELDS else "tier"
    sort_dir = DESCENDING if dir == "desc" else ASCENDING
    if sort_field == "tier":
        sort_spec = [("tier", sort_dir), ("rank_in_tier", ASCENDING)]
    else:
        sort_spec = [(sort_field, sort_dir)]

    items = list(db["MediaLogs"].find(query).sort(sort_spec))
    items = [serialize(i) for i in items]
    tier_groups = group_by_tier(items)

    cluster_defs = [serialize(c) for c in db["ClusterDefs"].find({}, {"cluster_id": 1, "name": 1}).sort("cluster_id", 1)]

    ctx = {
        "request": request, "tier_groups": tier_groups, "medium": medium,
        "items": items, "view": view, "sort": sort_field, "dir": dir,
        "cluster_id": cluster_id, "cluster_defs": cluster_defs,
    }
    is_htmx = "HX-Request" in request.headers
    if is_htmx:
        partial = "partials/table.html" if view == "table" else "partials/grid.html"
        return templates.TemplateResponse(partial, ctx)
    return templates.TemplateResponse("dashboard.html", ctx)


# ---------------------------------------------------------------------------
# MaxDiff Onboarding
# ---------------------------------------------------------------------------

@app.get("/onboard", response_class=HTMLResponse)
async def onboard(request: Request) -> HTMLResponse:
    db = get_db()
    pool = list(db["MediaLogs"].find(
        {"tier": 1, "psychological_tags": {"$exists": True, "$ne": {}}}
    ))
    if not pool:
        return templates.TemplateResponse("onboard.html", {
            "request": request, "item": None, "dims": [],
            "session_id": "", "remaining_ids": "", "item_num": 0, "total": 0,
        })
    random.shuffle(pool)
    items = pool[:10]
    session_id = str(uuid.uuid4())
    first = serialize(items[0])
    remaining_ids = ",".join(str(i["_id"]) for i in items[1:])
    dims = select_maxdiff_dims(first.get("psychological_tags", {}))
    return templates.TemplateResponse("onboard.html", {
        "request": request,
        "item": first,
        "dims": dims,
        "session_id": session_id,
        "remaining_ids": remaining_ids,
        "item_num": 1,
        "total": len(items),
    })


@app.post("/onboard/response", response_class=HTMLResponse)
async def onboard_response(
    request: Request,
    media_id: str = Form(...),
    most: str = Form(...),
    least: str = Form(...),
    session_id: str = Form(...),
    remaining_ids: str = Form(""),
    item_num: int = Form(1),
    total: int = Form(10),
) -> HTMLResponse:
    db = get_db()
    now = datetime.now(tz=timezone.utc)
    media_oid = ObjectId(media_id)
    title = (db["MediaLogs"].find_one({"_id": media_oid}, {"title": 1}) or {}).get("title", "")
    for utility_type, dimension in [("most", most), ("least", least)]:
        db["TasteClusters"].insert_one({
            "media_id": media_oid,
            "title": title,
            "dimension": dimension,
            "utility_type": utility_type,
            "session_id": session_id,
            "timestamp": now,
        })

    remaining = [r for r in remaining_ids.split(",") if r]
    if not remaining:
        return templates.TemplateResponse("partials/onboard_done.html", {"request": request})

    next_id, *rest = remaining
    item = serialize(db["MediaLogs"].find_one({"_id": ObjectId(next_id)}))
    dims = select_maxdiff_dims(item.get("psychological_tags", {}))
    return templates.TemplateResponse("partials/onboard_card.html", {
        "request": request,
        "item": item,
        "dims": dims,
        "session_id": session_id,
        "remaining_ids": ",".join(rest),
        "item_num": item_num + 1,
        "total": total,
    })


# ---------------------------------------------------------------------------
# Calibration
# ---------------------------------------------------------------------------

@app.get("/calibrate", response_class=HTMLResponse)
async def calibrate(request: Request) -> HTMLResponse:
    db = get_db()
    items = list(db["MediaLogs"].find(
        {"tier": 1, "psychological_tags": {"$exists": True, "$ne": {}}}
    ).sort("title", 1))
    items = [serialize(i) for i in items]
    return templates.TemplateResponse("calibrate.html", {"request": request, "items": items})


@app.post("/calibrate/save", response_class=HTMLResponse)
async def calibrate_save(request: Request) -> HTMLResponse:
    db = get_db()
    form = await request.form()
    now = datetime.now(tz=timezone.utc)

    updates: dict = {}
    media_ids: set = set()
    for key, value in form.items():
        parts = key.split("__", 1)
        if len(parts) != 2:
            continue
        media_id_str, dimension = parts
        if dimension not in DIMENSIONS:
            continue
        try:
            score = float(value)
            ObjectId(media_id_str)
        except Exception:
            continue
        updates[(media_id_str, dimension)] = score
        media_ids.add(media_id_str)

    docs = {
        str(d["_id"]): d
        for d in db["MediaLogs"].find(
            {"_id": {"$in": [ObjectId(m) for m in media_ids]}},
            {"title": 1, "medium": 1, "psychological_tags": 1},
        )
    }
    for (media_id_str, dimension), confirmed_score in updates.items():
        doc = docs.get(media_id_str)
        if not doc:
            continue
        llm_score = (doc.get("psychological_tags") or {}).get(dimension)
        db["CalibrationAnchors"].update_one(
            {"media_id": ObjectId(media_id_str), "dimension": dimension},
            {"$set": {
                "media_id": ObjectId(media_id_str),
                "title": doc["title"],
                "medium": doc.get("medium", ""),
                "dimension": dimension,
                "confirmed_score": confirmed_score,
                "llm_score": llm_score,
                "timestamp": now,
            }},
            upsert=True,
        )
    return templates.TemplateResponse("partials/calibrate_saved.html", {"request": request})


# ---------------------------------------------------------------------------
# Log new entry + binary search ranking
# ---------------------------------------------------------------------------

@app.get("/log", response_class=HTMLResponse)
async def log_form(
    request: Request,
    title: str = "",
    medium: str = "",
) -> HTMLResponse:
    return templates.TemplateResponse("log.html", {
        "request": request,
        "prefill_title": title,
        "prefill_medium": medium,
    })


@app.post("/log/submit", response_class=HTMLResponse)
async def log_submit(
    request: Request,
    title: str = Form(...),
    medium: str = Form(...),
    tier: int = Form(...),
    creator: str = Form(""),
    year: str = Form(""),
    tmdb_id: int = Form(0),
    books_id: str = Form(""),
    igdb_id: int = Form(0),
) -> HTMLResponse:
    db = get_db()
    now = datetime.now(tz=timezone.utc)
    year_int = int(year) if year.strip().isdigit() else None
    final_title = title
    metadata: dict = {}
    poster_url: str | None = None

    if tmdb_id:
        try:
            metadata = fetch_tmdb_by_id(tmdb_id, medium)
            final_title = metadata.get("title") or metadata.get("name") or title
            date_field = "release_date" if medium == "movie" else "first_air_date"
            if metadata.get(date_field) and not year_int:
                year_int = int(metadata[date_field][:4])
            if metadata.get("poster_path"):
                poster_url = f"{TMDB_IMAGE_BASE}{metadata['poster_path']}"
            if not creator and medium == "tv":
                cb = metadata.get("created_by") or []
                if cb:
                    creator = cb[0]["name"]
        except Exception:
            pass
    elif igdb_id:
        try:
            token = get_igdb_token()
            body = (
                f"fields name,summary,genres.name,first_release_date,cover.url,"
                f"rating,rating_count,"
                f"involved_companies.company.name,involved_companies.developer; "
                f"where id = {igdb_id}; limit 1;"
            )
            resp, _ = igdb_request(body, token)
            results = resp.json()
            if results:
                metadata = dict(results[0])
                final_title = metadata.get("name", title)
                if metadata.get("first_release_date") and not year_int:
                    year_int = datetime.utcfromtimestamp(metadata["first_release_date"]).year
                cover = metadata.get("cover") or {}
                if cover.get("url"):
                    poster_url = "https:" + cover["url"].replace("t_thumb", "t_cover_big")
                if not creator:
                    devs = [
                        c["company"]["name"]
                        for c in (metadata.get("involved_companies") or [])
                        if c.get("developer") and isinstance(c.get("company"), dict)
                    ]
                    creator = devs[0] if devs else ""
        except Exception:
            pass
    elif books_id:
        try:
            resp = get_with_backoff(
                f"https://www.googleapis.com/books/v1/volumes/{books_id}",
                params={"key": BOOKS_KEY},
            )
            info = resp.json().get("volumeInfo", {})
            final_title = info.get("title", title)
            year_str = info.get("publishedDate", "")
            if year_str and year_str[:4].isdigit() and not year_int:
                year_int = int(year_str[:4])
            if not creator:
                creator = ", ".join(info.get("authors", []))
            links = info.get("imageLinks") or {}
            thumb = links.get("thumbnail") or links.get("smallThumbnail")
            if thumb:
                poster_url = thumb.replace("http://", "https://")
            metadata = info
        except Exception:
            pass

    new_id = db["MediaLogs"].insert_one({
        "title": final_title,
        "creator": creator,
        "medium": medium,
        "year": year_int,
        "original_rating": None,
        "tier": tier,
        "date_logged": now,
        "metadata_enriched": bool(metadata),
        "metadata": metadata,
        "poster_url": poster_url,
        "psychological_tags": {},
        "rank_in_tier": None,
        "enrichment_error": None,
    }).inserted_id

    if not metadata:
        try:
            fetched_meta, fetched_poster, _ = enrich_rec(final_title, medium)
            if fetched_meta:
                enrich_updates: dict = {"metadata": fetched_meta, "metadata_enriched": True}
                if fetched_poster:
                    enrich_updates["poster_url"] = fetched_poster
                canonical = fetched_meta.get("title") or fetched_meta.get("name") or fetched_meta.get("volumeInfo", {}).get("title")
                if canonical:
                    enrich_updates["title"] = canonical
                    final_title = canonical
                db["MediaLogs"].update_one({"_id": new_id}, {"$set": enrich_updates})
        except Exception:
            pass

    ranked = list(db["MediaLogs"].find(
        {"tier": tier, "rank_in_tier": {"$ne": None}, "_id": {"$ne": new_id}},
        {"_id": 1, "title": 1, "rank_in_tier": 1, "metadata": 1, "medium": 1},
    ).sort("rank_in_tier", 1))

    if not ranked:
        db["MediaLogs"].update_one({"_id": new_id}, {"$set": {"rank_in_tier": 1.0}})
        return templates.TemplateResponse("partials/log_done.html", {
            "request": request, "title": title, "rank": 1.0, "tier": tier,
        })

    session_id = str(uuid.uuid4())
    ranked_ids = [str(r["_id"]) for r in ranked]
    db["EnrichmentQueue"].insert_one({
        "session_id": session_id,
        "new_media_id": new_id,
        "new_title": title,
        "medium": medium,
        "tier": tier,
        "low": 0,
        "high": len(ranked),
        "ranked_ids": ranked_ids,
        "created_at": now,
    })

    mid = len(ranked) // 2
    return templates.TemplateResponse("partials/log_compare.html", {
        "request": request,
        "new_title": title,
        "compare_item": serialize(ranked[mid]),
        "session_id": session_id,
    })


@app.post("/log/compare", response_class=HTMLResponse)
async def log_compare(
    request: Request,
    session_id: str = Form(...),
    result: str = Form(...),
) -> HTMLResponse:
    db = get_db()
    session = db["EnrichmentQueue"].find_one({"session_id": session_id})
    if not session:
        return HTMLResponse(
            "<p class='text-red-400 p-4 text-center'>Session expired. "
            "<a href='/log' class='underline'>Start over.</a></p>"
        )

    low, high = session["low"], session["high"]
    ranked_ids: list[str] = session["ranked_ids"]
    mid = (low + high) // 2

    if result == "better":
        high = mid
    else:
        low = mid + 1

    if low >= high:
        ranked_docs = {
            str(d["_id"]): d["rank_in_tier"]
            for d in db["MediaLogs"].find(
                {"_id": {"$in": [ObjectId(rid) for rid in ranked_ids]}},
                {"rank_in_tier": 1},
            )
        }
        ordered_ranks = [ranked_docs[rid] for rid in ranked_ids]
        n = len(ordered_ranks)
        pos = low
        if pos == 0:
            final_rank = ordered_ranks[0] - 1.0
        elif pos >= n:
            final_rank = ordered_ranks[-1] + 1.0
        else:
            final_rank = (ordered_ranks[pos - 1] + ordered_ranks[pos]) / 2

        db["MediaLogs"].update_one(
            {"_id": session["new_media_id"]},
            {"$set": {"rank_in_tier": final_rank}},
        )
        db["EnrichmentQueue"].delete_one({"session_id": session_id})
        return templates.TemplateResponse("partials/log_done.html", {
            "request": request,
            "title": session["new_title"],
            "rank": final_rank,
            "tier": session["tier"],
        })

    db["EnrichmentQueue"].update_one(
        {"session_id": session_id},
        {"$set": {"low": low, "high": high}},
    )
    new_mid = (low + high) // 2
    compare_doc = db["MediaLogs"].find_one(
        {"_id": ObjectId(ranked_ids[new_mid])},
        {"_id": 1, "title": 1, "metadata": 1, "medium": 1},
    )
    return templates.TemplateResponse("partials/log_compare.html", {
        "request": request,
        "new_title": session["new_title"],
        "compare_item": serialize(compare_doc),
        "session_id": session_id,
    })


# ---------------------------------------------------------------------------
# Post-hoc metadata fetch
# ---------------------------------------------------------------------------

@app.post("/item/{item_id}/fetch-metadata", response_class=HTMLResponse)
async def fetch_metadata(request: Request, item_id: str) -> HTMLResponse:
    """Fetch and store metadata for an item that was logged without API enrichment."""
    db = get_db()
    try:
        doc = db["MediaLogs"].find_one({"_id": ObjectId(item_id)})
    except Exception:
        return HTMLResponse("<p class='text-red-400 text-xs'>Invalid ID.</p>")
    if not doc:
        return HTMLResponse("<p class='text-red-400 text-xs'>Item not found.</p>")

    title = doc["title"]
    medium = doc.get("medium", "")
    metadata: dict = {}
    poster_url: str | None = None
    updates: dict = {}

    try:
        if medium in ("movie", "tv"):
            endpoint = "movie" if medium == "movie" else "tv"
            resp = get_with_backoff(
                f"{TMDB_BASE}/search/{endpoint}",
                params={"query": title, "api_key": TMDB_KEY},
            )
            results = resp.json().get("results", [])
            if results:
                metadata = dict(results[0])
                tmdb_id = metadata["id"]
                if metadata.get("poster_path"):
                    poster_url = f"{TMDB_IMAGE_BASE}{metadata['poster_path']}"
                try:
                    wp_resp = get_with_backoff(
                        f"{TMDB_BASE}/{endpoint}/{tmdb_id}/watch/providers",
                        params={"api_key": TMDB_KEY},
                    )
                    us = wp_resp.json().get("results", {}).get("US", {})
                    metadata["watch_providers"] = [
                        {"name": p["provider_name"], "logo_path": p["logo_path"], "type": "stream"}
                        for p in us.get("flatrate", [])
                    ] + [
                        {"name": p["provider_name"], "logo_path": p["logo_path"], "type": "buy"}
                        for p in us.get("buy", [])
                    ]
                except Exception:
                    pass
                canonical = metadata.get("title") if medium == "movie" else metadata.get("name")
                if canonical:
                    updates["title"] = canonical
                date_field = "release_date" if medium == "movie" else "first_air_date"
                if metadata.get(date_field):
                    updates["year"] = int(metadata[date_field][:4])
                if medium == "tv":
                    cb = metadata.get("created_by") or []
                    if cb:
                        updates["creator"] = cb[0]["name"]
        elif medium == "game":
            token = get_igdb_token()
            body = (
                f'search "{title}"; '
                "fields name,summary,genres.name,first_release_date,cover.url,"
                "involved_companies.company.name,involved_companies.developer; "
                "limit 1;"
            )
            resp, _ = igdb_request(body, token)
            results = resp.json()
            if results:
                metadata = dict(results[0])
                updates["title"] = metadata.get("name", title)
                if metadata.get("first_release_date"):
                    updates["year"] = datetime.utcfromtimestamp(metadata["first_release_date"]).year
                cover = metadata.get("cover") or {}
                if cover.get("url"):
                    poster_url = "https:" + cover["url"].replace("t_thumb", "t_cover_big")
                devs = [
                    c["company"]["name"]
                    for c in (metadata.get("involved_companies") or [])
                    if c.get("developer") and isinstance(c.get("company"), dict)
                ]
                if devs:
                    updates["creator"] = devs[0]
        elif medium == "book":
            metadata = fetch_google_books(title, doc.get("creator", "")) or {}
            if metadata:
                if metadata.get("title"):
                    updates["title"] = metadata["title"]
                if metadata.get("publishedDate"):
                    updates["year"] = int(metadata["publishedDate"][:4])
                authors = metadata.get("authors") or []
                if authors:
                    updates["creator"] = ", ".join(authors)
                links = metadata.get("imageLinks") or {}
                thumb = links.get("thumbnail") or links.get("smallThumbnail")
                if thumb:
                    poster_url = thumb.replace("http://", "https://")
    except Exception as exc:
        return HTMLResponse(f"<p class='text-red-400 text-xs'>Error: {str(exc)[:100]}</p>")

    if not metadata:
        return HTMLResponse("<p class='text-neutral-500 text-xs'>No match found in API.</p>")

    updates.update({
        "metadata": metadata,
        "poster_url": poster_url,
        "metadata_enriched": True,
        "enrichment_error": None,
    })
    db["MediaLogs"].update_one({"_id": ObjectId(item_id)}, {"$set": updates})

    # Return a small confirmation with poster if found
    poster_html = (
        f'<img src="{poster_url}" class="w-16 rounded shadow mt-2">'
        if poster_url else ""
    )
    canonical_title = updates.get("title", title)
    return HTMLResponse(
        f'<p class="text-emerald-400 text-xs">✓ Metadata fetched for <strong>{canonical_title}</strong>.'
        f" Reload to see full details.</p>{poster_html}"
    )


# ---------------------------------------------------------------------------
# Tier management
# ---------------------------------------------------------------------------

@app.post("/item/{item_id}/set-tier", response_class=HTMLResponse)
async def set_tier(request: Request, item_id: str, tier: str = Form(...)) -> HTMLResponse:
    db = get_db()
    tier_int = int(tier) if tier.isdigit() else None
    db["MediaLogs"].update_one(
        {"_id": ObjectId(item_id)},
        {"$set": {"tier": tier_int, "rank_in_tier": None}},
    )
    return templates.TemplateResponse("partials/tier_select.html", {
        "request": request,
        "item_id": item_id,
        "tier": tier_int,
    })


# ---------------------------------------------------------------------------
# Item detail view
# ---------------------------------------------------------------------------

@app.get("/item/{item_id}", response_class=HTMLResponse)
async def item_detail(request: Request, item_id: str) -> HTMLResponse:
    db = get_db()
    try:
        doc = db["MediaLogs"].find_one({"_id": ObjectId(item_id)})
    except Exception:
        return HTMLResponse("<p>Not found.</p>", status_code=404)
    if not doc:
        return HTMLResponse("<p>Not found.</p>", status_code=404)
    item = serialize(doc)

    # Build dimension list for this item (include game-only dims if present)
    dims = DIMENSIONS[:]
    if item.get("medium") == "game":
        for gd in ("sdt_autonomy", "sdt_competence"):
            if gd in (item.get("psychological_tags") or {}):
                dims.append(gd)

    # Extract overview, genres from metadata
    metadata = item.get("metadata") or {}
    medium = item.get("medium", "")
    if medium in ("movie", "tv"):
        overview = metadata.get("overview", "")
        genres = metadata.get("genres", [])
        if genres and isinstance(genres[0], dict):
            genres = [g["name"] for g in genres]
    elif medium == "book":
        overview = metadata.get("description", "")
        genres = metadata.get("categories", [])
    elif medium == "game":
        overview = metadata.get("summary", "")
        raw_genres = metadata.get("genres") or []
        genres = [g["name"] if isinstance(g, dict) else g for g in raw_genres]
    else:
        overview = ""
        genres = []

    return templates.TemplateResponse("item.html", {
        "request": request,
        "item": item,
        "dims": dims,
        "overview": overview,
        "genres": genres,
    })


# ---------------------------------------------------------------------------
# Watchlist
# ---------------------------------------------------------------------------

@app.get("/watchlist", response_class=HTMLResponse)
async def watchlist(request: Request) -> HTMLResponse:
    db = get_db()
    items = list(db["Watchlist"].find().sort("added_at", DESCENDING))
    for it in items:
        it["_id"] = str(it["_id"])
        it["poster_url"] = get_poster_url(it)
    seen_stream: set = set()
    seen_buy: set = set()
    stream_providers: list = []
    buy_providers: list = []
    for it in items:
        for p in (it.get("watch_providers") or []):
            if not p.get("name"):
                continue
            if p.get("type") == "buy":
                if p["name"] not in seen_buy:
                    seen_buy.add(p["name"])
                    buy_providers.append(p)
            else:
                if p["name"] not in seen_stream:
                    seen_stream.add(p["name"])
                    stream_providers.append(p)
    stream_providers.sort(key=lambda p: p["name"])
    buy_providers.sort(key=lambda p: p["name"])
    all_sources = sorted({it["rec_source"] for it in items if it.get("rec_source")})
    return templates.TemplateResponse("watchlist.html", {
        "request": request,
        "items": items,
        "stream_providers": stream_providers,
        "buy_providers": buy_providers,
        "all_sources": all_sources,
    })


@app.post("/watchlist/enrich-all", response_class=HTMLResponse)
async def watchlist_enrich_all(request: Request) -> HTMLResponse:
    db = get_db()
    needs = list(db["Watchlist"].find({
        "$or": [
            {"medium": {"$in": ["movie", "tv"]}, "watch_providers": {"$in": [None, []]}},
            {"rating_score": None},
        ]
    }))
    count = 0
    for item in needs:
        try:
            medium = item["medium"]
            metadata, poster_url, watch_providers = enrich_rec(item["title"], medium)
            rating_score: float | None = None
            if medium in ("movie", "tv"):
                rating_score = metadata.get("vote_average")
            elif medium == "book":
                rating_score = metadata.get("averageRating")
            elif medium == "game":
                rating_score = metadata.get("rating")
            updates: dict = {}
            if watch_providers and not item.get("watch_providers"):
                updates["watch_providers"] = watch_providers
            if rating_score is not None and item.get("rating_score") is None:
                updates["rating_score"] = rating_score
            if not item.get("poster_url") and poster_url:
                updates["poster_url"] = poster_url
            if not item.get("metadata") and metadata:
                updates["metadata"] = metadata
            if updates:
                db["Watchlist"].update_one({"_id": item["_id"]}, {"$set": updates})
                count += 1
        except Exception:
            pass
    if count:
        return HTMLResponse(
            f'<span class="text-xs text-emerald-400">✓ Enriched {count} item{"s" if count != 1 else ""}. '
            f'<a href="/watchlist" class="underline hover:text-white">Reload to see changes →</a></span>'
        )
    return HTMLResponse('<span class="text-xs text-neutral-500">All items already enriched.</span>')


@app.post("/library/enrich-all", response_class=HTMLResponse)
async def library_enrich_all(request: Request) -> HTMLResponse:
    db = get_db()
    items = list(db["MediaLogs"].find({
        "$or": [
            {"metadata_enriched": False},
            {"metadata_enriched": {"$exists": False}},
            {"poster_url": None},
        ]
    }))
    count = 0
    for item in items:
        medium = item.get("medium", "")
        if not medium:
            continue
        try:
            metadata, poster_url, _ = enrich_rec(item["title"], medium)
            if not metadata:
                continue
            updates: dict = {"metadata": metadata, "metadata_enriched": True}
            if poster_url and not item.get("poster_url"):
                updates["poster_url"] = poster_url
            canonical = metadata.get("title") or metadata.get("name") or metadata.get("volumeInfo", {}).get("title")
            if canonical and canonical != item["title"]:
                updates["title"] = canonical
            db["MediaLogs"].update_one({"_id": item["_id"]}, {"$set": updates})
            count += 1
        except Exception:
            pass
    if count:
        return HTMLResponse(
            f'<span class="text-xs text-emerald-400">✓ Enriched {count} item{"s" if count != 1 else ""}. '
            f'<a href="/" class="underline hover:text-white">Reload to see changes →</a></span>'
        )
    return HTMLResponse('<span class="text-xs text-neutral-500">All items already enriched.</span>')


@app.post("/watchlist/add", response_class=HTMLResponse)
async def watchlist_add(
    request: Request,
    title: str = Form(...),
    medium: str = Form(...),
    reason: str = Form(""),
    tmdb_id: int = Form(0),
    books_id: str = Form(""),
    igdb_id: int = Form(0),
    sel_year: str = Form(""),
    sel_creator: str = Form(""),
    sel_poster_url: str = Form(""),
    rating_score: str = Form(""),
    rec_source: str = Form(""),
) -> HTMLResponse:
    db = get_db()
    now = datetime.now(tz=timezone.utc)

    final_title = title
    creator = sel_creator
    year_int = int(sel_year) if sel_year.strip().isdigit() else None
    poster_url: str | None = sel_poster_url or None
    metadata: dict = {}
    watch_providers: list = []

    if tmdb_id:
        try:
            metadata = fetch_tmdb_by_id(tmdb_id, medium)
            final_title = metadata.get("title") or metadata.get("name") or title
            date_field = "release_date" if medium == "movie" else "first_air_date"
            if metadata.get(date_field):
                year_int = int(metadata[date_field][:4])
            if metadata.get("poster_path"):
                poster_url = f"{TMDB_IMAGE_BASE}{metadata['poster_path']}"
            watch_providers = metadata.get("watch_providers", [])
            if not creator and medium == "tv":
                cb = metadata.get("created_by") or []
                if cb:
                    creator = cb[0]["name"]
        except Exception:
            pass
    elif igdb_id:
        try:
            token = get_igdb_token()
            body = (
                f"fields name,summary,genres.name,first_release_date,cover.url,"
                f"rating,rating_count,"
                f"involved_companies.company.name,involved_companies.developer; "
                f"where id = {igdb_id}; limit 1;"
            )
            resp, _ = igdb_request(body, token)
            results = resp.json()
            if results:
                metadata = dict(results[0])
                final_title = metadata.get("name", title)
                if metadata.get("first_release_date"):
                    year_int = datetime.utcfromtimestamp(metadata["first_release_date"]).year
                cover = metadata.get("cover") or {}
                if cover.get("url"):
                    poster_url = "https:" + cover["url"].replace("t_thumb", "t_cover_big")
                if not creator:
                    devs = [
                        c["company"]["name"]
                        for c in (metadata.get("involved_companies") or [])
                        if c.get("developer") and isinstance(c.get("company"), dict)
                    ]
                    creator = devs[0] if devs else ""
        except Exception:
            pass
    elif books_id:
        try:
            resp = get_with_backoff(
                f"https://www.googleapis.com/books/v1/volumes/{books_id}",
                params={"key": BOOKS_KEY},
            )
            info = resp.json().get("volumeInfo", {})
            final_title = info.get("title", title)
            year_str = info.get("publishedDate", "")
            if year_str and year_str[:4].isdigit():
                year_int = int(year_str[:4])
            if not creator:
                creator = ", ".join(info.get("authors", []))
            links = info.get("imageLinks") or {}
            thumb = links.get("thumbnail") or links.get("smallThumbnail")
            if thumb:
                poster_url = thumb.replace("http://", "https://")
            metadata = info
        except Exception:
            pass

    stored_rating: float | None = float(rating_score) if rating_score.strip() else None
    if stored_rating is None and medium in ("movie", "tv"):
        stored_rating = metadata.get("vote_average")
    elif stored_rating is None and medium == "book":
        stored_rating = metadata.get("averageRating")
    elif stored_rating is None and medium == "game":
        stored_rating = metadata.get("rating")

    db["Watchlist"].insert_one({
        "title": final_title,
        "medium": medium,
        "creator": creator,
        "year": year_int,
        "source": "manual",
        "reason": reason,
        "added_at": now,
        "metadata": metadata,
        "poster_url": poster_url,
        "watch_providers": watch_providers,
        "psychological_tags": {},
        "rating_score": stored_rating,
        "rec_source": rec_source or None,
    })
    return templates.TemplateResponse("partials/watchlist_added.html", {
        "request": request,
        "title": final_title,
    })


@app.post("/library/add", response_class=HTMLResponse)
async def library_add(
    request: Request,
    title: str = Form(...),
    medium: str = Form(...),
    reason: str = Form(""),
    sel_poster_url: str = Form(""),
) -> HTMLResponse:
    db = get_db()
    existing = db["MediaLogs"].find_one({
        "title": {"$regex": f"^{re.escape(title)}$", "$options": "i"},
        "medium": medium,
    })
    if existing:
        return HTMLResponse('<span class="text-xs text-yellow-500">Already in library</span>')
    now = datetime.now(tz=timezone.utc)
    db["MediaLogs"].insert_one({
        "title": title,
        "medium": medium,
        "tier": None,
        "rating": None,
        "reason": reason,
        "added_at": now,
        "logged_at": now,
        "metadata": {},
        "poster_url": sel_poster_url or None,
        "watch_providers": [],
        "psychological_tags": {},
        "metadata_enriched": False,
        "source": "discover_recommendation",
    })
    return HTMLResponse('<span class="text-xs text-emerald-400">✓ In library</span>')


@app.post("/discover/blacklist", response_class=HTMLResponse)
async def blacklist_add(
    request: Request,
    title: str = Form(...),
    medium: str = Form(...),
) -> HTMLResponse:
    db = get_db()
    existing = db["DiscoverBlacklist"].find_one({
        "title": {"$regex": f"^{re.escape(title)}$", "$options": "i"},
        "medium": medium,
    })
    if not existing:
        db["DiscoverBlacklist"].insert_one({
            "title": title,
            "medium": medium,
            "added_at": datetime.now(tz=timezone.utc),
        })
    return HTMLResponse("")


@app.get("/discover/blacklist", response_class=HTMLResponse)
async def blacklist_page(request: Request) -> HTMLResponse:
    db = get_db()
    items = list(db["DiscoverBlacklist"].find().sort("added_at", DESCENDING))
    for item in items:
        item["_id"] = str(item["_id"])
    return templates.TemplateResponse("blacklist.html", {
        "request": request,
        "items": items,
    })


@app.post("/discover/blacklist/remove/{item_id}", response_class=HTMLResponse)
async def blacklist_remove(request: Request, item_id: str) -> HTMLResponse:
    db = get_db()
    db["DiscoverBlacklist"].delete_one({"_id": ObjectId(item_id)})
    return HTMLResponse("")


@app.post("/watchlist/remove/{item_id}", response_class=HTMLResponse)
async def watchlist_remove(request: Request, item_id: str) -> HTMLResponse:
    db = get_db()
    db["Watchlist"].delete_one({"_id": ObjectId(item_id)})
    return HTMLResponse("")


@app.post("/watchlist/promote/{item_id}")
async def watchlist_promote(request: Request, item_id: str):
    db = get_db()
    wl_item = db["Watchlist"].find_one({"_id": ObjectId(item_id)})
    if not wl_item:
        return RedirectResponse("/watchlist", status_code=303)
    now = datetime.now(tz=timezone.utc)
    db["MediaLogs"].insert_one({
        "title": wl_item["title"],
        "creator": wl_item.get("creator", ""),
        "medium": wl_item["medium"],
        "year": wl_item.get("year"),
        "original_rating": None,
        "tier": None,
        "date_logged": now,
        "metadata_enriched": False,
        "metadata": wl_item.get("metadata", {}),
        "psychological_tags": wl_item.get("psychological_tags", {}),
        "rank_in_tier": None,
        "enrichment_error": None,
    })
    db["Watchlist"].delete_one({"_id": ObjectId(item_id)})
    return RedirectResponse(f"/log?title={wl_item['title']}&medium={wl_item['medium']}", status_code=303)


# ---------------------------------------------------------------------------
# Taste Profile
# ---------------------------------------------------------------------------

@app.get("/profile", response_class=HTMLResponse)
async def profile(request: Request) -> HTMLResponse:
    db = get_db()

    def avg_vector(docs: list) -> dict:
        sums: dict = defaultdict(float)
        counts: dict = defaultdict(int)
        for d in docs:
            for k, v in (d.get("psychological_tags") or {}).items():
                if k in KNOWN_DIMS:
                    sums[k] += v
                    counts[k] += 1
        return {k: round(sums[k] / counts[k], 2) for k in sums}

    tier12 = list(db["MediaLogs"].find(
        {"tier": {"$in": [1, 2]}, "psychological_tags": {"$ne": {}}},
        {"psychological_tags": 1},
    ))
    tier5 = list(db["MediaLogs"].find(
        {"tier": 5, "psychological_tags": {"$ne": {}}},
        {"psychological_tags": 1},
    ))
    loved_vec = avg_vector(tier12)
    disliked_vec = avg_vector(tier5)

    dim_rows = []
    for dim in DIMENSIONS:
        loved = loved_vec.get(dim)
        disliked = disliked_vec.get(dim)
        delta = round(loved - disliked, 2) if (loved is not None and disliked is not None) else None
        dim_rows.append({
            "key": dim,
            "label": DIMENSION_LABELS[dim],
            "definition": DIMENSION_DEFINITIONS.get(dim, ""),
            "loved": loved,
            "disliked": disliked,
            "delta": delta,
            "bar_pct": round((loved - 1) / 4 * 100, 1) if loved else 0,
        })

    by_score = sorted([r for r in dim_rows if r["loved"]], key=lambda x: -x["loved"])
    by_delta = sorted([r for r in dim_rows if r["delta"] is not None], key=lambda x: -x["delta"])

    # Load clusters + exemplars
    cluster_defs = list(db["ClusterDefs"].find().sort("cluster_id", ASCENDING))
    clusters = []
    for cd in cluster_defs:
        exemplar_ids = [ObjectId(eid) for eid in (cd.get("exemplar_ids") or [])[:3]]
        exemplar_docs = [
            serialize(db["MediaLogs"].find_one({"_id": eid}))
            for eid in exemplar_ids
            if db["MediaLogs"].find_one({"_id": eid})
        ]
        cd["_id"] = str(cd["_id"])
        cd["exemplars"] = exemplar_docs
        # Centroid bars sorted by score desc
        centroid = cd.get("centroid") or {}
        cd["centroid_rows"] = sorted(
            [{"key": d, "label": DIMENSION_LABELS.get(d, d), "score": centroid.get(d, 3.0),
              "bar_pct": round((centroid.get(d, 3.0) - 1) / 4 * 100, 1)}
             for d in DIMENSIONS if d in centroid],
            key=lambda x: -x["score"],
        )
        clusters.append(cd)

    # TasteClusters MaxDiff votes
    cluster_votes: dict = defaultdict(lambda: {"most": 0, "least": 0})
    for doc in db["TasteClusters"].find():
        dim = doc.get("dimension")
        ut = doc.get("utility_type")
        if dim and ut in ("most", "least") and dim in KNOWN_DIMS:
            cluster_votes[dim][ut] += 1
    cluster_rows = sorted(
        [{"key": k, "label": DIMENSION_LABELS.get(k, k), **v}
         for k, v in cluster_votes.items()],
        key=lambda x: -(x["most"] - x["least"]),
    )

    total = db["MediaLogs"].count_documents({})
    tier_counts = {t: db["MediaLogs"].count_documents({"tier": t}) for t in [1, 2, 3, 4, 5]}
    enriched = db["MediaLogs"].count_documents({"psychological_tags": {"$ne": {}}})

    return templates.TemplateResponse("profile.html", {
        "request": request,
        "clusters": clusters,
        "by_score": by_score,
        "by_delta": by_delta,
        "cluster_rows": cluster_rows,
        "total": total,
        "tier_counts": tier_counts,
        "enriched": enriched,
        "loved_count": len(tier12),
    })


# ---------------------------------------------------------------------------
# Discover (LLM recommendations — seed or cluster mode)
# ---------------------------------------------------------------------------

SEED_SYSTEM_PROMPT = """You are a media recommendation engine.
The user enjoys specific titles listed below. Based on those titles and their psychological profiles, recommend 25 titles they have NOT consumed.
Match the style, tone, and qualities that make those seeds compelling.
CRITICAL RULE: The EXCLUDE list contains everything the user has already seen, read, played, or queued. You MUST check every single recommendation against that list before including it. Any title appearing on the EXCLUDE list — even under a slightly different format — must be dropped and replaced with something else. Violating this rule makes the recommendations useless.
IMPORTANT: This user has a large, well-curated library. Do NOT suggest the obvious genre classics — they almost certainly have them. Prioritize deep cuts, underseen works, and non-obvious choices that match the same qualities.
QUALITY: Prefer well-regarded titles — movies/TV above 7/10, books above 3.5/5, games above 75/100 on community aggregators. Avoid panned or critically ignored works.
Return ONLY a valid JSON array — no preamble, no explanation, no markdown.
Return format: [{"title": "...", "medium": "movie|tv|book|game", "reason": "one sentence"}, ...]"""

CLUSTER_SYSTEM_PROMPT = """You are a media recommendation engine.
The user has a specific taste facet described below. Recommend 25 titles matching that taste.
CRITICAL RULE: The EXCLUDE list contains everything the user has already seen, read, played, or queued. You MUST check every single recommendation against that list before including it. Any title appearing on the EXCLUDE list — even under a slightly different format — must be dropped and replaced with something else. Violating this rule makes the recommendations useless.
IMPORTANT: This user has a large, well-curated library. Do NOT suggest the obvious genre classics — they almost certainly have them. Prioritize deep cuts, underseen works, and non-obvious choices that match the same qualities.
QUALITY: Prefer well-regarded titles — movies/TV above 7/10, books above 3.5/5, games above 75/100 on community aggregators. Avoid panned or critically ignored works.
Return ONLY a valid JSON array — no preamble, no explanation, no markdown.
Return format: [{"title": "...", "medium": "movie|tv|book|game", "reason": "one sentence"}, ...]"""


def _normalize_title(title: str) -> str:
    """Lowercase, strip leading articles and punctuation for fuzzy dedup."""
    t = title.lower().strip()
    for article in ("the ", "a ", "an "):
        if t.startswith(article):
            t = t[len(article):]
            break
    return re.sub(r"[^\w\s]", "", t).strip()


def _build_exclusion_str(db) -> tuple[set, set, str]:
    seen = {i["title"].lower() for i in db["MediaLogs"].find({}, {"title": 1})}
    queued = {i["title"].lower() for i in db["Watchlist"].find({}, {"title": 1})}
    blocked = {i["title"].lower() for i in db["DiscoverBlacklist"].find({}, {"title": 1})}
    exclusion = seen | queued | blocked
    exclusion_norm = {_normalize_title(t) for t in exclusion}
    return exclusion, exclusion_norm, "\n".join(sorted(exclusion))


def _enrich_and_normalize(rec: dict) -> dict:
    """Enrich a raw LLM recommendation dict with metadata/poster/providers."""
    title = rec["title"]
    medium = rec.get("medium", "")
    metadata, poster_url, watch_providers = enrich_rec(title, medium)
    final_title, year, creator = title, None, ""
    if medium == "movie" and metadata.get("title"):
        final_title = metadata["title"]
        if metadata.get("release_date"):
            year = int(metadata["release_date"][:4])
    elif medium == "tv" and metadata.get("name"):
        final_title = metadata["name"]
        if metadata.get("first_air_date"):
            year = int(metadata["first_air_date"][:4])
        cb = metadata.get("created_by") or []
        if cb:
            creator = cb[0]["name"]
    elif medium == "book":
        if metadata.get("title"):
            final_title = metadata["title"]
        if metadata.get("publishedDate"):
            year = int(metadata["publishedDate"][:4])
        authors = metadata.get("authors") or []
        if authors:
            creator = ", ".join(authors)
    elif medium == "game" and metadata.get("name"):
        final_title = metadata["name"]
        if metadata.get("first_release_date"):
            year = datetime.utcfromtimestamp(metadata["first_release_date"]).year
        devs = [
            c["company"]["name"]
            for c in (metadata.get("involved_companies") or [])
            if c.get("developer") and isinstance(c.get("company"), dict)
        ]
        creator = devs[0] if devs else ""

    rating_score: float | None = None
    rating_count: int = 0
    if medium in ("movie", "tv"):
        rating_score = metadata.get("vote_average")
        rating_count = metadata.get("vote_count") or 0
    elif medium == "book":
        rating_score = metadata.get("averageRating")
        rating_count = metadata.get("ratingsCount") or 0
    elif medium == "game":
        rating_score = metadata.get("rating")
        rating_count = metadata.get("rating_count") or 0

    return {
        "title": final_title, "medium": medium, "creator": creator, "year": year,
        "reason": rec.get("reason", ""), "metadata": metadata,
        "poster_url": poster_url, "watch_providers": watch_providers,
        "rating_score": rating_score, "rating_count": rating_count,
    }


def _passes_quality_filter(rec: dict) -> bool:
    floor = QUALITY_FLOORS.get(rec.get("medium", ""))
    if not floor:
        return True
    score = rec.get("rating_score")
    count = rec.get("rating_count") or 0
    if score is None or count < floor["min_count"]:
        return True  # no data or too few votes — don't penalize obscure titles
    return score >= floor["min_score"]


@app.get("/discover", response_class=HTMLResponse)
async def discover(request: Request, cluster: int = -1) -> HTMLResponse:
    db = get_db()
    cluster_defs = list(db["ClusterDefs"].find().sort("cluster_id", ASCENDING))
    for cd in cluster_defs:
        cd["_id"] = str(cd["_id"])
        exemplar_ids = [ObjectId(eid) for eid in (cd.get("exemplar_ids") or [])[:3]]
        exemplar_docs = [
            serialize(db["MediaLogs"].find_one({"_id": eid}))
            for eid in exemplar_ids
            if db["MediaLogs"].find_one({"_id": eid})
        ]
        cd["exemplars"] = exemplar_docs
    return templates.TemplateResponse("discover.html", {
        "request": request,
        "cluster_defs": cluster_defs,
        "preselect_cluster": cluster,
    })


@app.post("/discover/generate", response_class=HTMLResponse)
async def discover_generate(
    request: Request,
    mode: str = Form("seed"),
    seed_ids: str = Form(""),
    cluster_id: int = Form(-1),
    target_medium: str = Form(""),
) -> HTMLResponse:
    db = get_db()
    ai_client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    exclusion, exclusion_norm, exclusion_str = _build_exclusion_str(db)

    if mode == "seed":
        ids = [sid.strip() for sid in seed_ids.split(",") if sid.strip()]
        if not ids:
            return HTMLResponse("<p class='text-neutral-500 text-sm'>Select at least one seed title.</p>")
        seed_docs = [db["MediaLogs"].find_one({"_id": ObjectId(sid)}) for sid in ids if ObjectId.is_valid(sid)]
        seed_docs = [d for d in seed_docs if d]
        if not seed_docs:
            return HTMLResponse("<p class='text-neutral-500 text-sm'>Seed titles not found.</p>")

        seeds_str = ""
        for doc in seed_docs:
            tags = doc.get("psychological_tags") or {}
            tag_str = ", ".join(
                f"{DIMENSION_LABELS.get(k, k)}={round(v, 1)}"
                for k, v in tags.items() if k in KNOWN_DIMS
            )
            seeds_str += f"- {doc['title']} ({doc.get('medium', '')})"
            if tag_str:
                seeds_str += f"\n  Profile: {tag_str}"
            seeds_str += "\n"

        medium_constraint = (
            f"\nIMPORTANT: Recommend {target_medium}s only. Every item in the array must have \"medium\": \"{target_medium}\"."
            if target_medium else ""
        )
        user_msg = (
            f"The user enjoys these titles:\n{seeds_str}\n"
            f"Titles to EXCLUDE ({len(exclusion)} total):\n{exclusion_str}"
            f"{medium_constraint}"
        )
        system = SEED_SYSTEM_PROMPT
        rec_source = "seed"

    else:  # cluster mode
        cd = db["ClusterDefs"].find_one({"cluster_id": cluster_id})
        if not cd:
            return HTMLResponse("<p class='text-neutral-500 text-sm'>Cluster not found. Run cluster.py first.</p>")

        centroid = cd.get("centroid") or {}
        centroid_str = "\n".join(
            f"  {DIMENSION_LABELS.get(d, d)}: {centroid.get(d, 3.0):.1f}"
            for d in DIMENSIONS if d in centroid
        )
        exemplar_ids = [ObjectId(eid) for eid in (cd.get("exemplar_ids") or [])[:10]]
        exemplar_docs = list(db["MediaLogs"].find(
            {"_id": {"$in": exemplar_ids}}, {"title": 1, "medium": 1}
        ))
        exemplar_titles = "\n".join(f"  - {d['title']} ({d.get('medium', '')})" for d in exemplar_docs)

        medium_constraint = (
            f"\nIMPORTANT: Recommend {target_medium}s only. Every item in the array must have \"medium\": \"{target_medium}\"."
            if target_medium else ""
        )
        user_msg = (
            f"Taste cluster: \"{cd['name']}\"\n"
            f"{cd.get('description', '')}\n\n"
            f"Psychological profile (1.0–5.0):\n{centroid_str}\n\n"
            f"Example titles from this cluster:\n{exemplar_titles}\n\n"
            f"Titles to EXCLUDE ({len(exclusion)} total):\n{exclusion_str}"
            f"{medium_constraint}"
        )
        system = CLUSTER_SYSTEM_PROMPT
        rec_source = cd["name"]

    try:
        msg = ai_client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=3000,
            system=system,
            messages=[{"role": "user", "content": user_msg}],
        )
        raw = msg.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        recs_raw = json.loads(raw)
    except Exception as exc:
        return HTMLResponse(f"<p class='text-red-400 text-sm'>Error: {str(exc)[:200]}</p>")

    results = []
    filtered_out = []
    for rec in recs_raw:
        if not isinstance(rec, dict) or not rec.get("title"):
            continue
        # Hard Python-side exclusion — not dependent on LLM compliance
        t = rec["title"]
        if t.lower() in exclusion or _normalize_title(t) in exclusion_norm:
            filtered_out.append(t)
            continue
        enriched = _enrich_and_normalize(rec)
        # Re-check after enrichment in case the API returned a canonical title
        final_t = enriched.get("title", t)
        if final_t.lower() in exclusion or _normalize_title(final_t) in exclusion_norm:
            filtered_out.append(final_t)
            continue
        if not _passes_quality_filter(enriched):
            score = enriched.get("rating_score")
            filtered_out.append(f"{final_t} (score: {score:.1f})" if score else final_t)
            continue
        results.append(enriched)

    return templates.TemplateResponse("partials/discover_results.html", {
        "request": request,
        "recs": results,
        "filtered_out": filtered_out,
        "rec_source": rec_source,
    })
