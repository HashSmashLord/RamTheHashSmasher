// HashRammers: Discover (/discover). Every RAM that has actually launched through the
// launchpad, so a visitor can browse what's real without already knowing a RAM's id: its
// token image, name and symbol, hash family and track, model, a link to its own page on the
// Herd, and -- only when the server has a real mint on record -- a link to its pump.fun page.
// Data through RAMherdAPI.launchpad only; status filtering and link-building are pure
// (src/discover-view.js), so they're covered by node tests without a DOM.

import { RAMherdAPI } from "./mock-data.js";
import { initNav } from "./nav.js";
import { $, ramHref } from "./ui.js";
import { launchedRams, matchesQuery, pumpFunUrl, ramRoundLabel, sortRams, tokenImageUrl } from "./discover-view.js";

initNav();

const grid = $("discover-grid");
const empty = $("discover-empty");
const noMatch = $("discover-no-match");
const noMatchQuery = $("discover-no-match-query");
const searchInput = $("discover-search");
const sortSelect = $("discover-sort");

// The full launched list from the last successful fetch, kept so the search/sort controls
// can re-render instantly without waiting on the next poll.
let lastLaunched = [];

function card(ram) {
  const art = document.createElement("article");
  art.className = "disc-card";
  const href = ramHref(ram.id);
  const img = tokenImageUrl(ram);
  const pump = pumpFunUrl(ram);

  const artLink = document.createElement("a");
  artLink.className = "disc-art";
  artLink.href = href;
  if (img) {
    const image = document.createElement("img");
    image.src = img;
    image.alt = "";
    image.width = 64;
    image.height = 64;
    image.loading = "lazy";
    artLink.append(image);
  } else {
    artLink.innerHTML = '<svg class="screen-idle" viewBox="0 0 30 30" aria-hidden="true"><use href="#hash-block"/></svg>';
  }

  const lines = document.createElement("div");
  lines.className = "disc-lines";

  const head = document.createElement("p");
  head.className = "disc-head";
  const name = document.createElement("a");
  name.className = "disc-name";
  name.href = href;
  name.textContent = ram.token?.name || ram.id;
  head.append(name);
  if (ram.token?.symbol) {
    const symbol = document.createElement("span");
    symbol.className = "disc-symbol";
    symbol.textContent = `$${ram.token.symbol}`;
    head.append(symbol);
  }

  const meta = document.createElement("p");
  meta.className = "disc-meta";
  const round = document.createElement("span");
  round.className = "disc-round";
  round.textContent = ramRoundLabel(ram);
  const model = document.createElement("span");
  model.className = "disc-model";
  model.textContent = ram.model || "";
  meta.append(round, model);

  const links = document.createElement("p");
  links.className = "disc-links";
  const open = document.createElement("a");
  open.className = "disc-open";
  open.href = href;
  open.textContent = "Open its page";
  links.append(open);
  if (pump) {
    const pumpLink = document.createElement("a");
    pumpLink.className = "ext disc-pump";
    pumpLink.href = pump;
    pumpLink.target = "_blank";
    pumpLink.rel = "noopener noreferrer";
    pumpLink.textContent = "pump.fun";
    const sr = document.createElement("span");
    sr.className = "sr-only";
    sr.textContent = " (opens in a new tab)";
    pumpLink.append(sr);
    links.append(pumpLink);
  }

  lines.append(head, meta, links);
  art.append(artLink, lines);
  return art;
}

/** Re-applies the current search + sort to the last-fetched list and redraws the grid. */
function applyView() {
  const query = searchInput.value;
  const matched = lastLaunched.filter((r) => matchesQuery(r, query));
  const shown = sortRams(matched, sortSelect.value);
  grid.replaceChildren(...shown.map(card));
  const hasAny = lastLaunched.length > 0;
  empty.hidden = hasAny;
  noMatch.hidden = !hasAny || shown.length > 0 || !query.trim();
  if (!noMatch.hidden) noMatchQuery.textContent = query.trim();
}

async function render() {
  const res = await RAMherdAPI.launchpad.listRams();
  lastLaunched = launchedRams(res.body?.rams);
  applyView();
}

searchInput.addEventListener("input", applyView);
sortSelect.addEventListener("change", applyView);

// Same rule as every other page's first tick (herd.js, index.js): a failed first fetch must
// not reject this module's top-level await, or the poll below never starts.
try {
  await render();
} catch (err) {
  console.error("Discover list failed to load; the live poll will retry.", err);
}
setInterval(() => render().catch((err) => console.error("Discover refresh failed:", err)), 4000);
