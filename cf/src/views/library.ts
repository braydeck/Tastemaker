import { html, raw, View } from "./layout";
import type { Doc } from "../db";
import { tierName, tierBadgeClass, mediumDot, TIER_NAMES } from "../constants";

export interface TierGroup {
  tier: number | null;
  items: Doc[];
}

// partials/tier_select.html
export function TierSelect(itemId: string, tier: number | null): View {
  return html`<form hx-post="/item/${itemId}/set-tier"
      hx-trigger="change"
      hx-target="this"
      hx-swap="outerHTML">
  <select name="tier"
          class="bg-neutral-900 border border-neutral-700 rounded-lg px-2 py-1 text-xs text-white
                 focus:outline-none focus:border-neutral-500 transition-colors cursor-pointer">
    <option value="" ${tier == null ? "selected" : ""}>— Untiered</option>
    ${[1, 2, 3, 4, 5].map(
      (t) =>
        html`<option value="${t}" ${tier === t ? "selected" : ""}>${TIER_NAMES[String(t)]}</option>`
    )}
  </select>
</form>`;
}

// partials/grid.html
export function Grid(tierGroups: TierGroup[]): View {
  if (!tierGroups.length)
    return html`<p class="text-neutral-500 text-center py-20">No items found.</p>`;
  return html`${tierGroups.map(
    ({ tier, items }) => html`<section class="mb-10">
  <h2 class="text-sm font-semibold text-neutral-500 uppercase tracking-widest mb-4">
    ${tierName(tier)}
    <span class="text-neutral-700 ml-2 normal-case tracking-normal font-normal">${items.length}</span>
  </h2>
  <div class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
    ${items.map(
      (item) => html`<a href="/item/${item._id}" class="relative group cursor-pointer block">
      <div class="aspect-[2/3] rounded-md overflow-hidden bg-neutral-900">
        ${item.poster_url
          ? html`<img src="${item.poster_url}" alt="${item.title}"
             class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
             loading="lazy">`
          : html`<div class="w-full h-full flex items-end p-2 bg-neutral-900">
          <p class="text-xs text-neutral-500 leading-tight line-clamp-4">${item.title}</p>
        </div>`}
        <span class="absolute top-1.5 right-1.5 text-xs font-bold px-1.5 py-0.5 rounded ${tierBadgeClass(
          item.tier
        )}">${item.tier ? html`T${item.tier}` : "—"}</span>
        <span class="absolute top-1.5 left-1.5 w-2 h-2 rounded-full ${mediumDot(item.medium)}"></span>
        <div class="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent
                    opacity-0 group-hover:opacity-100 transition-opacity duration-200
                    flex flex-col justify-end p-2.5">
          <p class="text-xs font-semibold leading-tight line-clamp-2">${item.title}</p>
          ${item.year ? html`<p class="text-xs text-neutral-400 mt-0.5">${item.year}</p>` : ""}
          ${item.creator ? html`<p class="text-xs text-neutral-500 truncate">${item.creator}</p>` : ""}
        </div>
      </div>
    </a>`
    )}
  </div>
</section>`
  )}`;
}

// partials/table.html
export function Table(items: Doc[], medium: string, sort: string, dir: string): View {
  const sortHeader = (label: string, col: string): View => {
    const isActive = sort === col;
    const nextDir = isActive && dir === "asc" ? "desc" : "asc";
    return html`<th class="text-left pb-3 pr-4 font-medium">
  <button hx-get="/?medium=${medium}&view=table&sort=${col}&dir=${nextDir}"
          hx-target="#library-content"
          hx-push-url="true"
          class="flex items-center gap-1 group hover:text-white transition-colors ${isActive
            ? "text-white"
            : "text-neutral-500"}">
    ${label}
    <span class="text-xs">${isActive
      ? dir === "asc"
        ? "↑"
        : "↓"
      : html`<span class="opacity-0 group-hover:opacity-40">↑</span>`}</span>
  </button>
</th>`;
  };

  if (!items.length)
    return html`<p class="text-neutral-500 text-center py-20">No items found.</p>`;

  return html`<div class="overflow-x-auto">
  <table class="w-full text-sm">
    <thead>
      <tr class="border-b border-neutral-800 text-xs uppercase tracking-wide">
        <th class="pb-3 pr-4 w-8"></th>
        ${sortHeader("Title", "title")}
        ${sortHeader("Medium", "medium")}
        ${sortHeader("Creator", "creator")}
        ${sortHeader("Year", "year")}
        ${sortHeader("Tier", "tier")}
      </tr>
    </thead>
    <tbody class="divide-y divide-neutral-900">
      ${items.map(
        (item) => html`<tr class="hover:bg-neutral-900 transition-colors">
        <td class="py-2 pr-4">
          ${item.poster_url
            ? html`<img src="${item.poster_url}" alt="" class="w-6 h-9 object-cover rounded flex-shrink-0">`
            : html`<div class="w-6 h-9 bg-neutral-800 rounded flex-shrink-0"></div>`}
        </td>
        <td class="py-2 pr-4">
          <a href="/item/${item._id}"
             class="font-medium hover:text-neutral-300 transition-colors line-clamp-1">${item.title}</a>
        </td>
        <td class="py-2 pr-4">
          <div class="flex items-center gap-1.5">
            <span class="w-1.5 h-1.5 rounded-full flex-shrink-0 ${mediumDot(item.medium)}"></span>
            <span class="text-neutral-400 capitalize">${item.medium}</span>
          </div>
        </td>
        <td class="py-2 pr-4 text-neutral-400 max-w-[160px] truncate">${item.creator || "—"}</td>
        <td class="py-2 pr-4 text-neutral-500 tabular-nums">${item.year || "—"}</td>
        <td class="py-2">${TierSelect(item._id, item.tier ?? null)}</td>
      </tr>`
      )}
    </tbody>
  </table>
</div>`;
}

// dashboard.html
export function Dashboard(opts: {
  medium: string;
  view: string;
  sort: string;
  dir: string;
  clusterId: number;
  clusterDefs: Doc[];
  content: View;
  errorFilter: string;
  noMatchCount: number;
}): View {
  const { medium, view, clusterId, clusterDefs, content, errorFilter, noMatchCount } = opts;
  const plural = noMatchCount !== 1 ? "s" : "";
  const mediumButtons: [string, string][] = [
    ["All", ""],
    ["Movies", "movie"],
    ["TV", "tv"],
    ["Books", "book"],
    ["Games", "game"],
  ];
  return html`<div x-data="{ active: '${medium}', view: '${view}', cluster: ${clusterId} }">
  <div class="flex items-center justify-between mb-4 gap-4 flex-wrap">
    <div class="flex gap-2 flex-wrap">
      ${mediumButtons.map(
        ([label, value]) => html`<button
        @click="active = '${value}'"
        :hx-get="\`/?medium=${value}&view=\${view}&cluster_id=\${cluster}\`"
        hx-target="#library-content"
        hx-push-url="true"
        :class="active === '${value}' ? 'bg-white text-black' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'"
        class="px-3 py-1.5 rounded-full text-sm font-medium transition-colors"
      >${label}</button>`
      )}
    </div>
    <div class="flex gap-1 bg-neutral-900 rounded-lg p-1">
      <button
        @click="view = 'grid'; htmx.ajax('GET', \`/?medium=\${active}&view=grid&cluster_id=\${cluster}\`, {target: '#library-content', pushUrl: true})"
        :class="view === 'grid' ? 'bg-neutral-700 text-white' : 'text-neutral-500 hover:text-white'"
        class="p-1.5 rounded-md transition-colors" title="Grid view">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"/>
        </svg>
      </button>
      <button
        @click="view = 'table'; htmx.ajax('GET', \`/?medium=\${active}&view=table&cluster_id=\${cluster}\`, {target: '#library-content', pushUrl: true})"
        :class="view === 'table' ? 'bg-neutral-700 text-white' : 'text-neutral-500 hover:text-white'"
        class="p-1.5 rounded-md transition-colors" title="Table view">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16"/>
        </svg>
      </button>
    </div>
  </div>

  ${errorFilter
    ? html`<div class="flex items-center gap-3 mb-6 text-sm">
    <span class="px-3 py-1.5 rounded-lg bg-yellow-900/30 text-yellow-500 border border-yellow-800/40">⚠ Showing ${noMatchCount} item${plural} with no API match</span>
    <a href="/" class="text-neutral-400 hover:text-white transition-colors">✕ Clear filter</a>
  </div>`
    : noMatchCount > 0
      ? html`<div class="mb-6">
    <a href="/?error=no_api_match" class="inline-flex items-center gap-1.5 text-xs text-yellow-600 hover:text-yellow-400 transition-colors">⚠ ${noMatchCount} item${plural} with no API match — review &amp; fix</a>
  </div>`
      : ""}

  ${clusterDefs.length
    ? html`<div class="flex gap-2 flex-wrap mb-6">
    <span class="text-xs text-neutral-600 self-center mr-1">Taste cluster:</span>
    <button
      @click="cluster = -1; htmx.ajax('GET', \`/?medium=\${active}&view=\${view}&cluster_id=-1\`, {target: '#library-content', pushUrl: true})"
      :class="cluster === -1 ? 'bg-neutral-600 text-white' : 'bg-neutral-900 text-neutral-500 hover:text-neutral-300 border border-neutral-800'"
      class="px-3 py-1 rounded-full text-xs font-medium transition-colors">All</button>
    ${clusterDefs.map(
      (cd) => html`<button
      @click="cluster = ${cd.cluster_id}; htmx.ajax('GET', \`/?medium=\${active}&view=\${view}&cluster_id=${cd.cluster_id}\`, {target: '#library-content', pushUrl: true})"
      :class="cluster === ${cd.cluster_id} ? 'bg-neutral-600 text-white' : 'bg-neutral-900 text-neutral-500 hover:text-neutral-300 border border-neutral-800'"
      class="px-3 py-1 rounded-full text-xs font-medium transition-colors">${cd.name}</button>`
    )}
  </div>`
    : ""}

  <div id="library-content">${content}</div>

  <div class="mt-8 pt-6 border-t border-neutral-800 flex items-center gap-3">
    <form hx-post="/library/enrich-all" hx-target="#library-enrich-status" hx-swap="innerHTML" hx-indicator="#library-enrich-spinner">
      <button type="submit" class="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm rounded-lg transition-colors">Enrich library</button>
    </form>
    <span id="library-enrich-spinner" class="htmx-indicator text-xs text-neutral-500">Enriching…</span>
    <span id="library-enrich-status" class="text-xs"></span>
  </div>
</div>`;
}
