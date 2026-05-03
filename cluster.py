"""
K-means clustering over psychological_tags vectors.

Assigns each enriched MediaLogs doc a cluster_id, then calls Claude Haiku
to give each cluster an evocative name and 2-sentence description.
Results stored in ClusterDefs collection.

Run: python3 cluster.py [--k 4]
"""

import json
import os
import sys
from collections import defaultdict

import anthropic
import numpy as np
from bson import ObjectId
from dotenv import load_dotenv
from sklearn.cluster import KMeans

from db import get_db

load_dotenv()

KNOWN_DIMS = [
    "ugt_cognitive", "ugt_affective", "narrative_complexity",
    "tonal_register", "pacing_density", "world_building_depth",
    "character_interiority", "moral_architecture", "diegetic_trust",
    "scope", "humor",
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
}

NAMING_SYSTEM_PROMPT = """You are naming a taste cluster from a personal media library.
You will receive psychological dimension scores for the cluster centroid and a list of example titles.
Return ONLY valid JSON with no preamble, explanation, or markdown fences.
Return format: {"name": "3-5 word evocative name", "description": "Two sentences describing what unifies this taste. Be specific and concrete, not generic."}"""


def main() -> None:
    k = 4
    for i, arg in enumerate(sys.argv[1:]):
        if arg == "--k" and i + 2 < len(sys.argv):
            k = int(sys.argv[i + 2])

    db = get_db()
    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    # Only cluster Tier 1+2 — these define taste, not consumption
    docs = list(db["MediaLogs"].find(
        {"tier": {"$in": [1, 2]}, "psychological_tags": {"$ne": {}}},
        {"_id": 1, "title": 1, "medium": 1, "tier": 1, "psychological_tags": 1},
    ))
    print(f"Loaded {len(docs)} enriched docs")

    # Build feature matrix — only KNOWN_DIMS, normalize 0–1
    ids = []
    matrix = []
    for doc in docs:
        tags = doc.get("psychological_tags") or {}
        row = [(tags.get(dim, 3.0) - 1.0) / 4.0 for dim in KNOWN_DIMS]
        ids.append(doc["_id"])
        matrix.append(row)

    X = np.array(matrix)
    print(f"Feature matrix: {X.shape} | k={k}")

    # K-means
    km = KMeans(n_clusters=k, random_state=42, n_init=10)
    labels = km.fit_predict(X)
    centroids_norm = km.cluster_centers_  # shape (k, n_dims), normalized

    # Clear stale cluster_ids from all docs, then write fresh ones for Tier 1+2
    print("Writing cluster_ids to MediaLogs...")
    db["MediaLogs"].update_many({}, {"$unset": {"cluster_id": ""}})
    for doc_id, label in zip(ids, labels):
        db["MediaLogs"].update_one({"_id": doc_id}, {"$set": {"cluster_id": int(label)}})

    # For each cluster: compute centroid in original scale, find exemplars, call LLM
    print(f"\nNaming {k} clusters via Claude Haiku...")
    for cluster_id in range(k):
        # Centroid in 1–5 scale
        centroid_norm = centroids_norm[cluster_id]
        centroid = {dim: round(float(v) * 4.0 + 1.0, 2) for dim, v in zip(KNOWN_DIMS, centroid_norm)}

        # Find all docs in this cluster
        mask = labels == cluster_id
        cluster_doc_ids = [ids[i] for i, m in enumerate(mask) if m]
        size = len(cluster_doc_ids)

        # Find top 10 exemplars: lowest L2 distance to centroid
        cluster_indices = [i for i, m in enumerate(mask) if m]
        distances = np.linalg.norm(X[cluster_indices] - centroid_norm, axis=1)
        top_indices = np.argsort(distances)[:10]
        top_doc_ids = [cluster_doc_ids[i] for i in top_indices]
        exemplar_titles = [docs[cluster_indices[i]]["title"] for i in top_indices]

        # Build centroid string for prompt
        centroid_str = "\n".join(
            f"  {DIMENSION_LABELS[d]}: {centroid[d]:.1f}"
            for d in KNOWN_DIMS
        )
        titles_str = "\n".join(f"  - {t}" for t in exemplar_titles)

        user_msg = (
            f"Dimension centroid (1.0 low → 5.0 high):\n{centroid_str}\n\n"
            f"Top titles in this cluster:\n{titles_str}"
        )

        try:
            msg = client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=256,
                system=NAMING_SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_msg}],
            )
            raw = msg.content[0].text.strip()
            if raw.startswith("```"):
                raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
            result = json.loads(raw)
            name = result["name"]
            description = result["description"]
        except Exception as exc:
            name = f"Cluster {cluster_id}"
            description = f"(naming failed: {exc})"

        print(f"\n  Cluster {cluster_id} ({size} items): {name}")
        print(f"    {description}")

        db["ClusterDefs"].update_one(
            {"cluster_id": cluster_id},
            {"$set": {
                "cluster_id": cluster_id,
                "name": name,
                "description": description,
                "centroid": centroid,
                "size": size,
                "exemplar_ids": [str(eid) for eid in top_doc_ids],
            }},
            upsert=True,
        )

    print(f"\n{'='*50}")
    print(f"Clustering complete: {k} clusters, {len(docs)} docs assigned")
    print(f"{'='*50}")


if __name__ == "__main__":
    main()
