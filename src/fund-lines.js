// HashRammers: the printed fund lines on the banner page (the home page). Fees collected, compute
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
  // The same real total a second way, in ZEC, at the real current ZEC/USD price
  // (server/lib/pumpfee.js createCoinGeckoZecPriceSource) -- null (so this stays blank)
  // until that real price has actually been fetched once, never a guessed conversion.
  write($("stat-fees-zec"), s.feesCollectedLifetimeZec != null ? `(≈ ${s.feesCollectedLifetimeZec} ZEC)` : "");

  // computeSpentEpoch is a real number straight off costLedger's own real per-call entries
  // (store.js getAllocation) -- genuinely $0 in mock mode (an honest zero, not "unknown"),
  // so `tracked` below is effectively always true once this is wired up; `!= null` is kept
  // as the real signal anyway, in case a future caller ever has a genuine reason to send null.
  const spent = $("stat-budget");
  const tracked = s.computeSpentEpoch != null;
  if (write(spent, tracked ? money(s.computeSpentEpoch) : "not tracked yet") && !first) print(spent);
  write(spent.parentElement.querySelector(".fund-of").firstChild, tracked ? "of " : "· budget = fees collected: ");
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
