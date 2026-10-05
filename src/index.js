// HashRammers: the banner page. The fund lines and the listing's live count; nothing else
// on this page moves. The herd itself is on /herd, the Herder on /herder.

import { RAMherdAPI, backendReady } from "./mock-data.js";
import { initNav } from "./nav.js";
import { renderFundLines } from "./fund-lines.js";
import { $, writeCounts } from "./ui.js";

initNav();

// Compound note (demo-feed disclosure + the still-true launchpad-not-live sentence) —
// only the first clause changes, so this rewrites it directly rather than through
// updateDemoNote (which only handles a note that's wholly about simulated data).
backendReady.then((real) => {
  if (!real) return;
  const el = document.querySelector(".feed-note");
  // The text node runs up to the entry-slip link, so the replacement has to end on
  // the same lead-in ("Want your own RAM in the herd?") or the link loses its sentence.
  if (el) el.firstChild.textContent = "Real, live server state: the fund lines and the herd are the server's own numbers. Want your own RAM in the herd? ";
});

async function tick() {
  const stats = await renderFundLines();
  writeCounts($("index-counts"), stats.breakdown);
}

// Same rule as herd.js: a failed first fetch must not reject the module's top-level
// await, or the poll below never starts and the page stays empty until a reload.
try {
  await tick();
} catch (err) {
  console.error("First render failed; the live poll will retry.", err);
}
RAMherdAPI.subscribeLive(tick, 4000);
