"""
Import watchlist CSVs into the Watchlist collection and enrich with metadata
(posters, overviews) + TMDB streaming providers for movie/tv.

Sources:
  - exports/StoryGraph.csv          → to-read books
  - exports/Letterboxd Watchlist.csv → movies to watch
  - exports/tv watchlist.csv         → TV shows to watch

Run: python3 ingest_watchlists.py
"""

import csv
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

from db import get_db
from enrichment import (
    TMDB_BASE,
    fetch_google_books,
    fetch_tmdb_genre_map,
    get_with_backoff,
)

load_dotenv()

EXPORTS = Path(__file__).parent / "exports"
TMDB_KEY = os.environ["TMDB_API_KEY"]
BOOKS_KEY = os.environ["GOOGLE_BOOKS_API_KEY"]
TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w300"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def fetch_tmdb_with_providers(title: str, medium: str, genre_map: dict) -> dict | None:
    """Fetch TMDB metadata and append US streaming providers."""
    endpoint = "movie" if medium == "movie" else "tv"
    resp = get_with_backoff(
        f"{TMDB_BASE}/search/{endpoint}",
        params={"query": title, "api_key": TMDB_KEY},
    )
    results = resp.json().get("results", [])
    if not results:
        return None
    result = dict(results[0])
    result["genres"] = [genre_map.get(gid, str(gid)) for gid in result.get("genre_ids", [])]

    # Fetch watch providers
    tmdb_id = result["id"]
    try:
        wp_resp = get_with_backoff(
            f"{TMDB_BASE}/{endpoint}/{tmdb_id}/watch/providers",
            params={"api_key": TMDB_KEY},
        )
        us = wp_resp.json().get("results", {}).get("US", {})
        result["watch_providers"] = [
            {"name": p["provider_name"], "logo_path": p["logo_path"]}
            for p in us.get("flatrate", [])
        ]
    except Exception:
        result["watch_providers"] = []

    return result


def poster_url_from_metadata(medium: str, metadata: dict) -> str | None:
    if medium in ("movie", "tv"):
        p = metadata.get("poster_path")
        return f"{TMDB_IMAGE_BASE}{p}" if p else None
    if medium == "book":
        links = metadata.get("imageLinks") or {}
        url = links.get("thumbnail") or links.get("smallThumbnail")
        return url.replace("http://", "https://") if url else None
    return None


# ---------------------------------------------------------------------------
# CSV parsers
# ---------------------------------------------------------------------------

def parse_storygraph_to_reads() -> list[dict]:
    items = []
    with open(EXPORTS / "StoryGraph.csv", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row.get("Read Status", "").strip() != "to-read":
                continue
            title = row.get("Title", "").strip()
            author = row.get("Authors", "").strip()
            if not title:
                continue
            items.append({"title": title, "creator": author, "medium": "book", "reason": ""})
    return items


def parse_letterboxd_watchlist() -> list[dict]:
    items = []
    path = EXPORTS / "Letterboxd Watchlist.csv"
    with open(path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            title = row.get("Name", "").strip()
            year = row.get("Year", "").strip()
            if not title:
                continue
            items.append({
                "title": title,
                "creator": "",
                "medium": "movie",
                "year": int(year) if year.isdigit() else None,
                "reason": "",
            })
    return items


def parse_tv_watchlist() -> list[dict]:
    items = []
    path = EXPORTS / "tv watchlist.csv"
    with open(path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            title = row.get("Show", "").strip()
            reason = row.get("Rationale", "").strip()
            if not title:
                continue
            items.append({"title": title, "creator": "", "medium": "tv", "reason": reason})
    return items


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    db = get_db()
    now = datetime.now(tz=timezone.utc)

    # Build dedup set from existing MediaLogs + Watchlist
    seen: set[str] = set()
    seen |= {d["title"].lower() for d in db["MediaLogs"].find({}, {"title": 1})}
    seen |= {d["title"].lower() for d in db["Watchlist"].find({}, {"title": 1})}
    print(f"Existing titles to skip: {len(seen)}")

    # Collect all items
    all_items: list[dict] = []
    all_items += parse_storygraph_to_reads()
    all_items += parse_letterboxd_watchlist()
    all_items += parse_tv_watchlist()

    # Dedup within this batch too
    batch_seen: set[str] = set()
    unique: list[dict] = []
    for item in all_items:
        key = item["title"].lower()
        if key in seen or key in batch_seen:
            continue
        batch_seen.add(key)
        unique.append(item)

    print(f"New items to import: {len(unique)} (skipped {len(all_items) - len(unique)} duplicates)\n")

    print("Fetching TMDB genre map...")
    genre_map = fetch_tmdb_genre_map()

    inserted = skipped = 0
    for i, item in enumerate(unique, 1):
        title = item["title"]
        medium = item["medium"]
        print(f"[{i}/{len(unique)}] {title} ({medium})", end=" — ", flush=True)

        metadata: dict = {}
        poster_url: str | None = None

        try:
            if medium in ("movie", "tv"):
                metadata = fetch_tmdb_with_providers(title, medium, genre_map) or {}
            else:
                metadata = fetch_google_books(title, item.get("creator", "")) or {}
            poster_url = poster_url_from_metadata(medium, metadata)
            status = "OK" if metadata else "no_match"
        except Exception as exc:
            status = f"error: {str(exc)[:60]}"

        print(status)

        # Normalise title/year/creator from metadata
        updates: dict = {"title": title}
        if medium == "movie" and metadata.get("title"):
            updates["title"] = metadata["title"]
            if metadata.get("release_date"):
                updates["year"] = int(metadata["release_date"][:4])
        elif medium == "tv" and metadata.get("name"):
            updates["title"] = metadata["name"]
            if metadata.get("first_air_date"):
                updates["year"] = int(metadata["first_air_date"][:4])
            cb = metadata.get("created_by") or []
            if cb:
                updates["creator"] = cb[0]["name"]
        elif medium == "book":
            if metadata.get("title"):
                updates["title"] = metadata["title"]
            if metadata.get("publishedDate"):
                updates["year"] = int(metadata["publishedDate"][:4])
            authors = metadata.get("authors") or []
            if authors:
                updates["creator"] = ", ".join(authors)

        doc = {
            "title": updates.get("title", title),
            "medium": medium,
            "creator": updates.get("creator", item.get("creator", "")),
            "year": updates.get("year", item.get("year")),
            "source": "manual",
            "reason": item.get("reason", ""),
            "added_at": now,
            "metadata": metadata,
            "poster_url": poster_url,
            "psychological_tags": {},
            "watch_providers": metadata.get("watch_providers", []),
        }
        db["Watchlist"].insert_one(doc)
        inserted += 1

    print(f"\n{'='*50}")
    print(f"Watchlist import complete")
    print(f"  Inserted: {inserted}")
    print(f"  Skipped:  {skipped}")
    print(f"{'='*50}")


if __name__ == "__main__":
    main()
