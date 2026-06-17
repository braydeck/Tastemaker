import { html, raw, View, jsStr } from "./layout";
import type { Doc } from "../db";
import { mediumDot } from "../constants";

interface Provider {
  name: string;
  logo_path: string;
  type?: string;
}

function providersAttr(providers: any[]): View {
  return raw(JSON.stringify(providers ?? []).replace(/'/g, "&#39;"));
}

function providerLogos(providers: Provider[]): View {
  return html`<div x-data="{ showNames: false }" class="mt-1.5">
    <div class="flex items-center gap-1.5 cursor-pointer" @click="showNames = !showNames" title="Click to see names">
      ${providers.map(
        (p) => html`<img src="https://image.tmdb.org/t/p/w45${p.logo_path}" alt="${p.name}" class="w-5 h-5 rounded object-cover flex-shrink-0">`
      )}
    </div>
    <div x-show="showNames" x-cloak class="flex flex-wrap gap-1 mt-1.5">
      ${providers.map(
        (p) => html`<span class="text-xs text-neutral-400 bg-neutral-800 px-1.5 py-0.5 rounded whitespace-nowrap">${p.type === "buy" ? html`<span class="text-neutral-600">buy · </span>` : ""}${p.name}</span>`
      )}
    </div>
  </div>`;
}

// watchlist.html
export function Watchlist(opts: {
  items: Doc[];
  streamProviders: Provider[];
  buyProviders: Provider[];
  allSources: string[];
}): View {
  const { items, streamProviders, buyProviders, allSources } = opts;
  const mediumButtons: [string, string][] = [
    ["All", "all"],
    ["Movies", "movie"],
    ["TV", "tv"],
    ["Books", "book"],
    ["Games", "game"],
  ];

  const providerDropdown = (
    kind: "Stream" | "Buy",
    providers: Provider[],
    selVar: string,
    openVar: string,
    toggleFn: string
  ): View =>
    html`<div class="relative" @click.outside="${openVar} = false">
      <button @click="${openVar} = !${openVar}"
              :class="${selVar}.length ? 'border-neutral-500 text-white' : 'border-neutral-800 text-neutral-400 hover:border-neutral-600'"
              class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs border transition-colors">
        <span>${kind}</span>
        <span x-show="${selVar}.length" x-cloak class="bg-white text-black text-xs font-semibold rounded-full w-4 h-4 flex items-center justify-center" x-text="${selVar}.length"></span>
        <svg class="w-3 h-3 text-neutral-500" :class="${openVar} && 'rotate-180'" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
      </button>
      <div x-show="${openVar}" x-cloak class="absolute top-full mt-1 left-0 z-30 bg-neutral-900 border border-neutral-700 rounded-xl shadow-2xl py-1 min-w-52">
        ${providers.map(
          (p) => html`<label class="flex items-center gap-2.5 px-3 py-2 hover:bg-neutral-800 cursor-pointer">
          <input type="checkbox" :checked="${selVar}.includes('${jsStr(p.name)}')" @change="${toggleFn}('${jsStr(p.name)}')" class="accent-white flex-shrink-0">
          <img src="https://image.tmdb.org/t/p/w45${p.logo_path}" alt="${p.name}" class="w-5 h-5 rounded flex-shrink-0">
          <span class="text-sm text-neutral-300">${p.name}</span>
        </label>`
        )}
        <div x-show="${selVar}.length" x-cloak class="border-t border-neutral-800 mt-1 pt-1 px-3 pb-1">
          <button @click="${selVar} = []; saveFilters()" class="text-xs text-neutral-500 hover:text-white transition-colors">Clear all</button>
        </div>
      </div>
    </div>`;

  return html`<div class="max-w-4xl mx-auto">
  <div class="flex items-start justify-between mb-8 gap-4 flex-wrap">
    <div>
      <h1 class="text-2xl font-semibold mb-1">Watchlist</h1>
      <p class="text-neutral-400 text-sm">Things you want to read, watch, or play.</p>
    </div>

    <div x-data="{
      open: false, query: '', medium: 'movie', results: [], selected: null, loading: false,
      async doSearch() {
        if (this.query.length < 2) { this.results = []; return; }
        this.loading = true;
        try {
          const r = await fetch('/api/search?q=' + encodeURIComponent(this.query) + '&medium=' + this.medium);
          this.results = await r.json();
        } catch(e) { this.results = []; }
        this.loading = false;
      },
      select(item) { this.selected = item; this.query = item.title; this.results = []; },
      reset() { this.query = ''; this.medium = 'movie'; this.results = []; this.selected = null; }
    }" class="flex-shrink-0" @keydown.escape="results = []">
      <button @click="open = !open" class="px-4 py-2 bg-white text-black text-sm font-semibold rounded-lg hover:bg-neutral-200 transition-colors">+ Add</button>
      <div x-show="open" x-cloak class="absolute right-6 mt-2 w-80 bg-neutral-900 border border-neutral-800 rounded-xl shadow-2xl p-4 z-50">
        <form hx-post="/watchlist/add" hx-target="#add-result" hx-swap="innerHTML" @htmx:after-request="open = false; reset()" class="space-y-3">
          <input type="hidden" name="tmdb_id" :value="selected?.tmdb_id || 0">
          <input type="hidden" name="books_id" :value="selected?.books_id || ''">
          <input type="hidden" name="igdb_id" :value="selected?.igdb_id || 0">
          <input type="hidden" name="sel_year" :value="selected?.year || ''">
          <input type="hidden" name="sel_creator" :value="selected?.creator || ''">
          <input type="hidden" name="sel_poster_url" :value="selected?.poster_url || ''">
          <div>
            <label class="block text-xs text-neutral-400 mb-1">Medium</label>
            <select name="medium" x-model="medium" @change="results = []; selected = null" required class="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-neutral-500">
              <option value="movie">Movie</option><option value="tv">TV</option><option value="book">Book</option><option value="game">Game</option>
            </select>
          </div>
          <div class="relative">
            <label class="block text-xs text-neutral-400 mb-1">Title</label>
            <div class="relative">
              <input type="text" name="title" x-model="query" required @input.debounce.400ms="doSearch()" @focus="if (query.length >= 2 && !selected) doSearch()" placeholder="e.g. Severance" class="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:outline-none focus:border-neutral-500 pr-8">
              <span x-show="loading" class="absolute right-2 top-2.5 text-neutral-500 text-xs">⟳</span>
            </div>
            <div x-show="results.length > 0" class="absolute z-10 w-full mt-1 bg-neutral-800 border border-neutral-700 rounded-lg overflow-hidden shadow-xl max-h-60 overflow-y-auto">
              <template x-for="item in results" :key="item.tmdb_id || item.books_id || item.title">
                <button type="button" @click="select(item)" class="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-neutral-700 text-left border-b border-neutral-700 last:border-0">
                  <template x-if="item.poster_url"><img :src="item.poster_url" class="w-6 h-9 object-cover rounded flex-shrink-0"></template>
                  <template x-if="!item.poster_url"><div class="w-6 h-9 bg-neutral-700 rounded flex-shrink-0"></div></template>
                  <div class="flex-1 min-w-0">
                    <p class="text-sm text-white truncate" x-text="item.title"></p>
                    <p class="text-xs text-neutral-500 truncate" x-text="[item.creator, item.year].filter(Boolean).join(' · ')"></p>
                  </div>
                </button>
              </template>
            </div>
          </div>
          <div x-show="selected" class="flex items-center gap-2 p-2 bg-neutral-800 rounded-lg">
            <template x-if="selected?.poster_url"><img :src="selected.poster_url" class="w-6 h-9 object-cover rounded flex-shrink-0"></template>
            <div class="flex-1 min-w-0">
              <p class="text-xs font-medium text-white truncate" x-text="selected?.title"></p>
              <p class="text-xs text-neutral-500" x-text="[selected?.creator, selected?.year].filter(Boolean).join(' · ')"></p>
            </div>
            <button type="button" @click="selected = null" class="text-neutral-600 hover:text-neutral-400 text-xs flex-shrink-0">✕</button>
          </div>
          <div>
            <label class="block text-xs text-neutral-400 mb-1">Reason <span class="text-neutral-600">(optional)</span></label>
            <input type="text" name="reason" placeholder="Why are you interested?" class="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:outline-none focus:border-neutral-500">
          </div>
          <button type="submit" class="w-full py-2 bg-white text-black text-sm font-semibold rounded-lg hover:bg-neutral-200 transition-colors">Add to Watchlist</button>
        </form>
      </div>
    </div>
  </div>

  <div id="add-result" class="mb-4"></div>

  ${items.length
    ? html`<div x-data="{
    filter: 'all', selectedSource: '', selectedStream: [], selectedBuy: [], streamOpen: false, buyOpen: false,
    init() {
      const saved = JSON.parse(localStorage.getItem('wl_provider_filters') || '{}');
      this.selectedStream = saved.selectedStream || [];
      this.selectedBuy = saved.selectedBuy || [];
    },
    saveFilters() { localStorage.setItem('wl_provider_filters', JSON.stringify({ selectedStream: this.selectedStream, selectedBuy: this.selectedBuy })); },
    toggleStream(name) { const i = this.selectedStream.indexOf(name); if (i >= 0) this.selectedStream.splice(i, 1); else this.selectedStream.push(name); this.saveFilters(); },
    toggleBuy(name) { const i = this.selectedBuy.indexOf(name); if (i >= 0) this.selectedBuy.splice(i, 1); else this.selectedBuy.push(name); this.saveFilters(); }
  }" class="mb-4">

    <div class="flex gap-2 flex-wrap mb-3">
      ${mediumButtons.map(
        ([label, value]) => html`<button @click="filter = '${value}'" :class="filter === '${value}' ? 'bg-white text-black' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'" class="px-3 py-1 rounded-full text-xs font-medium transition-colors">${label}</button>`
      )}
    </div>

    ${allSources.length
      ? html`<div class="flex items-center gap-2 flex-wrap mb-3">
      <span class="text-xs text-neutral-600">Discovered via:</span>
      ${allSources.map(
        (src) => html`<button @click="selectedSource = selectedSource === '${jsStr(src)}' ? '' : '${jsStr(src)}'" :class="selectedSource === '${jsStr(src)}' ? 'bg-neutral-700 text-white border-neutral-500' : 'text-neutral-400 border-neutral-800 hover:border-neutral-600'" class="px-2.5 py-1 rounded-full text-xs border transition-colors">${src}</button>`
      )}
    </div>`
      : ""}

    ${streamProviders.length || buyProviders.length
      ? html`<div class="flex items-center gap-2 flex-wrap mb-4">
      <span class="text-xs text-neutral-600">Available on:</span>
      ${streamProviders.length ? providerDropdown("Stream", streamProviders, "selectedStream", "streamOpen", "toggleStream") : ""}
      ${buyProviders.length ? providerDropdown("Buy", buyProviders, "selectedBuy", "buyOpen", "toggleBuy") : ""}
    </div>`
      : ""}

    <div class="space-y-2">
      ${items.map((item) => {
        const providers: Provider[] = item.watch_providers ?? [];
        const r = item.rating_score ?? item.metadata?.vote_average ?? item.metadata?.averageRating;
        return html`<div id="wl-${item._id}"
           data-providers='${providersAttr(providers)}'
           x-show="(filter === 'all' || filter === '${item.medium}') &&
                   (selectedStream.length === 0 && selectedBuy.length === 0 ||
                    JSON.parse($el.dataset.providers).some(p =>
                      ((p.type || 'stream') === 'stream' && selectedStream.includes(p.name)) ||
                      (p.type === 'buy' && selectedBuy.includes(p.name)))) &&
                   (selectedSource === '' || '${jsStr(item.rec_source || "")}' === selectedSource)"
           class="flex items-center gap-4 p-3 border border-neutral-800 rounded-lg hover:border-neutral-700 transition-colors">
        ${item.poster_url
          ? html`<img src="${item.poster_url}" alt="${item.title}" class="w-8 h-12 object-cover rounded flex-shrink-0">`
          : html`<div class="w-8 h-12 bg-neutral-800 rounded flex-shrink-0 flex items-center justify-center"><span class="w-2 h-2 rounded-full ${mediumDot(item.medium)}"></span></div>`}
        <div class="flex-1 min-w-0">
          <p class="font-medium text-sm truncate">${item.title}</p>
          <p class="text-xs text-neutral-500 capitalize">
            ${item.medium}${item.creator ? html` · ${item.creator}` : ""}${item.year ? html` · ${item.year}` : ""}${r ? html` · <span class="text-neutral-400">★ ${Number(r).toFixed(1)}</span>` : ""}${item.source === "llm_recommendation" ? html` · <span class="text-purple-400">Recommended</span>` : ""}
          </p>
          ${item.reason ? html`<p class="text-xs text-neutral-400 mt-1 leading-relaxed">${item.reason}</p>` : ""}
          ${providers.length ? providerLogos(providers) : ""}
        </div>
        <div class="flex gap-2 flex-shrink-0">
          <form hx-post="/watchlist/promote/${item._id}" hx-target="#wl-${item._id}" hx-swap="outerHTML">
            <button type="submit" class="px-3 py-1.5 text-xs font-medium bg-neutral-800 hover:bg-neutral-700 rounded-lg transition-colors">Mark Watched →</button>
          </form>
          <button hx-post="/watchlist/remove/${item._id}" hx-target="#wl-${item._id}" hx-swap="outerHTML" class="px-3 py-1.5 text-xs text-neutral-500 hover:text-red-400 hover:bg-neutral-800 rounded-lg transition-colors">Remove</button>
        </div>
      </div>`;
      })}
    </div>
  </div>`
    : html`<div class="text-center py-20 text-neutral-500">
    <p>Your watchlist is empty.</p>
    <p class="text-sm mt-1">Add items manually or generate recommendations from <a href="/discover" class="underline hover:text-white">Discover</a>.</p>
  </div>`}

  ${items.length
    ? html`<div class="mt-10 pt-6 border-t border-neutral-800 flex items-center gap-4">
    <span id="enrich-result">
      <form hx-post="/watchlist/enrich-all" hx-target="#enrich-result" hx-swap="innerHTML" hx-indicator="#enrich-spinner">
        <button type="submit" class="flex items-center gap-2 px-3 py-1.5 text-xs text-neutral-500 hover:text-white border border-neutral-800 hover:border-neutral-600 rounded-lg transition-colors">
          <svg id="enrich-spinner" class="htmx-indicator animate-spin w-3 h-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
          Enrich watchlist
        </button>
      </form>
    </span>
    <p class="text-xs text-neutral-700">Fetches missing ratings and streaming availability.</p>
  </div>`
    : ""}
</div>`;
}

// partials/watchlist_added.html
export function WatchlistAdded(title: string): View {
  return html`<p class="text-sm text-emerald-400">"${title}" added to your watchlist. <a href="/watchlist" class="underline hover:text-white ml-1">View watchlist →</a></p>`;
}
