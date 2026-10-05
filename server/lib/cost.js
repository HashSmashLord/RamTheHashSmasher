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
// nothing here edits or removes a past entry, only adds one. In mock mode
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

/**
 * @param {{ now?: () => string }} [opts]
 */
export function createCostLedger({ now = () => new Date().toISOString() } = {}) {
  /** @type {Array<{ seq: number, ts: string, slotId: string, ramId: string|null, model: string|null, usage: import('./llm.js').LlmUsage, ref: string|null }>} */
  const entries = [];

  /**
   * Records one LLM call's usage against the slot (and, if it's an owned
   * RAM's slot, the RAM) that made it.
   *
   * @param {{ slotId: string, ramId?: string|null, model: string|null, usage: import('./llm.js').LlmUsage, ref?: string|null }} p
   */
  function record({ slotId, ramId = null, model, usage, ref = null }) {
    if (typeof slotId !== 'string' || !slotId) throw new TypeError('slotId is required');
    if (!usage || typeof usage !== 'object') throw new TypeError('usage is required');
    entries.push({
      seq: entries.length,
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
    });
  }

  function totals() {
    const t = emptyTotals();
    for (const e of entries) addInto(t, e.usage);
    return t;
  }

  function forSlot(slotId) {
    const t = emptyTotals();
    const matched = [];
    for (const e of entries) {
      if (e.slotId !== slotId) continue;
      addInto(t, e.usage);
      matched.push({ ...e, usage: { ...e.usage } });
    }
    return { slotId, totals: t, entries: matched };
  }

  function forRam(ramId) {
    const t = emptyTotals();
    const matched = [];
    for (const e of entries) {
      if (e.ramId !== ramId) continue;
      addInto(t, e.usage);
      matched.push({ ...e, usage: { ...e.usage } });
    }
    return { ramId, totals: t, entries: matched };
  }

  function byModel() {
    /** @type {Map<string, ReturnType<typeof emptyTotals>>} */
    const perModel = new Map();
    for (const e of entries) {
      const key = e.model || 'unknown';
      if (!perModel.has(key)) perModel.set(key, emptyTotals());
      addInto(perModel.get(key), e.usage);
    }
    return [...perModel.entries()].map(([model, t]) => ({ model, totals: t }));
  }

  return { record, totals, forSlot, forRam, byModel, list: () => entries.map((e) => ({ ...e, usage: { ...e.usage } })) };
}
