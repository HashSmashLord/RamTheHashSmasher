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
 * @param {{ feed: Awaited<ReturnType<typeof createDeskFeed>> }} opts
 */
export function mountBoard({ feed }) {
  const grid = $("tiles");
  const tiles = new Map();

  async function render() {
    const fleet = await RAMherdAPI.getFleet();
    const seen = new Set();
    for (const agent of fleet) {
      seen.add(agent.id);
      let t = tiles.get(agent.id);
      const first = !t;
      if (first) {
        t = buildTile(agent, feed);
        tiles.set(agent.id, t);
        grid.appendChild(t.el);
        t.desk.refresh();
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
    return fleet;
  }

  function refreshDesks() {
    for (const t of tiles.values()) t.desk.refresh();
  }

  return { render, refreshDesks };
}
