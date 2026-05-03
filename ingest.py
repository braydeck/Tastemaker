"""
CSV ingestion script for Tastemaker.

Supported sources (auto-detected by column headers):
  - Letterboxd export  → medium="movie"
  - StoryGraph export  → medium="book"
  - TV shows list      → medium="tv"  (Name,Tier,Streaming,Status)

Drop CSV files into the exports/ directory, then run:
    python ingest.py
"""

import csv
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

from db import get_db

load_dotenv()

EXPORTS_DIR = Path(__file__).parent / "exports"


# ---------------------------------------------------------------------------
# Tier mapping
# ---------------------------------------------------------------------------

def rating_to_tier(rating: float | None) -> int | None:
    if rating is None:
        return None
    if rating >= 5.0:
        return 1
    if rating >= 4.5:
        return 2
    if rating >= 4.0:
        return 3
    if rating >= 3.0:
        return 4
    return 5


def parse_float(value: str) -> float | None:
    try:
        return float(value.strip()) if value and value.strip() else None
    except ValueError:
        return None


def parse_int(value: str) -> int | None:
    try:
        return int(value.strip()) if value and value.strip() else None
    except ValueError:
        return None


def parse_date(value: str, fmt: str) -> datetime | None:
    try:
        return datetime.strptime(value.strip(), fmt).replace(tzinfo=timezone.utc)
    except (ValueError, AttributeError):
        return None


# ---------------------------------------------------------------------------
# Source detection
# ---------------------------------------------------------------------------

def detect_source(headers: list[str]) -> str | None:
    h = {h.strip() for h in headers}
    if "Letterboxd URI" in h:
        return "letterboxd"
    if "Read Status" in h or "Star Rating" in h:
        return "storygraph"
    if "Streaming" in h and "Name" in h and "Tier" in h:
        return "tvlist"
    return None


# ---------------------------------------------------------------------------
# Document builders
# ---------------------------------------------------------------------------

def build_base_doc(title: str, creator: str, medium: str,
                   year: int | None, rating: float | None,
                   date_logged: datetime | None) -> dict:
    return {
        "title": title,
        "creator": creator,
        "medium": medium,
        "year": year,
        "original_rating": rating,
        "tier": rating_to_tier(rating),
        "date_logged": date_logged or datetime.now(tz=timezone.utc),
        "metadata_enriched": False,
        "metadata": {},
        "psychological_tags": {},
        "rank_in_tier": None,
        "enrichment_error": None,
    }


def ingest_letterboxd(reader: csv.DictReader) -> list[dict]:
    """
    Columns: Date, Name, Year, Letterboxd URI, Rating
    All entries → medium="movie"
    """
    docs = []
    for row in reader:
        title = row.get("Name", "").strip()
        if not title:
            continue
        rating = parse_float(row.get("Rating", ""))
        year = parse_int(row.get("Year", ""))
        date_logged = parse_date(row.get("Date", ""), "%Y-%m-%d")
        docs.append(build_base_doc(
            title=title,
            creator="",
            medium="movie",
            year=year,
            rating=rating,
            date_logged=date_logged,
        ))
    return docs


def ingest_storygraph(reader: csv.DictReader) -> list[dict]:
    """
    Columns include: Title, Authors, Read Status, Star Rating, Date Added, Last Date Read
    Only ingest rows where Read Status == "read".
    Null Star Rating → flagged (tier=None) but still ingested per execution rule 5.
    """
    docs = []
    for row in reader:
        if row.get("Read Status", "").strip().lower() != "read":
            continue
        title = row.get("Title", "").strip()
        if not title:
            continue
        creator = row.get("Authors", "").strip()
        rating = parse_float(row.get("Star Rating", ""))
        # Prefer Last Date Read; fall back to Date Added
        date_logged = (
            parse_date(row.get("Last Date Read", ""), "%Y/%m/%d")
            or parse_date(row.get("Date Added", ""), "%Y/%m/%d")
        )
        docs.append(build_base_doc(
            title=title,
            creator=creator,
            medium="book",
            year=None,
            rating=rating,
            date_logged=date_logged,
        ))
    return docs


def ingest_tvlist(reader: csv.DictReader) -> list[dict]:
    """
    Columns: Name, Tier, Streaming, Status
    Tier is pre-assigned (1–4); no star rating available.
    """
    docs = []
    for row in reader:
        title = row.get("Name", "").strip()
        if not title:
            continue
        tier_raw = parse_int(row.get("Tier", ""))
        doc = build_base_doc(
            title=title,
            creator="",
            medium="tv",
            year=None,
            rating=None,
            date_logged=None,
        )
        # Tier is directly assigned — override the rating-derived null
        doc["tier"] = tier_raw
        docs.append(doc)
    return docs


# ---------------------------------------------------------------------------
# Upsert + summary tracking
# ---------------------------------------------------------------------------

def upsert_docs(collection, docs: list[dict]) -> tuple[int, int, int]:
    """Returns (inserted, skipped, null_rating_flagged)."""
    inserted = skipped = null_flagged = 0
    for doc in docs:
        result = collection.update_one(
            {"title": doc["title"], "medium": doc["medium"]},
            {"$setOnInsert": doc},
            upsert=True,
        )
        if result.upserted_id:
            inserted += 1
            if doc["original_rating"] is None and doc["tier"] is None:
                null_flagged += 1
        else:
            skipped += 1
    return inserted, skipped, null_flagged


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    db = get_db()
    collection = db["MediaLogs"]

    csv_files = list(EXPORTS_DIR.glob("*.csv"))
    if not csv_files:
        print(f"No CSV files found in {EXPORTS_DIR}/")
        print("Drop your Letterboxd, StoryGraph, or TV shows CSV exports there and re-run.")
        sys.exit(0)

    total_processed = total_inserted = total_skipped = total_null_flagged = 0

    for csv_path in csv_files:
        print(f"\nProcessing: {csv_path.name}")
        with open(csv_path, newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            headers = reader.fieldnames or []
            source = detect_source(headers)

            if source is None:
                print(f"  Unrecognized format — headers: {headers[:6]}. Skipping.")
                continue

            if source == "letterboxd":
                docs = ingest_letterboxd(reader)
                label = "Letterboxd (movie)"
            elif source == "storygraph":
                docs = ingest_storygraph(reader)
                label = "StoryGraph (book)"
            else:
                docs = ingest_tvlist(reader)
                label = "TV list (tv)"

        inserted, skipped, null_flagged = upsert_docs(collection, docs)
        processed = len(docs)

        print(f"  Source:       {label}")
        print(f"  Processed:    {processed}")
        print(f"  Inserted:     {inserted}")
        print(f"  Skipped:      {skipped}  (already in DB)")
        if null_flagged:
            print(f"  Null-rating:  {null_flagged}  (flagged for review — tier=None)")

        total_processed += processed
        total_inserted += inserted
        total_skipped += skipped
        total_null_flagged += null_flagged

    print("\n" + "=" * 50)
    print("Ingestion complete")
    print(f"  Total processed:   {total_processed}")
    print(f"  Total inserted:    {total_inserted}")
    print(f"  Total skipped:     {total_skipped}")
    if total_null_flagged:
        print(f"  Null-rating docs:  {total_null_flagged}  (tier=None, enrichment_error=None)")
    print("=" * 50)


if __name__ == "__main__":
    main()
