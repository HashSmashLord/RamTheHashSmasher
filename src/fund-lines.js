// RAMherd: the printed fund lines on the banner page (index.html). Fees collected, compute
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

  const spent = $("stat-budget");
  if (write(spent, money(s.computeSpentEpoch)) && !first) print(spent);
  write($("stat-budget-total"), money(s.computeBudgetEpoch));
  write($("stat-epoch"), s.epochLabel);

  // The budget as a block bar: 24 blocks, the spent share filled from the left.
  const share = Math.min(1, s.computeSpentEpoch / s.computeBudgetEpoch);
  writeBlocks($("budget-blocks"), 24, Math.round(share * 24));

  write($("stat-slots"), `${s.slotsActive} of ${s.slotsMax}`);
  writeBlocks($("slot-blocks"), s.slotsMax, s.slotsActive);
  return s;
}
