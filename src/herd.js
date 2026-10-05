// RAMherd: the Herd, live. The board (one screen per RAM) and, over it, a RAM's full
// page at #ram/<id>. The two share one desk feed and one fleet tick.

import { RAMherdAPI } from "./mock-data.js";
import { initNav } from "./nav.js";
import { DESK_POLL_MS, createDeskFeed, mountBoard } from "./board.js";
import { mountRamPage } from "./ram-page.js";

initNav();

const feed = await createDeskFeed();
const board = mountBoard({ feed });
const page = mountRamPage({ feed });

async function tick() {
  const fleet = await board.render();
  page.update(fleet);
}

await tick();
page.route();
RAMherdAPI.subscribeLive(tick, 4000);

// Every screen re-checks its stream every 10s; the iframe is only touched when the
// stream itself changes, so a poll never reloads a live desk.
setInterval(async () => {
  await feed.refresh();
  board.refreshDesks();
  page.refreshDesk();
}, DESK_POLL_MS);
