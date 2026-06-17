import { html, View } from "./layout";
import type { Doc } from "../db";

export interface MaxDiffDim {
  key: string;
  label: string;
  score: number;
}

// partials/onboard_card.html
export function OnboardCard(opts: {
  item: Doc;
  dims: MaxDiffDim[];
  sessionId: string;
  remainingIds: string;
  itemNum: number;
  total: number;
}): View {
  const { item, dims, sessionId, remainingIds, itemNum, total } = opts;
  return html`<form x-data="{ most: '', least: '' }" hx-post="/onboard/response" hx-target="#onboard-card" hx-swap="innerHTML">
  <div class="flex gap-5 mb-7">
    ${item.poster_url
      ? html`<img src="${item.poster_url}" alt="${item.title}" class="w-20 rounded-md object-cover aspect-[2/3] flex-shrink-0">`
      : html`<div class="w-20 aspect-[2/3] bg-neutral-800 rounded-md flex-shrink-0 flex items-center justify-center p-2">
      <p class="text-xs text-neutral-500 text-center leading-tight">${item.title}</p>
    </div>`}
    <div class="flex flex-col justify-center">
      <h2 class="text-xl font-semibold leading-tight">${item.title}</h2>
      ${item.year ? html`<p class="text-neutral-400 text-sm mt-0.5">${item.year}</p>` : ""}
      <span class="text-xs text-neutral-500 capitalize mt-1 inline-block">${item.medium}</span>
    </div>
  </div>

  <p class="text-sm text-neutral-400 mb-4">What drove your enjoyment?</p>

  <div class="space-y-2 mb-6">
    ${dims.map(
      ({ key, label, score }) => html`<div class="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-neutral-900 border border-neutral-800">
      <span class="flex-1 text-sm">${label}</span>
      <span class="text-xs text-neutral-500 tabular-nums w-8 text-right">${score.toFixed(1)}</span>
      <label class="flex items-center gap-1.5 cursor-pointer select-none" :class="{ 'opacity-30 cursor-not-allowed': least === '${key}' }">
        <input type="radio" name="most" value="${key}" x-model="most" :disabled="least === '${key}'" class="accent-emerald-400" required>
        <span class="text-xs font-medium text-emerald-400">Most</span>
      </label>
      <label class="flex items-center gap-1.5 cursor-pointer select-none" :class="{ 'opacity-30 cursor-not-allowed': most === '${key}' }">
        <input type="radio" name="least" value="${key}" x-model="least" :disabled="most === '${key}'" class="accent-red-400" required>
        <span class="text-xs font-medium text-red-400">Least</span>
      </label>
    </div>`
    )}
  </div>

  <input type="hidden" name="media_id" value="${item._id}">
  <input type="hidden" name="session_id" value="${sessionId}">
  <input type="hidden" name="remaining_ids" value="${remainingIds}">
  <input type="hidden" name="item_num" value="${itemNum}">
  <input type="hidden" name="total" value="${total}">

  <button type="submit" :disabled="!most || !least"
          class="w-full py-3 bg-white text-black font-semibold rounded-lg hover:bg-neutral-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">Next →</button>
</form>`;
}

// onboard.html
export function Onboard(opts: {
  item: Doc | null;
  dims: MaxDiffDim[];
  sessionId: string;
  remainingIds: string;
  itemNum: number;
  total: number;
}): View {
  const { item, total, itemNum } = opts;
  const pct = total ? Math.floor((itemNum / total) * 100) : 0;
  return html`<div class="max-w-xl mx-auto">
  <div class="mb-8">
    <h1 class="text-2xl font-semibold mb-1">Preference Calibration</h1>
    <p class="text-neutral-400 text-sm">For each work, select what drove your enjoyment most and least. This helps the engine understand your taste profile.</p>
  </div>

  ${!item
    ? html`<div class="text-center py-16 text-neutral-500">
      <p class="text-lg mb-2">No enriched Tier 1 items yet.</p>
      <p class="text-sm">Run the enrichment job first.</p>
    </div>`
    : html`<div class="mb-6">
      <div class="flex justify-between text-xs text-neutral-500 mb-1">
        <span>Item ${itemNum} of ${total}</span>
        <span>${pct}%</span>
      </div>
      <div class="w-full bg-neutral-800 rounded-full h-1">
        <div class="bg-white h-1 rounded-full transition-all duration-500" style="width: ${pct}%"></div>
      </div>
    </div>
    <div id="onboard-card">${OnboardCard(opts as any)}</div>`}
</div>`;
}

// partials/onboard_done.html
export function OnboardDone(): View {
  return html`<div class="text-center py-12">
  <div class="text-5xl mb-5">✓</div>
  <h2 class="text-2xl font-semibold mb-2">Calibration Complete</h2>
  <p class="text-neutral-400 text-sm mb-8">Your preferences have been saved to the database.</p>
  <div class="flex gap-3 justify-center">
    <a href="/onboard" class="px-5 py-2 bg-neutral-800 text-white rounded-lg hover:bg-neutral-700 transition-colors text-sm">Run Again</a>
    <a href="/" class="px-5 py-2 bg-white text-black rounded-lg hover:bg-neutral-200 transition-colors text-sm font-medium">View Library</a>
  </div>
</div>`;
}
