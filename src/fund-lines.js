// RAMherd: the printed fund lines on the banner page (the home page). Fees collected, compute
// spent as a 24-block bar, RAMs funded as one block per slot. Data through RAMherdAPI only.

import { RAMherdAPI } from "./mock-data.js";
import { $, money, print, write } from "./ui.js";

let renderedOnce = false;

function writeBlocks(el, total, on) {
  const key = `${total}/${on}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = "";
  for (let i = 0; i < total; i++) {
    const b = document.createElement("i");
    if (i < on) b.className = "on";
    el.append(b);
  }
}

// Writes the fund lines and returns the stats they came from (the breakdown by status is
// in there too, for the banner page's listing).
export async function renderFundLines() {
  const s = await RAMherdAPI.getStats();
  const first = !renderedOnce;
  renderedOnce = true;

  // The figures are visible from the first paint; only later writes are printed.
  const fees = $("stat-fees");
  if (write(fees, money(s.feesCollectedLifetime)) && !first) print(fees);

  // The real server sends null for the spend (no route measures it per epoch yet —
  // see getStats() in mock-data.js). Then the line says so in words, and the connector
  // says plainly that the budget IS whatever fees came in (allocationFraction is 1 in
  // budget.js -- it's not a separate fixed quota), not just a number sitting next to
  // it. The bar is hidden either way: an empty bar would say "nothing spent", which is
  // not what null means.
  const spent = $("stat-budget");
  const tracked = s.computeSpentEpoch != null;
  if (write(spent, tracked ? money(s.computeSpentEpoch) : "not tracked yet") && !first) print(spent);
  write(spent.parentElement.querySelector(".fund-of").firstChild, tracked ? "of " : "— the budget is every fee collected: ");
  write($("stat-budget-total"), money(s.computeBudgetEpoch));
  write($("stat-epoch"), s.epochLabel);

  // The budget as a block bar: 24 blocks, the spent share filled from the left.
  const budgetBlocks = $("budget-blocks");
  budgetBlocks.hidden = !tracked;
  if (tracked) {
    const share = Math.min(1, s.computeSpentEpoch / s.computeBudgetEpoch);
    writeBlocks(budgetBlocks, 24, Math.round(share * 24));
  }

  write($("stat-slots"), `${s.slotsActive} of ${s.slotsMax}`);
  writeBlocks($("slot-blocks"), s.slotsMax, s.slotsActive);
  return s;
}
