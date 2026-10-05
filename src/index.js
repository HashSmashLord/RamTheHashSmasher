// HashRammers: the banner page. The fund lines and the listing's live count; nothing else
// on this page moves. The herd itself is on /herd, the Herder on /herder.

import { RAMherdAPI, backendReady } from "./mock-data.js";
import { isLaunchpadLive } from "./launchpad-rules.js";
import { initNav } from "./nav.js";
import { renderFundLines } from "./fund-lines.js";
import { $, writeCounts } from "./ui.js";

initNav();

// Compound note (demo-feed disclosure + the launchpad-live sentence) — only the first
// clause changes on backendReady; the last node is handled separately by renderLaunchpadState
// below, since it depends on real launchpad config, not just whether a backend exists at all.
backendReady.then((real) => {
  if (!real) return;
  const el = document.querySelector(".feed-note");
  // The text node runs up to the entry-slip link, so the replacement has to end on
  // the same lead-in ("Want your own RAM in the herd?") or the link loses its sentence.
  if (el) el.firstChild.textContent = "Real, live server state: the fund lines and the herd are the server's own numbers. Want your own RAM in the herd? ";
});

// The "07 Launch your own RAM" stamp and the feed-note's closing sentence both say the
// real launchpad status (same two-gate check launch.js itself uses) instead of a
// hardcoded guess, so neither page needs hand-editing again when the operator flips it on.
async function renderLaunchpadState() {
  let live = false;
  try {
    const res = await RAMherdAPI.launchpad.getConfig();
    live = isLaunchpadLive(res.body?.launchpad);
  } catch {
    // Leave it reading "not live" rather than guessing from a failed check.
  }
  const mark = $("ex7-live-mark");
  if (mark) mark.textContent = live ? "Live now" : "Not live yet";
  const note = document.querySelector(".feed-note");
  if (note?.lastChild) {
    note.lastChild.textContent = live
      ? ". Live now: fill in the slip and sign in Phantom to launch for real."
      : ". Not live yet: you can fill it in and check it, but signing is switched off.";
  }
}
renderLaunchpadState();

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
