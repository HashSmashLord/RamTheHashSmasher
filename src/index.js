// RAMherd: the banner page. The fund lines and the listing's live count; nothing else
// on this page moves. The herd itself is on herd.html, the Herder on herder.html.

import { RAMherdAPI } from "./mock-data.js";
import { initNav } from "./nav.js";
import { renderFundLines } from "./fund-lines.js";
import { $, writeCounts } from "./ui.js";

initNav();

async function tick() {
  const stats = await renderFundLines();
  writeCounts($("index-counts"), stats.breakdown);
}

await tick();
RAMherdAPI.subscribeLive(tick, 4000);
