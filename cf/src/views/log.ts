import { html, View, jsStr } from "./layout";
import type { Doc } from "../db";
import { tierName } from "../constants";

// log.html
export function LogForm(prefillTitle: string, prefillMedium: string): View {
  return html`<div class="max-w-md mx-auto">
  <h1 class="text-2xl font-semibold mb-6">Log New Entry</h1>

  <div x-data="{
    query: '${jsStr(prefillTitle)}',
    medium: '${prefillMedium || "movie"}',
    results: [],
    selected: null,
    loading: false,
    async doSearch() {
      if (this.query.length < 2) { this.results = []; return; }
      this.loading = true;
      try {
        const r = await fetch('/api/search?q=' + encodeURIComponent(this.query) + '&medium=' + this.medium);
        this.results = await r.json();
      } catch(e) { this.results = []; }
      this.loading = false;
    },
    select(item) {
      this.selected = item;
      this.query = item.title;
      this.results = [];
    }
  }" @keydown.escape="results = []">

    <form hx-post="/log/submit" hx-target="#log-area" hx-swap="innerHTML" class="space-y-4 mb-8">
      <input type="hidden" name="tmdb_id" :value="selected?.tmdb_id || 0">
      <input type="hidden" name="books_id" :value="selected?.books_id || ''">
      <input type="hidden" name="igdb_id" :value="selected?.igdb_id || 0">

      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-sm text-neutral-400 mb-1">Medium</label>
          <select name="medium" x-model="medium" @change="results = []; selected = null" required
                  class="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-neutral-500 transition-colors">
            <option value="movie">Movie</option>
            <option value="tv">TV</option>
            <option value="book">Book</option>
            <option value="game">Game</option>
          </select>
        </div>
        <div>
          <label class="block text-sm text-neutral-400 mb-1">Tier</label>
          <select name="tier" required
                  class="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-neutral-500 transition-colors">
            <option value="1">Tier 1 — Essential</option>
            <option value="2">Tier 2 — Great</option>
            <option value="3">Tier 3 — Good</option>
            <option value="4">Tier 4 — Fine</option>
            <option value="5">Tier 5 — Disliked</option>
          </select>
        </div>
      </div>

      <div class="relative">
        <label class="block text-sm text-neutral-400 mb-1">Title</label>
        <div class="relative">
          <input type="text" name="title" x-model="query" required
                 @input.debounce.400ms="doSearch()"
                 placeholder="e.g. The Bear"
                 class="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-white placeholder-neutral-600 focus:outline-none focus:border-neutral-500 transition-colors pr-8">
          <span x-show="loading" class="absolute right-2 top-2.5 text-neutral-500 text-sm">⟳</span>
        </div>

        <div x-show="results.length > 0"
             class="absolute z-10 w-full mt-1 bg-neutral-800 border border-neutral-700 rounded-lg overflow-hidden shadow-xl max-h-64 overflow-y-auto">
          <template x-for="item in results" :key="item.tmdb_id || item.books_id || item.title">
            <button type="button" @click="select(item)"
                    class="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-neutral-700 text-left border-b border-neutral-700 last:border-0">
              <template x-if="item.poster_url">
                <img :src="item.poster_url" class="w-6 h-9 object-cover rounded flex-shrink-0">
              </template>
              <template x-if="!item.poster_url">
                <div class="w-6 h-9 bg-neutral-700 rounded flex-shrink-0"></div>
              </template>
              <div class="flex-1 min-w-0">
                <p class="text-sm text-white truncate" x-text="item.title"></p>
                <p class="text-xs text-neutral-500 truncate" x-text="[item.creator, item.year].filter(Boolean).join(' · ')"></p>
              </div>
            </button>
          </template>
        </div>
      </div>

      <div x-show="selected" class="flex items-center gap-3 p-2.5 bg-neutral-800 rounded-lg">
        <template x-if="selected?.poster_url">
          <img :src="selected.poster_url" class="w-8 h-12 object-cover rounded flex-shrink-0">
        </template>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-white truncate" x-text="selected?.title"></p>
          <p class="text-xs text-neutral-500" x-text="[selected?.creator, selected?.year].filter(Boolean).join(' · ')"></p>
        </div>
        <button type="button" @click="selected = null; results = []" class="text-xs text-neutral-600 hover:text-neutral-400 flex-shrink-0">✕ clear</button>
      </div>
      <p x-show="!selected && query.length >= 2 && !loading && results.length === 0" class="text-xs text-neutral-600">No API match — title will be logged as-is and enriched later.</p>

      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-sm text-neutral-400 mb-1">Creator <span class="text-neutral-600">(optional)</span></label>
          <input type="text" name="creator" placeholder="Director / Author / Studio"
                 :placeholder="selected?.creator || 'Director / Author / Studio'"
                 :value="selected?.creator || ''"
                 class="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-white placeholder-neutral-600 focus:outline-none focus:border-neutral-500 transition-colors">
        </div>
        <div>
          <label class="block text-sm text-neutral-400 mb-1">Year <span class="text-neutral-600">(optional)</span></label>
          <input type="text" name="year" maxlength="4" :value="selected?.year || ''" placeholder="2024"
                 class="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-white placeholder-neutral-600 focus:outline-none focus:border-neutral-500 transition-colors">
        </div>
      </div>

      <button type="submit" class="w-full py-2.5 bg-white text-black font-semibold rounded-lg hover:bg-neutral-200 transition-colors mt-2">Log &amp; Rank →</button>
    </form>
  </div>

  <div id="log-area"></div>
</div>`;
}

// partials/log_compare.html
export function LogCompare(newTitle: string, compareItem: Doc, sessionId: string): View {
  return html`<div class="text-center py-6">
  <div class="mb-6">
    <p class="text-xs text-neutral-500 uppercase tracking-widest mb-1">New Entry</p>
    <h2 class="text-2xl font-bold">${newTitle}</h2>
  </div>
  <div class="text-neutral-600 text-2xl font-light mb-6">vs.</div>
  <div class="flex flex-col items-center gap-3 mb-8">
    ${compareItem.poster_url
      ? html`<img src="${compareItem.poster_url}" alt="${compareItem.title}" class="w-20 rounded-md object-cover aspect-[2/3]">`
      : ""}
    <div>
      <h3 class="text-xl font-semibold">${compareItem.title}</h3>
      ${compareItem.year ? html`<p class="text-neutral-400 text-sm mt-0.5">${compareItem.year}</p>` : ""}
    </div>
  </div>
  <p class="text-neutral-400 text-sm mb-6">
    Is <strong class="text-white">${newTitle}</strong> better or worse than <strong class="text-white">${compareItem.title}</strong>?
  </p>
  <form hx-post="/log/compare" hx-target="#log-area" hx-swap="innerHTML">
    <input type="hidden" name="session_id" value="${sessionId}">
    <div class="flex gap-4 justify-center">
      <button type="submit" name="result" value="better" class="px-8 py-3 bg-emerald-700 hover:bg-emerald-600 text-white font-semibold rounded-lg transition-colors">↑ Better</button>
      <button type="submit" name="result" value="worse" class="px-8 py-3 bg-red-900 hover:bg-red-800 text-white font-semibold rounded-lg transition-colors">↓ Worse</button>
      <button type="submit" name="result" value="na" class="px-8 py-3 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 font-semibold rounded-lg transition-colors">N/A</button>
    </div>
  </form>
</div>`;
}

// partials/log_done.html
export function LogDone(title: string, tier: number, rank: number | null): View {
  return html`<div class="text-center py-10">
  <div class="text-4xl mb-4">✓</div>
  <h2 class="text-2xl font-semibold mb-1">${title}</h2>
  <p class="text-neutral-400 text-sm">
    Added to ${tierName(tier)}
    ${rank != null ? html`<span class="text-neutral-600 ml-1">· rank ${rank.toFixed(2)}</span>` : ""}
  </p>
  <div class="flex gap-3 justify-center mt-7">
    <a href="/log" class="px-5 py-2 bg-neutral-800 text-white rounded-lg hover:bg-neutral-700 transition-colors text-sm">Log Another</a>
    <a href="/" class="px-5 py-2 bg-white text-black rounded-lg hover:bg-neutral-200 transition-colors text-sm font-medium">View Library</a>
  </div>
</div>`;
}
