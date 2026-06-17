// Pure-TS KMeans over psychological_tags vectors, replacing cluster.py's
// scikit-learn KMeans. Same feature construction: 11 KNOWN_DIMS, normalized
// (score - 1) / 4, default 3.0 when a dimension is missing.

import { DIMENSIONS } from "./constants";

const KNOWN_DIMS = DIMENSIONS; // 11 universal dimensions (games' sdt_* excluded, matching cluster.py)

export function buildFeatureRow(tags: Record<string, number> | null | undefined): number[] {
  const t = tags ?? {};
  return KNOWN_DIMS.map((dim) => ((t[dim] ?? 3.0) - 1.0) / 4.0);
}

// Mulberry32 — small deterministic PRNG so clustering is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dist2(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

interface KMeansResult {
  labels: number[];
  centroids: number[][];
  inertia: number;
}

function kmeansOnce(X: number[][], k: number, rng: () => number, maxIter = 300): KMeansResult {
  const n = X.length;
  const dim = X[0].length;

  // Random distinct initial centroids.
  const chosen = new Set<number>();
  const centroids: number[][] = [];
  while (centroids.length < k && chosen.size < n) {
    const idx = Math.floor(rng() * n);
    if (chosen.has(idx)) continue;
    chosen.add(idx);
    centroids.push([...X[idx]]);
  }
  while (centroids.length < k) centroids.push(new Array(dim).fill(0));

  const labels = new Array(n).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist2(X[i], centroids[c]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (labels[i] !== best) {
        labels[i] = best;
        changed = true;
      }
    }
    // Recompute centroids.
    const sums = Array.from({ length: k }, () => new Array(dim).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      counts[labels[i]]++;
      const row = X[i];
      const s = sums[labels[i]];
      for (let d = 0; d < dim; d++) s[d] += row[d];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue; // keep empty cluster's old centroid
      for (let d = 0; d < dim; d++) centroids[c][d] = sums[c][d] / counts[c];
    }
    if (!changed && iter > 0) break;
  }

  let inertia = 0;
  for (let i = 0; i < n; i++) inertia += dist2(X[i], centroids[labels[i]]);
  return { labels, centroids, inertia };
}

// n_init runs, keep the lowest-inertia result (matches sklearn n_init=10).
export function kmeans(X: number[][], k: number, seed = 42, nInit = 10): KMeansResult {
  let best: KMeansResult | null = null;
  for (let init = 0; init < nInit; init++) {
    const rng = mulberry32(seed + init * 1013904223);
    const res = kmeansOnce(X, k, rng);
    if (!best || res.inertia < best.inertia) best = res;
  }
  return best!;
}

// Denormalize a normalized centroid back to the 1–5 scale, keyed by dimension.
export function denormalizeCentroid(centroidNorm: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  KNOWN_DIMS.forEach((dim, i) => {
    out[dim] = Math.round((centroidNorm[i] * 4.0 + 1.0) * 100) / 100;
  });
  return out;
}

// Indices (into the cluster's member list) of the N nearest rows to a centroid.
export function topExemplarIndices(
  memberRows: number[][],
  centroidNorm: number[],
  n = 10
): number[] {
  const dists = memberRows.map((row, i) => ({ i, d: dist2(row, centroidNorm) }));
  dists.sort((a, b) => a.d - b.d);
  return dists.slice(0, n).map((x) => x.i);
}

export { KNOWN_DIMS };
