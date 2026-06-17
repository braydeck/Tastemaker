import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

export { html, raw };
export type View = HtmlEscapedString | Promise<HtmlEscapedString>;

// Escape a string for safe inclusion inside a single-quoted JS string literal
// that itself lives in a double-quoted HTML attribute (Alpine x-data etc.).
export function jsStr(s: unknown): HtmlEscapedString {
  const v = String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, "&quot;")
    .replace(/\r?\n/g, "\\n");
  return raw(v);
}

// base.html — nav + content shell.
export function Layout(title: string, content: View): View {
  return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/htmx.org@1.9.12/dist/htmx.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
  <style>
    [x-cloak] { display: none !important; }
    body { background-color: #141414; }
  </style>
</head>
<body class="text-white min-h-screen antialiased">

  <nav x-data="{ open: false }"
       class="border-b border-neutral-800 px-6 py-3 sticky top-0 z-50"
       style="background-color:#141414;">
    <div class="flex items-center justify-between">
      <a href="/" class="text-lg font-bold tracking-tight text-white flex-shrink-0">Tastemaker</a>
      <div class="hidden md:flex gap-6 text-sm">
        <a href="/" class="text-neutral-400 hover:text-white transition-colors">Library</a>
        <a href="/watchlist" class="text-neutral-400 hover:text-white transition-colors">Watchlist</a>
        <a href="/discover" class="text-neutral-400 hover:text-white transition-colors">Discover</a>
        <a href="/profile" class="text-neutral-400 hover:text-white transition-colors">Profile</a>
        <a href="/onboard" class="text-neutral-400 hover:text-white transition-colors">Onboard</a>
        <a href="/calibrate" class="text-neutral-400 hover:text-white transition-colors">Calibrate</a>
        <a href="/log" class="text-neutral-400 hover:text-white transition-colors">Log</a>
      </div>
      <button @click="open = !open" class="md:hidden p-1 text-neutral-400 hover:text-white transition-colors">
        <svg x-show="!open" class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>
        </svg>
        <svg x-show="open" x-cloak class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>
    <div x-show="open" x-cloak
         class="md:hidden mt-3 pt-3 border-t border-neutral-800 flex flex-col gap-3 text-sm pb-1">
      <a href="/" class="text-neutral-400 hover:text-white transition-colors">Library</a>
      <a href="/watchlist" class="text-neutral-400 hover:text-white transition-colors">Watchlist</a>
      <a href="/discover" class="text-neutral-400 hover:text-white transition-colors">Discover</a>
      <a href="/profile" class="text-neutral-400 hover:text-white transition-colors">Profile</a>
      <a href="/onboard" class="text-neutral-400 hover:text-white transition-colors">Onboard</a>
      <a href="/calibrate" class="text-neutral-400 hover:text-white transition-colors">Calibrate</a>
      <a href="/log" class="text-neutral-400 hover:text-white transition-colors">Log</a>
    </div>
  </nav>

  <main class="px-6 py-8 max-w-screen-2xl mx-auto">
    ${content}
  </main>

</body>
</html>`;
}
