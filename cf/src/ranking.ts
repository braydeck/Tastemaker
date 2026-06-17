// Binary-search tier ranking math, ported from /log/submit + /log/compare.

// Given the ranks of the currently-ordered comparison pool and the final
// insertion position `pos`, compute the new item's rank_in_tier as a float
// (midpoint between neighbors, or just outside the ends).
export function computeFinalRank(orderedRanks: number[], pos: number): number {
  const n = orderedRanks.length;
  if (pos === 0) return orderedRanks[0] - 1.0;
  if (pos >= n) return orderedRanks[n - 1] + 1.0;
  return (orderedRanks[pos - 1] + orderedRanks[pos]) / 2;
}

export interface CompareState {
  low: number;
  high: number;
  rankedIds: string[];
}

// Apply a single comparison result to the binary-search bounds.
// `mid` is computed as floor((low + high) / 2) before the call.
export function applyCompareResult(
  state: CompareState,
  mid: number,
  result: "na" | "better" | "worse"
): CompareState {
  let { low, high, rankedIds } = state;
  if (result === "na") {
    rankedIds = [...rankedIds.slice(0, mid), ...rankedIds.slice(mid + 1)];
    high = high - 1;
  } else if (result === "better") {
    high = mid;
  } else {
    low = mid + 1;
  }
  return { low, high, rankedIds };
}
