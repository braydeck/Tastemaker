import { html, View } from "./layout";
import { mediumDot } from "../constants";

export interface DimRow {
  key: string;
  label: string;
  definition: string;
  loved: number | null;
  disliked: number | null;
  delta: number | null;
  bar_pct: number;
}
export interface CentroidRow {
  label: string;
  score: number;
  bar_pct: number;
}
export interface ProfileCluster {
  cluster_id: number;
  name: string;
  description: string;
  size: number;
  exemplars: any[];
  centroid_rows: CentroidRow[];
}
export interface VoteRow {
  label: string;
  most: number;
  least: number;
}

export function Profile(opts: {
  clusters: ProfileCluster[];
  byScore: DimRow[];
  byDelta: DimRow[];
  clusterRows: VoteRow[];
  total: number;
  tierCounts: Record<number, number>;
  enriched: number;
  lovedCount: number;
}): View {
  const { clusters, byScore, byDelta, clusterRows, total, tierCounts, enriched, lovedCount } = opts;

  const deltaBadge = (delta: number): View => {
    const v = `Δ ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`;
    if (delta >= 0.5) return html`<span class="text-xs font-mono tabular-nums text-emerald-400 flex-shrink-0">${v}</span>`;
    if (delta >= 0.2) return html`<span class="text-xs font-mono tabular-nums text-yellow-500 flex-shrink-0">${v}</span>`;
    if (delta >= 0) return html`<span class="text-xs font-mono tabular-nums text-neutral-600 flex-shrink-0">${v}</span>`;
    return html`<span class="text-xs font-mono tabular-nums text-red-400 flex-shrink-0">${v}</span>`;
  };

  return html`<div class="max-w-4xl mx-auto">

  <div class="mb-10">
    <h1 class="text-2xl font-semibold mb-2">Taste Profile</h1>
    <div class="flex flex-wrap gap-3 text-xs text-neutral-500">
      <span class="px-2.5 py-1 bg-neutral-800 rounded-full">${total} logged</span>
      <span class="px-2.5 py-1 bg-neutral-800 rounded-full">${tierCounts[1] ?? 0} Tier 1</span>
      <span class="px-2.5 py-1 bg-neutral-800 rounded-full">${tierCounts[2] ?? 0} Tier 2</span>
      <span class="px-2.5 py-1 bg-neutral-800 rounded-full">${enriched} profiled</span>
      <span class="px-2.5 py-1 bg-neutral-800 rounded-full">${lovedCount} used for taste model</span>
    </div>
  </div>

  ${clusters.length
    ? html`<section class="mb-12">
    <h2 class="text-xs font-semibold text-neutral-500 uppercase tracking-widest mb-6">Your Taste Clusters</h2>
    <p class="text-sm text-neutral-500 mb-6 -mt-4">Natural facets found in your library via k-means clustering. Your taste isn't one thing.</p>
    <div class="space-y-6">
      ${clusters.map(
        (cluster) => html`<div class="border border-neutral-800 rounded-xl p-5 hover:border-neutral-700 transition-colors">
        <div class="flex items-start justify-between gap-4 mb-4">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-3 mb-1">
              <h3 class="text-lg font-semibold">${cluster.name}</h3>
              <span class="text-xs text-neutral-600 flex-shrink-0">${cluster.size} titles</span>
            </div>
            <p class="text-sm text-neutral-400 leading-relaxed">${cluster.description}</p>
          </div>
          <div class="flex flex-col gap-2 flex-shrink-0">
            <a href="/discover?cluster=${cluster.cluster_id}" class="px-3 py-1.5 text-xs font-medium bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg transition-colors whitespace-nowrap text-center">Recommend from this →</a>
            <a href="/?cluster_id=${cluster.cluster_id}" class="px-3 py-1.5 text-xs font-medium bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 rounded-lg transition-colors whitespace-nowrap text-center text-neutral-400">Browse library →</a>
          </div>
        </div>
        <div class="flex gap-6">
          <div class="flex gap-2 flex-shrink-0">
            ${cluster.exemplars.map(
              (ex) => html`<a href="/item/${ex._id}" class="group">
              ${ex.poster_url
                ? html`<img src="${ex.poster_url}" alt="${ex.title}" title="${ex.title}" class="w-10 h-14 object-cover rounded shadow-md group-hover:opacity-80 transition-opacity">`
                : html`<div class="w-10 h-14 bg-neutral-800 rounded flex items-center justify-center"><span class="w-2 h-2 rounded-full ${mediumDot(ex.medium)}"></span></div>`}
            </a>`
            )}
          </div>
          <div class="flex-1 space-y-1.5 min-w-0">
            ${cluster.centroid_rows.slice(0, 5).map(
              (row) => html`<div class="flex items-center gap-2">
              <span class="text-xs text-neutral-500 w-32 flex-shrink-0 truncate">${row.label}</span>
              <div class="flex-1 h-1 bg-neutral-800 rounded-full overflow-hidden"><div class="h-full bg-neutral-400 rounded-full" style="width: ${row.bar_pct}%"></div></div>
              <span class="text-xs text-neutral-600 tabular-nums w-6 text-right flex-shrink-0">${row.score.toFixed(1)}</span>
            </div>`
            )}
          </div>
        </div>
      </div>`
      )}
    </div>
  </section>`
    : html`<div class="mb-12 p-6 border border-neutral-800 rounded-xl text-neutral-500 text-sm">No clusters yet. Run the clustering job to generate taste clusters.</div>`}

  <section class="mb-12">
    <h2 class="text-xs font-semibold text-neutral-500 uppercase tracking-widest mb-6">Overall Dimension Profile</h2>
    <p class="text-sm text-neutral-500 mb-6 -mt-4">Average scores across your Tier 1 + Tier 2 items.</p>
    <div class="space-y-3">
      ${byScore.map(
        (row) => html`<div>
        <div class="flex items-baseline justify-between mb-1">
          <div>
            <span class="text-sm text-neutral-300">${row.label}</span>
            <span class="text-xs text-neutral-600 ml-2">${row.definition}</span>
          </div>
          <span class="text-sm tabular-nums text-neutral-400 ml-4 flex-shrink-0">${(row.loved ?? 0).toFixed(2)}</span>
        </div>
        <div class="h-1.5 bg-neutral-800 rounded-full overflow-hidden"><div class="h-full bg-neutral-400 rounded-full" style="width: ${row.bar_pct}%"></div></div>
      </div>`
      )}
    </div>
  </section>

  ${byDelta.length
    ? html`<section class="mb-12">
    <h2 class="text-xs font-semibold text-neutral-500 uppercase tracking-widest mb-6">Signal Strength</h2>
    <p class="text-sm text-neutral-500 mb-6 -mt-4">Which dimensions most distinguish what you love from what doesn't work. High delta = strong predictor of enjoyment.</p>
    <div class="divide-y divide-neutral-900">
      ${byDelta.map(
        (row) => html`<div class="flex items-center justify-between py-2.5 gap-4">
        <span class="text-sm text-neutral-300 w-44 flex-shrink-0">${row.label}</span>
        <div class="flex items-center gap-3 flex-1 min-w-0 text-xs text-neutral-500">
          <span>Loved: <span class="text-neutral-300 tabular-nums">${(row.loved ?? 0).toFixed(2)}</span></span>
          <span>·</span>
          <span>Didn't Work: <span class="text-neutral-300 tabular-nums">${(row.disliked ?? 0).toFixed(2)}</span></span>
        </div>
        ${deltaBadge(row.delta ?? 0)}
      </div>`
      )}
    </div>
    <p class="text-xs text-neutral-600 mt-4">Red or near-zero delta means this dimension doesn't predict enjoyment for you — the model weights it less for recommendations.</p>
  </section>`
    : ""}

  ${clusterRows.length
    ? html`<section class="mb-12">
    <h2 class="text-xs font-semibold text-neutral-500 uppercase tracking-widest mb-6">Explicit Priorities</h2>
    <p class="text-sm text-neutral-500 mb-6 -mt-4">What you said mattered during onboarding (MaxDiff sessions).</p>
    <div class="space-y-2">
      ${clusterRows.map(
        (row) => html`<div class="flex items-center gap-4">
        <span class="text-sm text-neutral-300 w-44 flex-shrink-0">${row.label}</span>
        <div class="flex gap-2">
          ${row.most > 0 ? html`<span class="text-xs px-2 py-0.5 rounded-full bg-emerald-900/40 text-emerald-400">↑${row.most} most</span>` : ""}
          ${row.least > 0 ? html`<span class="text-xs px-2 py-0.5 rounded-full bg-red-900/40 text-red-400">↓${row.least} least</span>` : ""}
        </div>
      </div>`
      )}
    </div>
  </section>`
    : ""}

</div>`;
}
