import { html, raw, View } from "./layout";
import type { Doc } from "../db";
import { mediumDot } from "../constants";

// discover.html
export function Discover(clusterDefs: Doc[], preselectCluster: number): View {
  const mediumButtons: [string, string][] = [
    ["Anything", ""],
    ["Movies", "movie"],
    ["TV", "tv"],
    ["Books", "book"],
    ["Games", "game"],
  ];
  const spinner = html`<svg x-show="generating" class="animate-spin w-4 h-4 flex-shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>`;
  return html`<div class="max-w-3xl mx-auto">
  <div class="mb-8">
    <h1 class="text-2xl font-semibold mb-1">Discover</h1>
    <p class="text-neutral-400 text-sm">Find new things to watch, read, or play.</p>
  </div>

  <div x-data="{
    mode: '${preselectCluster >= 0 ? "cluster" : "seed"}',
    targetMedium: '',
    generating: false,
    selectedSeeds: [],
    selectedCluster: ${preselectCluster},
    searchQuery: '',
    searchResults: [],
    async doSearch() {
      if (this.searchQuery.length < 2) { this.searchResults = []; return; }
      const r = await fetch('/api/library-search?q=' + encodeURIComponent(this.searchQuery));
      this.searchResults = await r.json();
    },
    toggleSeed(item) {
      const idx = this.selectedSeeds.findIndex(s => s.id === item.id);
      if (idx >= 0) { this.selectedSeeds.splice(idx, 1); }
      else if (this.selectedSeeds.length < 5) { this.selectedSeeds.push(item); this.searchQuery = ''; this.searchResults = []; }
    },
    removeSeed(id) { this.selectedSeeds = this.selectedSeeds.filter(s => s.id !== id); },
    isSeedSelected(id) { return this.selectedSeeds.some(s => s.id === id); },
    seedIdsValue() { return this.selectedSeeds.map(s => s.id).join(','); }
  }" @keydown.escape="searchResults = []" @htmx:after-swap.window="generating = false">

    <div class="flex gap-2 mb-5">
      <button @click="mode = 'seed'" :class="mode === 'seed' ? 'bg-white text-black' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'" class="px-4 py-1.5 rounded-full text-sm font-medium transition-colors">Seed titles</button>
      <button @click="mode = 'cluster'" :class="mode === 'cluster' ? 'bg-white text-black' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'" class="px-4 py-1.5 rounded-full text-sm font-medium transition-colors">By cluster</button>
    </div>

    <div class="flex items-center gap-2 mb-6">
      <span class="text-xs text-neutral-600">Looking for:</span>
      ${mediumButtons.map(
        ([label, value]) => html`<button @click="targetMedium = '${value}'" :class="targetMedium === '${value}' ? 'bg-white text-black' : 'bg-neutral-900 text-neutral-400 hover:text-neutral-200 border border-neutral-800'" class="px-3 py-1 rounded-full text-xs font-medium transition-colors">${label}</button>`
      )}
    </div>

    <div x-show="mode === 'seed'">
      <p class="text-sm text-neutral-500 mb-4">Pick up to 5 titles from your library. Recommendations will match their style and feel.</p>
      <div class="relative mb-4">
        <input type="text" x-model="searchQuery" @input.debounce.300ms="doSearch()" placeholder="Search your library..." class="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:outline-none focus:border-neutral-500">
        <div x-show="searchResults.length > 0" class="absolute z-10 w-full mt-1 bg-neutral-800 border border-neutral-700 rounded-lg overflow-hidden shadow-xl max-h-64 overflow-y-auto">
          <template x-for="item in searchResults" :key="item.id">
            <button type="button" @click="toggleSeed(item)" :class="isSeedSelected(item.id) ? 'bg-neutral-700' : 'hover:bg-neutral-700'" class="w-full flex items-center gap-3 px-3 py-2 text-left border-b border-neutral-700 last:border-0 transition-colors">
              <template x-if="item.poster_url"><img :src="item.poster_url" class="w-6 h-9 object-cover rounded flex-shrink-0"></template>
              <template x-if="!item.poster_url"><div class="w-6 h-9 bg-neutral-700 rounded flex-shrink-0"></div></template>
              <span class="flex-1 text-sm text-white truncate" x-text="item.title"></span>
              <span class="text-xs text-neutral-500 flex-shrink-0 capitalize" x-text="item.medium"></span>
              <span x-show="isSeedSelected(item.id)" class="text-emerald-400 text-xs flex-shrink-0">✓</span>
            </button>
          </template>
        </div>
      </div>
      <div x-show="selectedSeeds.length > 0" class="flex flex-wrap gap-2 mb-5">
        <template x-for="seed in selectedSeeds" :key="seed.id">
          <div class="flex items-center gap-2 pl-1 pr-2 py-1 bg-neutral-800 border border-neutral-700 rounded-full">
            <template x-if="seed.poster_url"><img :src="seed.poster_url" class="w-5 h-7 object-cover rounded-full flex-shrink-0"></template>
            <span class="text-xs text-white" x-text="seed.title"></span>
            <button @click="removeSeed(seed.id)" class="text-neutral-500 hover:text-white text-xs ml-0.5">✕</button>
          </div>
        </template>
        <span x-show="selectedSeeds.length >= 5" class="text-xs text-neutral-600 self-center">(max 5)</span>
      </div>
      <form hx-post="/discover/generate" hx-target="#discover-results" hx-swap="innerHTML" @submit="generating = true">
        <input type="hidden" name="mode" value="seed">
        <input type="hidden" name="seed_ids" :value="seedIdsValue()">
        <input type="hidden" name="target_medium" :value="targetMedium">
        <button type="submit" :disabled="selectedSeeds.length === 0 || generating" :class="selectedSeeds.length === 0 || generating ? 'opacity-40 cursor-not-allowed' : 'hover:bg-neutral-200'" class="flex items-center gap-2 px-5 py-2.5 bg-white text-black text-sm font-semibold rounded-lg transition-colors">
          ${spinner}
          <span x-text="generating ? 'Generating...' : 'Generate recommendations'"></span>
        </button>
      </form>
    </div>

    <div x-show="mode === 'cluster'">
      <p class="text-sm text-neutral-500 mb-4">Pick a taste cluster to get recommendations that match that facet of your taste.</p>
      ${clusterDefs.length
        ? html`<div class="space-y-3 mb-5">
        ${clusterDefs.map(
          (cd) => html`<div @click="selectedCluster = ${cd.cluster_id}" :class="selectedCluster === ${cd.cluster_id} ? 'border-white' : 'border-neutral-800 hover:border-neutral-600'" class="p-4 border rounded-xl cursor-pointer transition-colors">
          <div class="flex items-start gap-4">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <div :class="selectedCluster === ${cd.cluster_id} ? 'bg-white' : 'bg-neutral-700'" class="w-2 h-2 rounded-full flex-shrink-0 transition-colors"></div>
                <h3 class="text-sm font-semibold">${cd.name}</h3>
                <span class="text-xs text-neutral-600">${cd.size} titles</span>
              </div>
              <p class="text-xs text-neutral-500 leading-relaxed">${cd.description}</p>
            </div>
            <div class="flex gap-1.5 flex-shrink-0">
              ${(cd.exemplars ?? []).map((ex: Doc) =>
                ex.poster_url
                  ? html`<img src="${ex.poster_url}" title="${ex.title}" class="w-7 h-10 object-cover rounded">`
                  : ""
              )}
            </div>
          </div>
        </div>`
        )}
      </div>
      <form hx-post="/discover/generate" hx-target="#discover-results" hx-swap="innerHTML" @submit="generating = true">
        <input type="hidden" name="mode" value="cluster">
        <input type="hidden" name="cluster_id" :value="selectedCluster">
        <input type="hidden" name="target_medium" :value="targetMedium">
        <button type="submit" :disabled="selectedCluster < 0 || generating" :class="selectedCluster < 0 || generating ? 'opacity-40 cursor-not-allowed' : 'hover:bg-neutral-200'" class="flex items-center gap-2 px-5 py-2.5 bg-white text-black text-sm font-semibold rounded-lg transition-colors">
          ${spinner}
          <span x-text="generating ? 'Generating...' : 'Generate recommendations'"></span>
        </button>
      </form>`
        : html`<div class="p-6 border border-neutral-800 rounded-xl text-neutral-500 text-sm">No clusters yet. Run the clustering job to generate taste clusters.</div>`}
    </div>

    <div x-show="generating" x-cloak class="mt-8 flex items-center gap-3 py-12 text-neutral-500">
      <svg class="animate-spin w-5 h-5 flex-shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
      <span class="text-sm">Asking Claude for recommendations...</span>
    </div>

    <div id="discover-results" class="mt-8" x-show="!generating" x-cloak></div>

    <div class="mt-12 pt-6 border-t border-neutral-800">
      <a href="/discover/blacklist" class="text-xs text-neutral-600 hover:text-neutral-400 transition-colors">Manage "Not interested" list →</a>
    </div>
  </div>
</div>`;
}

// partials/discover_results.html
export function DiscoverResults(recs: Doc[], filteredOut: string[], recSource: string): View {
  if (!recs.length) {
    return filteredOut.length
      ? html`<div class="text-sm text-neutral-500 space-y-2">
  <p>All ${filteredOut.length} suggestions were already in your library, watchlist, or "not interested" list.</p>
  <details class="text-xs text-neutral-600">
    <summary class="cursor-pointer hover:text-neutral-400 transition-colors">Show filtered titles</summary>
    <ul class="mt-2 space-y-0.5 pl-2">${filteredOut.map((t) => html`<li>${t}</li>`)}</ul>
  </details>
  <p class="text-xs">Try generating again — Claude will pick different titles.</p>
</div>`
      : html`<p class="text-neutral-500 text-sm">No recommendations generated.</p>`;
  }
  return html`<div class="space-y-3">
  <p class="text-xs text-neutral-600 mb-4">${recs.length} recommendations — add the ones you want to your Watchlist.</p>
  ${recs.map((rec, i) => {
    const idx = i + 1;
    const providers: any[] = rec.watch_providers ?? [];
    const metaId = rec.metadata?.id ?? 0;
    const tmdbId = rec.medium === "movie" || rec.medium === "tv" ? metaId || 0 : 0;
    const igdbId = rec.medium === "game" ? metaId || 0 : 0;
    return html`<div id="rec-${idx}" class="flex items-center gap-3 p-3 border border-neutral-800 rounded-lg">
    ${rec.poster_url
      ? html`<img src="${rec.poster_url}" alt="${rec.title}" class="w-8 h-12 object-cover rounded flex-shrink-0">`
      : html`<div class="w-8 h-12 bg-neutral-800 rounded flex-shrink-0 flex items-center justify-center"><span class="w-2 h-2 rounded-full ${mediumDot(rec.medium)}"></span></div>`}
    <div class="flex-1 min-w-0">
      <p class="font-medium text-sm truncate">${rec.title}</p>
      <p class="text-xs text-neutral-500 capitalize">${rec.medium}${rec.creator ? html` · ${rec.creator}` : ""}${rec.year ? html` · ${rec.year}` : ""}${rec.rating_score ? html` · <span class="text-neutral-400">★ ${Number(rec.rating_score).toFixed(1)}</span>` : ""}</p>
      ${rec.reason ? html`<p class="text-xs text-neutral-400 mt-0.5 leading-relaxed">${rec.reason}</p>` : ""}
      ${providers.length
        ? html`<div x-data="{ showNames: false }" class="mt-1.5">
        <div class="flex items-center gap-1.5 cursor-pointer" @click="showNames = !showNames" title="Click to see names">
          ${providers.map((p) => html`<img src="https://image.tmdb.org/t/p/w45${p.logo_path}" alt="${p.name}" class="w-5 h-5 rounded object-cover flex-shrink-0">`)}
        </div>
        <div x-show="showNames" x-cloak class="flex flex-wrap gap-1 mt-1.5">
          ${providers.map((p) => html`<span class="text-xs text-neutral-400 bg-neutral-800 px-1.5 py-0.5 rounded whitespace-nowrap">${p.type === "buy" ? html`<span class="text-neutral-600">buy · </span>` : ""}${p.name}</span>`)}
        </div>
      </div>`
        : ""}
    </div>
    <div class="flex-shrink-0 flex flex-col gap-1.5">
      <span id="rec-wl-${idx}">
        <form hx-post="/watchlist/add" hx-target="#rec-wl-${idx}" hx-swap="innerHTML">
          <input type="hidden" name="title" value="${rec.title}">
          <input type="hidden" name="medium" value="${rec.medium}">
          <input type="hidden" name="reason" value="${rec.reason ?? ""}">
          <input type="hidden" name="sel_poster_url" value="${rec.poster_url ?? ""}">
          <input type="hidden" name="rating_score" value="${rec.rating_score ?? ""}">
          <input type="hidden" name="tmdb_id" value="${tmdbId}">
          <input type="hidden" name="igdb_id" value="${igdbId}">
          <input type="hidden" name="rec_source" value="${recSource}">
          <button type="submit" class="w-full px-3 py-1.5 text-xs font-medium bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg transition-colors whitespace-nowrap">+ Watchlist</button>
        </form>
      </span>
      <span id="rec-lib-${idx}">
        <form hx-post="/library/add" hx-target="#rec-lib-${idx}" hx-swap="innerHTML">
          <input type="hidden" name="title" value="${rec.title}">
          <input type="hidden" name="medium" value="${rec.medium}">
          <input type="hidden" name="reason" value="${rec.reason ?? ""}">
          <input type="hidden" name="sel_poster_url" value="${rec.poster_url ?? ""}">
          <button type="submit" class="w-full px-3 py-1.5 text-xs font-medium bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 rounded-lg transition-colors whitespace-nowrap text-neutral-400">+ Library</button>
        </form>
      </span>
      <form hx-post="/discover/blacklist" hx-target="#rec-${idx}" hx-swap="outerHTML">
        <input type="hidden" name="title" value="${rec.title}">
        <input type="hidden" name="medium" value="${rec.medium}">
        <button type="submit" class="w-full px-3 py-1.5 text-xs font-medium bg-transparent hover:bg-neutral-900 border border-neutral-800 rounded-lg transition-colors whitespace-nowrap text-neutral-600 hover:text-neutral-400">Not interested</button>
      </form>
    </div>
  </div>`;
  })}
</div>`;
}

// blacklist.html
export function Blacklist(items: Doc[]): View {
  return html`<div class="max-w-2xl">
  <div class="flex items-center justify-between mb-6">
    <div>
      <h1 class="text-xl font-semibold">Not Interested</h1>
      <p class="text-sm text-neutral-500 mt-1">Titles hidden from Discover recommendations. Remove any you've changed your mind about.</p>
    </div>
    <a href="/discover" class="text-sm text-neutral-400 hover:text-white transition-colors">← Back to Discover</a>
  </div>

  ${!items.length
    ? html`<p class="text-sm text-neutral-500">Nothing here yet. Click "Not interested" on any recommendation to hide it.</p>`
    : html`<div id="blacklist-items" class="space-y-2">
    ${items.map(
      (item) => html`<div id="bl-${item._id}" class="flex items-center justify-between px-4 py-3 border border-neutral-800 rounded-lg">
      <div>
        <p class="text-sm font-medium">${item.title}</p>
        <p class="text-xs text-neutral-500 capitalize">${item.medium}</p>
      </div>
      <form hx-post="/discover/blacklist/remove/${item._id}" hx-target="#bl-${item._id}" hx-swap="outerHTML">
        <button type="submit" class="px-3 py-1.5 text-xs font-medium text-neutral-400 hover:text-white border border-neutral-700 hover:border-neutral-500 rounded-lg transition-colors">Remove</button>
      </form>
    </div>`
    )}
  </div>
  <p class="text-xs text-neutral-600 mt-4">${items.length} title${items.length !== 1 ? "s" : ""}</p>`}
</div>`;
}
