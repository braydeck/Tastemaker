import { html, raw, View } from "./layout";
import type { Doc } from "../db";
import { DIMENSIONS, DIMENSION_LABELS, DIMENSION_DEFINITIONS } from "../constants";

// calibrate.html
export function Calibrate(items: Doc[]): View {
  return html`<div class="max-w-3xl mx-auto">
  <div class="mb-8">
    <h1 class="text-2xl font-semibold mb-1">Calibration</h1>
    <p class="text-neutral-400 text-sm">Review and correct LLM-assigned scores for your Tier 1 items. Confirmed scores become ground-truth anchors for future enrichment runs.</p>
  </div>

  ${!items.length
    ? html`<div class="text-center py-16 text-neutral-500"><p>No enriched Tier 1 items found.</p></div>`
    : html`<form hx-post="/calibrate/save" hx-target="#save-result">
      <div class="space-y-2 mb-8">
        ${items.map((item) => {
          const itemDims =
            item.medium === "game" ? [...DIMENSIONS, "sdt_autonomy", "sdt_competence"] : [...DIMENSIONS];
          const tags = item.psychological_tags ?? {};
          return html`<div x-data="{ open: false }" class="border border-neutral-800 rounded-lg overflow-hidden">
          <button type="button" @click="open = !open" class="w-full flex items-center gap-4 p-4 text-left hover:bg-neutral-900 transition-colors">
            ${item.poster_url
              ? html`<img src="${item.poster_url}" alt="${item.title}" class="w-8 h-12 object-cover rounded flex-shrink-0">`
              : html`<div class="w-8 h-12 bg-neutral-800 rounded flex-shrink-0"></div>`}
            <div class="flex-1 min-w-0">
              <p class="font-medium truncate">${item.title}</p>
              <p class="text-xs text-neutral-500 capitalize">${item.medium}${item.year ? html` · ${item.year}` : ""}</p>
            </div>
            <svg x-show="!open" xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-neutral-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
            <svg x-show="open" x-cloak xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-neutral-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7"/></svg>
          </button>
          <div x-show="open" x-cloak class="px-4 pb-4 border-t border-neutral-800 pt-4">
            <div class="space-y-4">
              ${itemDims.map((dim) => {
                const score = tags[dim] ?? 3.0;
                const valId = `val_${item._id}_${dim}`;
                return html`<div>
                <div class="flex justify-between items-baseline mb-1">
                  <div>
                    <span class="text-sm font-medium">${DIMENSION_LABELS[dim]}</span>
                    <span class="text-xs text-neutral-500 ml-2">${DIMENSION_DEFINITIONS[dim]}</span>
                  </div>
                  <span class="text-sm text-neutral-300 min-w-[2.5rem] text-right tabular-nums" id="${valId}">${Number(score).toFixed(1)}</span>
                </div>
                <input type="range" name="${item._id}__${dim}" min="1.0" max="5.0" step="0.1" value="${Number(score).toFixed(1)}"
                  oninput="${raw(`document.getElementById('${valId}').textContent = parseFloat(this.value).toFixed(1)`)}"
                  class="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-white bg-neutral-700">
                <div class="flex justify-between text-xs text-neutral-600 mt-0.5"><span>1.0</span><span>5.0</span></div>
              </div>`;
              })}
            </div>
          </div>
        </div>`;
        })}
      </div>
      <div class="flex items-center gap-4">
        <button type="submit" class="px-6 py-2.5 bg-white text-black font-semibold rounded-lg hover:bg-neutral-200 transition-colors">Save Calibration</button>
        <div id="save-result" class="text-sm text-neutral-400"></div>
      </div>
    </form>`}
</div>`;
}

// partials/calibrate_saved.html
export function CalibrateSaved(): View {
  return html`<span class="text-emerald-400">✓ Calibration saved. Run the enrichment job to apply updated anchors to un-enriched items.</span>`;
}
