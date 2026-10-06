// Auto-seed on boot: opt-in with RAMHERD_AUTO_SEED=true (off by default).
//
// All state here is in memory, so every restart (a redeploy, `fly secrets
// set`, a crash) comes back with a $0 fee ledger, 0 roster slots and no
// sandboxes. Without this, an operator has to call POST /api/admin/fees,
// POST /api/admin/reallocate and POST /api/admin/slots/:id/sandbox/start for
// each slot by hand after every restart. With the flag on, server/index.js
// does the same thing in-process, using the same calls those routes make:
//
//   1. seedRosterFunding (awaited BEFORE the HTTP server listens): sets the
//      mock fee source to the smallest whole-cent total that funds the full
//      roster (ACTIVE_TRACKS.length RAMs, capped by RAMHERD_MAX_SLOTS), then
//      runs store.reallocateSlotsFromBudget(). Both are synchronous in-memory
//      steps, so the first request already sees funded slots.
//   2. startRosterSandboxes (started AFTER listen, not awaited): only when
//      sandboxes are on (RAMHERD_SANDBOX=e2b + E2B_API_KEY), starts a sandbox
//      for every active roster slot that has none. Each E2B create takes
//      seconds, so doing this before listen would hold up health checks.
//
// Guardrails:
//   - Funding/resizing (step 1) stays roster only: owned (launchpad) slots are
//     never resized (setSlotCount already skips them) and have their own
//     separate funding (ramfunds.js), untouched here.
//   - Sandbox starting (step 2) covers BOTH roster and owned slots (2026-10-06,
//     operator request): a launched RAM's own desk used to need a manual
//     admin call after every restart, same as the roster used to before this
//     file existed. Runs regardless of whether step 1 succeeded -- an owned
//     slot's sandbox has nothing to do with roster funding.
//   - Never lowers a fee total that is already high enough.
//   - Mock fee source only, same rule as POST /api/admin/fees.
//   - Never throws. A failed sandbox start is logged here and, through
//     slots.js, lands as a `sandbox-error` line on that slot's feed; the rest
//     still start. The operator can retry a failed one with the admin route.
//   - Each sandbox bills per second; server shutdown still kills them all.

import { computeAllocation } from './budget.js';
import { ACTIVE_TRACKS } from './targets.js';

/** @param {NodeJS.ProcessEnv} [env] */
export function autoSeedPolicy(env = process.env) {
  return Object.freeze({ enabled: env.RAMHERD_AUTO_SEED === 'true' });
}

/**
 * The smallest whole-cent fee total whose allocation reaches `slotCount`
 * (or maxSlots, if that is lower). Null when no fee can fund any slot
 * (allocationFraction 0).
 *
 * @param {number} slotCount
 * @param {import('./budget.js').BudgetConfig} config
 * @returns {{ feeUsd: number, targetSlots: number } | null}
 */
export function feeForSlots(slotCount, config) {
  if (!Number.isInteger(slotCount) || slotCount < 0) throw new RangeError('slotCount must be a non-negative integer');
  const targetSlots = Math.min(slotCount, config.maxSlots);
  if (computeAllocation(0, config).slotCount >= targetSlots) return { feeUsd: 0, targetSlots };
  if (!(config.allocationFraction > 0)) return null;
  let cents = Math.ceil(((targetSlots * config.usdPerSlot) / config.allocationFraction) * 100 - 1e-6);
  // Float rounding can land one cent short; step up until the math agrees.
  for (let i = 0; i < 100 && computeAllocation(cents / 100, config).slotCount < targetSlots; i++) cents += 1;
  const feeUsd = cents / 100;
  return computeAllocation(feeUsd, config).slotCount >= targetSlots ? { feeUsd, targetSlots } : null;
}

const isLive = (slot) => slot.sandbox && (slot.sandbox.status === 'running' || slot.sandbox.status === 'starting');

/**
 * Step 1: fund the roster and resize it. Never throws.
 *
 * @param {ReturnType<import('../store.js').createStore>} store
 * @param {{ budgetConfig: import('./budget.js').BudgetConfig, rosterSize?: number, log?: (line: string) => void }} opts
 */
export async function seedRosterFunding(store, { budgetConfig, rosterSize = ACTIVE_TRACKS.length, log = () => {} }) {
  try {
    if (store.feeSource.kind !== 'mock') {
      log(`auto-seed: skipped, fee source is "${store.feeSource.kind}", not mock-controllable.`);
      return { ok: false, reason: 'fee source is not mock-controllable' };
    }
    const need = feeForSlots(rosterSize, budgetConfig);
    if (!need) {
      log('auto-seed: skipped, RAMHERD_ALLOCATION_FRACTION is 0 so no fee total can fund a slot.');
      return { ok: false, reason: 'allocation fraction is 0' };
    }
    if (need.targetSlots < rosterSize) {
      log(`auto-seed: RAMHERD_MAX_SLOTS=${budgetConfig.maxSlots} caps the roster at ${need.targetSlots} of ${rosterSize} RAMs.`);
    }
    const before = (await store.ledger.refresh()).totalUsd;
    if (before < need.feeUsd) {
      store.feeSource.set(need.feeUsd, `auto-seed on boot: fund ${need.targetSlots} roster RAM(s)`);
      await store.ledger.refresh();
    }
    const allocation = store.reallocateSlotsFromBudget();
    const rosterSlotIds = store.slotManager.getSlots().filter((s) => s.kind === 'roster' && s.active).map((s) => s.id);
    log(`auto-seed: fee ledger $${store.ledger.getSnapshot().totalUsd} -> ${allocation.slotCount} roster slot(s) active (${rosterSlotIds.join(', ') || 'none'}).`);
    return { ok: true, feeUsd: store.ledger.getSnapshot().totalUsd, allocation, rosterSlotIds };
  } catch (err) {
    log(`auto-seed: funding step failed, server continues unseeded: ${err?.message || err}`);
    return { ok: false, reason: err?.message || String(err) };
  }
}

/**
 * Step 2: a sandbox for every active slot that has none -- roster AND owned
 * (launchpad) slots alike, so a real launched RAM's desk comes back on its
 * own after a restart, the same as the roster already did. Starts them in
 * parallel (the manager enforces RAMHERD_SANDBOX_MAX for roster slots; owned
 * slots are exempt from that cap, see sandbox.js's `exempt` Set -- a start
 * over the limit fails like any other and is logged). Never rejects.
 *
 * @param {ReturnType<import('../store.js').createStore>} store
 * @param {{ log?: (line: string) => void }} [opts]
 * @returns {Promise<{ skipped?: string, results: Array<{ slotId: string, kind: string, ok: boolean, sessionId?: string, error?: string }> }>}
 */
export async function startRosterSandboxes(store, { log = () => {} } = {}) {
  if (!store.slotManager.sandboxesEnabled) {
    const why = store.sandbox?.enabled ? 'RAMHERD_SANDBOX=e2b is set but E2B_API_KEY is missing' : 'sandboxes are off (RAMHERD_SANDBOX is not e2b)';
    if (store.sandbox?.enabled) log(`auto-seed: no sandboxes started, ${why}.`);
    return { skipped: why, results: [] };
  }
  const targets = store.slotManager.getSlots().filter((s) => (s.kind === 'roster' || s.kind === 'owned') && s.active && !isLive(s));
  // startSandbox already exempts owned slots from RAMHERD_SANDBOX_MAX internally
  // (slots.js's startSandboxNow, keyed off slot.kind) -- nothing extra to pass here.
  const settled = await Promise.allSettled(targets.map((s) => store.slotManager.startSandbox(s.id)));
  const results = settled.map((r, i) => {
    const slotId = targets[i].id;
    const kind = targets[i].kind;
    if (r.status === 'fulfilled') {
      log(`auto-seed: ${slotId} (${kind}) sandbox running (${r.value.sandbox?.sessionId}).`);
      return { slotId, kind, ok: true, sessionId: r.value.sandbox?.sessionId };
    }
    const error = r.reason?.message || String(r.reason);
    log(`auto-seed: ${slotId} (${kind}) sandbox failed to start, continuing with the rest: ${error}`);
    return { slotId, kind, ok: false, error };
  });
  const ok = results.filter((r) => r.ok).length;
  log(`auto-seed: ${ok}/${results.length} sandbox(es) started (roster + owned).`);
  return { results };
}
