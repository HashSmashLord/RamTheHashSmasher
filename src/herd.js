// HashRammers: the Herd, live. The board (one screen per RAM) and, over it, a RAM's full
// page at #ram/<id>. The two share one desk feed and one fleet tick.

import { RAMherdAPI, updateDemoNote } from "./mock-data.js";
import { initNav } from "./nav.js";
import { DESK_POLL_MS, createDeskFeed, mountBoard } from "./board.js";
import { mountRamPage } from "./ram-page.js";

initNav();
updateDemoNote("This board is the real fleet, polled live from the server — not a demonstration feed.");

const feed = await createDeskFeed();
const board = mountBoard({ feed });
const page = mountRamPage({ feed });

async function tick() {
  const fleet = await board.render();
  page.update(fleet);
}

// The first tick is awaited so the board is filled before the hash is routed, but it
// must not reject this module's top-level await: nothing below it would ever run — no
// routing, no polling — and the page would stay empty until a manual reload. A
// transient failure (cold start, network blip) is logged and let go; the poll below
// starts regardless and fills the board on its next tick.
try {
  await tick();
} catch (err) {
  console.error("First render failed; the live poll will retry.", err);
}
page.route();
RAMherdAPI.subscribeLive(tick, 4000);

// Every screen re-checks its stream every 10s; the iframe is only touched when the
// stream itself changes, so a poll never reloads a live desk.
//
// Same real scroll-jump fix as board.js's own render() (2026-10-06): refreshDesks()/
// refreshDesk() can change a tile's content (e.g. switching between "no desk running"
// text and a live iframe), which reflows the grid and silently moves a scrolled
// reader's position -- a second, separate interval from the 4s fleet tick, so it needed
// its own snapshot-and-restore; fixing render() alone left this one still jumping.
//
// Both refresh calls are awaited (checked 2026-10-06): each tile's own desk check is a
// fetch, so without this the scrollY check below could run before that fetch's DOM work
// actually lands, the same async-settle gap closed in board.js's render(). See its comment.
setInterval(async () => {
  const scrollY = window.scrollY;
  await feed.refresh();
  await Promise.all([board.refreshDesks(), page.refreshDesk()]);
  if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
}, DESK_POLL_MS);
