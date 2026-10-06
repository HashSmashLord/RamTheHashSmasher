// Per-RAM compute-cost ledger: tokens and real USD spend per LLM call.
//
// Backend-only, on purpose: nothing here is wired to any HTTP route yet (no
// public or admin endpoint reads it). It exists so the real numbers are
// captured from day one instead of being reconstructed later, not because
// the frontend is ready to show them.
//
// Tracks tokens and USD, NOT a SOL amount: OpenRouter bills in USD, and
// turning that into SOL would need a live SOL/USD price this module doesn't
// have. Guessing one would make the number look precise while being wrong;
// a real SOL figure needs a price oracle wired in deliberately, later.
//
// Entries are append-only (same transparency norm as slots.js's feed):
// nothing here edits a past entry, only adds one (the oldest raw entries age
// out past MAX_COST_ENTRIES; see below). In mock mode
// every call records zero tokens and a null cost (llm.js never fabricates
// usage for a call it didn't actually make), so totals stay honestly zero
// until RAMHERD_LIVE is on.

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function emptyTotals() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, costUnknownCalls: 0, calls: 0 };
}

function addInto(totals, usage) {
  totals.calls += 1;
  totals.promptTokens += usage.promptTokens || 0;
  totals.completionTokens += usage.completionTokens || 0;
  totals.totalTokens += usage.totalTokens || 0;
  if (typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd)) {
    totals.costUsd = round6(totals.costUsd + usage.costUsd);
  } else {
    totals.costUnknownCalls += 1;
  }
}

// Bounded memory: the public Herder-ask route records one entry per call, so
// the raw entry list keeps only the most recent MAX_COST_ENTRIES (same
// bounding as ledger.js's mock fee history) and an old entry is dropped, never
// edited. Totals are NOT lost when that happens: totals(), forSlot(),
// forRam() and byModel() read running all-time aggregates updated on every
// record(), so they stay exact; only the per-entry detail is windowed.
// Aggregate maps are keyed by slot id, RAM id and model, all server-chosen
// (never request text), so they stay small.
export const MAX_COST_ENTRIES = 1000;

/**
 * @param {{ now?: () => string, maxEntries?: number }} [opts]
 */
export function createCostLedger({ now = () => new Date().toISOString(), maxEntries = MAX_COST_ENTRIES } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new RangeError('maxEntries must be a positive integer');
  /** @type {Array<{ seq: number, ts: string, slotId: string, ramId: string|null, model: string|null, usage: import('./llm.js').LlmUsage, ref: string|null }>} */
  const entries = [];
  let nextSeq = 0;
  const allTotals = emptyTotals();
  /** @type {Map<string, ReturnType<typeof emptyTotals>>} */
  const perSlot = new Map();
  /** @type {Map<string, ReturnType<typeof emptyTotals>>} */
  const perRam = new Map();
  /** @type {Map<string, ReturnType<typeof emptyTotals>>} */
  const perModel = new Map();

  function bump(map, key, usage) {
    if (!map.has(key)) map.set(key, emptyTotals());
    addInto(map.get(key), usage);
  }

  /**
   * Records one LLM call's usage against the slot (and, if it's an owned
   * RAM's slot, the RAM) that made it.
   *
   * @param {{ slotId: string, ramId?: string|null, model: string|null, usage: import('./llm.js').LlmUsage, ref?: string|null }} p
   */
  function record({ slotId, ramId = null, model, usage, ref = null }) {
    if (typeof slotId !== 'string' || !slotId) throw new TypeError('slotId is required');
    if (!usage || typeof usage !== 'object') throw new TypeError('usage is required');
    const entry = {
      seq: nextSeq++,
      ts: now(),
      slotId,
      ramId,
      model: model || null,
      usage: {
        promptTokens: usage.promptTokens || 0,
        completionTokens: usage.completionTokens || 0,
        totalTokens: usage.totalTokens || 0,
        costUsd: typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) ? usage.costUsd : null,
      },
      ref,
    };
    entries.push(entry);
    if (entries.length > maxEntries) entries.shift();
    addInto(allTotals, entry.usage);
    bump(perSlot, slotId, entry.usage);
    if (ramId !== null && ramId !== undefined) bump(perRam, ramId, entry.usage);
    bump(perModel, entry.model || 'unknown', entry.usage);
  }

  const copyEntry = (e) => ({ ...e, usage: { ...e.usage } });

  function totals() {
    return { ...allTotals };
  }

  function forSlot(slotId) {
    const t = perSlot.get(slotId);
    return { slotId, totals: t ? { ...t } : emptyTotals(), entries: entries.filter((e) => e.slotId === slotId).map(copyEntry) };
  }

  function forRam(ramId) {
    const t = perRam.get(ramId);
    return { ramId, totals: t ? { ...t } : emptyTotals(), entries: entries.filter((e) => e.ramId === ramId).map(copyEntry) };
  }

  function byModel() {
    return [...perModel.entries()].map(([model, t]) => ({ model, totals: { ...t } }));
  }

  /**
   * Real spend in the last `windowMs`, summed from the real per-call entries
   * (each has its own real `ts`) -- not an estimate, not the all-time total.
   * Bounded by the same windowing as `entries` itself: if more than
   * `maxEntries` real calls happen inside the window, the oldest ones in that
   * window have already aged out and this undercounts rather than overcounts
   * -- the same honest tradeoff the rest of this module already makes for
   * per-entry detail (totals() itself is still exact; only this windowed cut
   * of it depends on entries still being around).
   * @param {number} windowMs
   */
  function epochTotals(windowMs) {
    // Date.parse(now()), not Date.now(): consistent with every entry's own ts (also now()),
    // and real-tested 2026-10-06 that skipping this made every entry compare against the
    // real wall clock instead of an injected test clock, silently excluding everything.
    const cutoff = Date.parse(now()) - windowMs;
    const t = emptyTotals();
    for (const e of entries) {
      if (Date.parse(e.ts) >= cutoff) addInto(t, e.usage);
    }
    return t;
  }

  return { record, totals, epochTotals, forSlot, forRam, byModel, list: () => entries.map(copyEntry) };
}
