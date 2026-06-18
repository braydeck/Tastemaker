import { html, View } from "./layout";

export function Admin(stats: {
  total: number;
  scored: number;
  unscored: number;
  errored: number;
  clusters: number;
}): View {
  const { total, scored, unscored, errored, clusters } = stats;
  return html`<div class="max-w-2xl mx-auto">
  <div class="mb-8">
    <h1 class="text-2xl font-semibold mb-1">Maintenance</h1>
    <p class="text-neutral-400 text-sm">Generate psychological profiles for new titles and recompute taste clusters.</p>
    <div class="flex flex-wrap gap-3 text-xs text-neutral-500 mt-4">
      <span class="px-2.5 py-1 bg-neutral-800 rounded-full">${total} logged</span>
      <span class="px-2.5 py-1 bg-neutral-800 rounded-full">${scored} profiled</span>
      <span class="px-2.5 py-1 bg-neutral-800 rounded-full">${unscored} need profiling</span>
      ${errored ? html`<span class="px-2.5 py-1 bg-neutral-800 rounded-full text-yellow-600">${errored} errored</span>` : ""}
      <span class="px-2.5 py-1 bg-neutral-800 rounded-full">${clusters} clusters</span>
    </div>
  </div>

  <!-- Generate psychological profiles -->
  <div x-data="{
    running: false, done: false, enriched: 0, errored: 0, remaining: ${unscored}, error: '',
    async run() {
      this.running = true; this.done = false; this.error = '';
      this.enriched = 0; this.errored = 0;
      try {
        while (true) {
          const r = await fetch('/admin/enrich', { method: 'POST' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const d = await r.json();
          this.enriched += d.enriched; this.errored += d.errored; this.remaining = d.remaining;
          if (d.done) break;
          // Safety: a batch that scored nothing means the rest can't be scored — stop.
          if (d.enriched === 0 && d.errored === 0) break;
        }
        this.done = true;
      } catch (e) { this.error = String(e); }
      this.running = false;
    }
  }" class="border border-neutral-800 rounded-xl p-5 mb-6">
    <h2 class="text-lg font-semibold mb-1">Psychological profiles</h2>
    <p class="text-sm text-neutral-400 mb-4">Scores each un-profiled title across the dimensions (fetching metadata first if missing). Runs in small batches to stay within Cloudflare's free tier — the button loops automatically until done.</p>
    <div class="flex items-center gap-4">
      <button @click="run()" :disabled="running || remaining === 0"
              :class="running || remaining === 0 ? 'opacity-40 cursor-not-allowed' : 'hover:bg-neutral-200'"
              class="flex items-center gap-2 px-5 py-2.5 bg-white text-black text-sm font-semibold rounded-lg transition-colors">
        <svg x-show="running" class="animate-spin w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
        <span x-text="running ? 'Profiling…' : (remaining === 0 ? 'All profiled' : 'Generate profiles')"></span>
      </button>
      <span class="text-xs text-neutral-500" x-show="running || done" x-cloak>
        <span x-text="enriched"></span> scored<span x-show="errored"> · <span x-text="errored"></span> errored</span> · <span x-text="remaining"></span> remaining
      </span>
    </div>
    <p x-show="done && !error" x-cloak class="text-xs text-emerald-400 mt-3">✓ Done. <a href="/profile" class="underline hover:text-white">View profile →</a> Consider recomputing clusters below.</p>
    <p x-show="error" x-cloak class="text-xs text-red-400 mt-3" x-text="error"></p>
  </div>

  <!-- Recompute taste clusters -->
  <div x-data="{
    running: false, result: '', error: '', k: 4,
    async run() {
      this.running = true; this.result = ''; this.error = '';
      try {
        const r = await fetch('/admin/recluster?k=' + this.k, { method: 'POST' });
        const d = await r.json();
        if (d.ok) this.result = 'Recomputed ' + d.k + ' clusters across ' + d.assigned + ' items.';
        else this.error = d.error || 'Failed.';
      } catch (e) { this.error = String(e); }
      this.running = false;
    }
  }" class="border border-neutral-800 rounded-xl p-5">
    <h2 class="text-lg font-semibold mb-1">Taste clusters</h2>
    <p class="text-sm text-neutral-400 mb-4">Re-runs k-means over your profiled Tier 1 + Tier 2 items and re-names each cluster. Do this after profiling new titles so the clusters reflect them.</p>
    <div class="flex items-center gap-3 flex-wrap">
      <label class="text-xs text-neutral-500">Clusters
        <input type="number" min="2" max="10" x-model.number="k"
               class="ml-2 w-16 bg-neutral-900 border border-neutral-700 rounded-lg px-2 py-1 text-white text-sm focus:outline-none focus:border-neutral-500">
      </label>
      <button @click="run()" :disabled="running"
              :class="running ? 'opacity-40 cursor-not-allowed' : 'hover:bg-neutral-200'"
              class="flex items-center gap-2 px-5 py-2.5 bg-white text-black text-sm font-semibold rounded-lg transition-colors">
        <svg x-show="running" class="animate-spin w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
        <span x-text="running ? 'Clustering…' : 'Recompute clusters'"></span>
      </button>
    </div>
    <p x-show="result" x-cloak class="text-xs text-emerald-400 mt-3"><span x-text="result"></span> <a href="/profile" class="underline hover:text-white">View profile →</a></p>
    <p x-show="error" x-cloak class="text-xs text-red-400 mt-3" x-text="error"></p>
  </div>
</div>`;
}
