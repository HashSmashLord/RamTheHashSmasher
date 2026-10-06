import { loadConfig, loadDotEnv } from './config.js';
import { createApp } from './app.js';
import { autoSeedPolicy, seedRosterFunding, startRosterSandboxes } from './lib/autoseed.js';
import { pumpFeePolicy } from './lib/pumpfee.js';

loadDotEnv();
const config = loadConfig();
if (config.adminToken === 'dev-admin-token') {
  console.warn('herd: using the default dev admin token. Set ADMIN_TOKEN before exposing this beyond localhost.');
}
const app = createApp(config);
// Auto-seed (opt-in, RAMHERD_AUTO_SEED=true; see lib/autoseed.js). createApp
// has already built the whole store (ledger, slot and sandbox managers), so
// funding + reallocation run here, awaited, before listen: the first request
// sees funded slots. Sandbox starts take seconds each, so they run after
// listen in the background and never block or crash boot.
const autoSeed = autoSeedPolicy(process.env);
const seeded = autoSeed.enabled ? await seedRosterFunding(app.store, { budgetConfig: config.budget, log: config.log }) : null;
// Real idea-queue persistence (server/lib/moderation.js): the queue's own records
// rehydrated already, inside createApp() above -- this is the one remaining step, now
// that the roster (and any rehydrated owned slots) actually exist, replaying each
// approved idea's real attachment onto today's slots. Runs regardless of autoSeed: an
// idea approved onto an owned (launchpad) slot has nothing to do with roster funding.
app.store.ideaQueue.reattachApproved((slotId, idea) => app.store.slotManager.attachSuggestion(slotId, idea));
const address = await app.listen();
console.log(`herd listening on http://${address.address}:${address.port}`);
// Runs whenever auto-seed is on, regardless of whether roster funding (above)
// succeeded: an owned (launchpad) slot's sandbox has nothing to do with the
// roster's funding step, and used to silently never restart if that step
// failed for any reason. Roster sandboxes are still skipped if the roster
// itself never got funded (startRosterSandboxes only targets active slots).
if (autoSeed.enabled) startRosterSandboxes(app.store, { log: config.log });

// Real pump.fun fee reader (RAMHERD_FEE_SOURCE=onchain; server/lib/pumpfee.js): the fee
// ledger's own refresh() is otherwise only called on boot and after an admin mutation
// (see store.js), which would leave "Fees collected, lifetime" frozen at whatever it read
// on the last restart for a long-running server. A periodic refresh is the real source's
// only way to ever see a newer fee. Off entirely unless the real source itself is on; a
// failed refresh (RPC hiccup, CoinGecko down) just logs and tries again next tick, never
// crashes the process.
const PUMP_FEE_REFRESH_MS = 10 * 60 * 1000; // 10 minutes: plenty fresh, gentle on the free public RPC/CoinGecko
if (pumpFeePolicy(process.env).enabled) {
  // Kicked off here, after listen(), not awaited: the real scan can take real minutes
  // (real-tested 2026-10-06 against the live treasury), and this must never delay the
  // server coming up. Without this, a fresh boot sits at the ledger's untouched-since-
  // construction $0 for up to the first full PUMP_FEE_REFRESH_MS tick -- a real, honest,
  // but needlessly long "nothing collected yet" window right after every restart.
  const refreshPumpFee = () =>
    Promise.all([
      app.store.ledger.refresh().catch((err) => config.log(`pumpfee: refresh failed, will retry next tick: ${err?.message || err}`)),
      // Same real ZEC/USD price used to show the fee total a second way (server/lib/pumpfee.js
      // createCoinGeckoZecPriceSource) -- refreshed alongside the fee itself, not fetched
      // per-request, so a CoinGecko hiccup here never blocks or slows down a real page load.
      app.store.refreshZecPrice().catch((err) => config.log(`pumpfee: ZEC price refresh failed, will retry next tick: ${err?.message || err}`)),
    ]);
  refreshPumpFee();
  setInterval(refreshPumpFee, PUMP_FEE_REFRESH_MS).unref();
}

// Real changelog (server/lib/changelog.js): this repo's own public commit history from
// GitHub's public API. Always-on (see store.js for why, unlike the opt-in integrations
// above) -- kicked off here, after listen(), not awaited, same reasoning as the pump-fee
// refresh: a slow or rate-limited GitHub call must never delay the server coming up.
// refresh() itself catches its own failures and keeps the last good cache, so this never
// needs a .catch() here and can never crash the process.
const CHANGELOG_REFRESH_MS = 10 * 60 * 1000; // 10 minutes: fresh enough for a commit log, well inside GitHub's unauthenticated 60/hour rate limit
app.store.changelog.refresh();
setInterval(() => app.store.changelog.refresh(), CHANGELOG_REFRESH_MS).unref();

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
