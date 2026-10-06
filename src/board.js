// HashRammers: the Herd, live (/herd). One screen per RAM, diffed by id so a tick never
// re-renders the board, and the desk feed every screen on the page shares.
// Data through RAMherdAPI only; desk streams through sandbox-viewer.js only.

import { RAMherdAPI } from "./mock-data.js";
import { createDeskViewer, createDeskDirectory, deskFeedAvailable } from "./sandbox-viewer.js";
import { $, isStale, judgeMarkup, print, ramHref, roundShort, slotIdFor, write, writeNowLine, writePath } from "./ui.js";

// Every screen re-checks its stream this often (a sandbox may start or stop); never harder.
export const DESK_POLL_MS = 10_000;

// Whether this page is served by the API server (which answers /api/slots and
// /api/slots/:id/stream). A bare static server has no desk feed; every screen then simply
// shows "no desk running", without a single failed request. With the feed, one listing per
// poll tells every screen whether its slot exists and has a running sandbox; only then is
// that slot's stream asked for. See deskFeedAvailable() and createDeskDirectory().
const NO_FEED = async () => ({ state: "idle", enabled: false });

export async function createDeskFeed() {
  let directory = null;
  if (await deskFeedAvailable()) {
    directory = createDeskDirectory();
    await directory.refresh();
  }
  return {
    load: (slotId) => (directory ? directory.load(slotId) : NO_FEED()),
    refresh: async () => {
      if (directory) await directory.refresh();
    },
  };
}

// One line per desk state (sandbox-viewer.js deskWhy); short, this is a tile. `idle` is
// the usual case: never had a desk. The others say what its last desk session did.
const TILE_COPY = {
  checking: (label) => `Checking ${label}'s desk…`,
  idle: (label) => `No desktop running for ${label}. It works on the host right now; when a sandbox is started for it, its screen shows here, watch-only.`,
  starting: (label) => `${label}'s desk is starting; its screen shows here, watch-only, once it is up.`,
  stopped: (label) => `${label} finished its visible desk session; back to working on the host.`,
  expired: (label) => `${label}'s desk session ran its full time; back to working on the host.`,
  ended: (label) => `${label}'s desk session closed before its scheduled stop; back to working on the host.`,
  failed: (label) => `${label}'s desk could not start this time; it is still working on the host.`,
  unreachable: (label) => `${label}'s desk feed could not be reached just now.`,
};

function buildTile(agent, feed) {
  const art = document.createElement("article");
  art.className = "tile";
  art.id = `tile-${agent.id}`;
  const href = ramHref(agent.id, { samePage: true });
  art.innerHTML = `
    <div class="screen">
      <svg class="screen-idle" viewBox="0 0 30 30" aria-hidden="true"><use href="#hash-block"/></svg>
      <a class="screen-link" href="${href}"><span class="sr-only">Open ${agent.id}'s page</span></a>
    </div>
    <div class="tile-lines">
      <p class="tile-head"><a class="tile-id" href="${href}"></a><span class="now-line"><span class="now-glyph"></span><span class="now-word"></span><span class="now-clock"></span></span></p>
      <p class="tile-live"></p>
      <p class="tile-round"><span class="round-id"></span><span class="round-path"></span></p>
      <p class="tile-model"><span class="entrant-model"></span><span class="entrant-approach"></span></p>
      <p class="tile-activity"></p>
      <p class="tile-judge"></p>
    </div>`;
  const screen = art.querySelector(".screen");
  const desk = createDeskViewer({ ramLabel: agent.id, slotId: slotIdFor(agent), copy: TILE_COPY, load: feed.load });
  screen.prepend(desk.el);
  return {
    el: art,
    desk,
    seconds: Infinity,
    judgeKey: null,
    id: art.querySelector(".tile-id"),
    now: { glyph: art.querySelector(".now-glyph"), word: art.querySelector(".now-word"), clock: art.querySelector(".now-clock"), line: art.querySelector(".now-line") },
    live: art.querySelector(".tile-live"),
    round: art.querySelector(".round-id"),
    path: art.querySelector(".round-path"),
    model: art.querySelector(".entrant-model"),
    approach: art.querySelector(".entrant-approach"),
    activity: art.querySelector(".tile-activity"),
    judge: art.querySelector(".tile-judge"),
  };
}

function updateTile(t, agent, first) {
  write(t.id, agent.id);
  write(t.live, `Live for ${agent.liveLabel}`);
  write(t.round, roundShort(agent));
  writePath(t.path, agent.lanePath);
  writePath(t.model, agent.model || "");
  write(t.approach, agent.approach);
  const activityChanged = write(t.activity, agent.activity);

  const { statusChanged, freshWrite, seconds } = writeNowLine(t.now, agent, t.seconds);
  t.seconds = seconds;
  t.el.classList.toggle("stale", isStale(agent, seconds));

  const j = judgeMarkup(agent);
  if (j.key !== t.judgeKey) {
    t.judgeKey = j.key;
    t.judge.innerHTML = j.html;
  }

  if (!first && (statusChanged || activityChanged || freshWrite)) {
    print(t.now.line);
    if (activityChanged) print(t.activity);
  }
}

/**
 * Mounts the board into #tiles. `render()` fetches the fleet, diffs the tiles and returns
 * the fleet (so the page can hand it to the RAM page); `refreshDesks()` re-checks every
 * screen's stream.
 * @param {{ feed: Awaited<ReturnType<typeof createDeskFeed>>, getFleet?: typeof RAMherdAPI.getFleet }} opts
 *   `getFleet` defaults to the real `RAMherdAPI.getFleet`; overridable so tests can drive a
 *   synthetic, growing fleet without a real backend (see tests/board.test.js).
 */
export function mountBoard({ feed, getFleet = RAMherdAPI.getFleet }) {
  const grid = $("tiles");
  const tiles = new Map();

  async function render() {
    const fleet = await getFleet();
    // Scroll bug, real-tested 2026-10-06: diffing by id already avoids a full rebuild, but
    // this grid is live and its cards are not a fixed height -- any one card's text growing
    // or shrinking on a routine update (a longer status line, a judge score appearing, and
    // so on) reflows the whole grid and silently moves an already-scrolled reader's position,
    // even with the tile count unchanged (confirmed: tiles stayed at 16, scrollY still jumped
    // ~800px on an ordinary tick). Snapshotting scrollY around the mutations and restoring it
    // right after cancels exactly that shift, while a reader's own scrolling between ticks is
    // untouched -- same "preserve what the reader was looking at through a reflow" intent as
    // ram-page.js's board-return scroll restore, just for this page's own live updates instead
    // of a navigation.
    const scrollY = window.scrollY;
    const seen = new Set();
    // A brand-new tile's own desk check (sandbox-viewer.js's refresh()) is a fetch: it can
    // still be settling the tile's screen (idle text <-> badge <-> iframe) after this loop
    // returns -- a real async-settle gap in the scrollY guard below, checked 2026-10-06
    // against a growing roster (budget.js's withLaunchCeiling raises maxSlots as RAMs
    // launch, so new tiles can and do appear while someone is already scrolled down).
    // Today that settling never actually moves anything: .screen's CSS (aspect-ratio +
    // overflow:hidden, every bit of desk markup position:absolute) makes the box's size
    // independent of its content, so toggling idle text for a live iframe reflows nothing.
    // But that CSS is the only thing closing this gap, not this guard -- awaiting each new
    // tile's first refresh() before the check below closes it here too, so a later change
    // to that CSS (e.g. a thumbnail image in a tile) can't silently reopen the scroll-jump
    // bug this file already fixed once (see the comment below and herd.js's poll interval).
    const firstRefreshes = [];
    for (const agent of fleet) {
      seen.add(agent.id);
      let t = tiles.get(agent.id);
      const first = !t;
      if (first) {
        t = buildTile(agent, feed);
        tiles.set(agent.id, t);
        grid.appendChild(t.el);
        firstRefreshes.push(t.desk.refresh());
      }
      updateTile(t, agent, first);
    }
    for (const [id, t] of tiles) {
      if (!seen.has(id)) {
        t.desk.destroy();
        t.el.remove();
        tiles.delete(id);
      }
    }
    if (firstRefreshes.length) await Promise.all(firstRefreshes);
    if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
    return fleet;
  }

  // Same reasoning as render()'s firstRefreshes above: each tile's desk.refresh() is a
  // fetch, so the caller (herd.js's poll interval) needs to await this to guard against
  // it settling after its own scrollY check, not before.
  async function refreshDesks() {
    await Promise.all([...tiles.values()].map((t) => t.desk.refresh()));
  }

  return { render, refreshDesks };
}
