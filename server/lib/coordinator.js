// Coordinator ("main") agent.
//
// Read-only and informational, by construction, not just by promise:
//   - `createCoordinatorView` wraps the slot manager, ledger and allocator
//     behind an object that has *only* getters on it (`getSlots`,
//     `getLedgerSnapshot`, `getAllocation`). It is built here, once, and is
//     the only thing `createCoordinator` ever receives — never the real
//     slot manager or ledger, which carry `setSlotCount`/mutators.
//   - `createCoordinator` itself exposes exactly two methods, `getSummary`
//     and `ask`. Neither of them calls anything on the view beyond its
//     getters (there is nothing else to call), and neither takes an action:
//     `ask` returns text, it never resizes slots, moves fees, or writes to
//     the moderation queue.
//
// A reallocation (resizing slots) or a fee-ledger change is a separate,
// deliberate operation performed by the HTTP admin layer directly against
// the slot manager / fee source — never reachable through this module.
//
// Optional `costLedger` (server/lib/cost.js): a real `ask()` call still costs
// tokens, so it's recorded there too (under a fixed 'herder' id), same as a
// RAM's own calls in slots.js. Write-only from here, and not part of `ask`'s
// return value — the viewer-facing answer is unaffected either way.

/**
 * @param {{
 *   slotManager: { getSlots: () => any[] },
 *   ledger: { getSnapshot: () => any },
 *   getAllocation: () => any,
 * }} deps
 */
export function createCoordinatorView({ slotManager, ledger, getAllocation }) {
  // Object.freeze is a belt-and-suspenders touch; the real guarantee is that
  // only these three closures are reachable from the returned object at all.
  return Object.freeze({
    getSlots: () => slotManager.getSlots(),
    getLedgerSnapshot: () => ledger.getSnapshot(),
    getAllocation: () => getAllocation(),
  });
}

function summarize(view) {
  const slots = view.getSlots();
  const ledgerSnapshot = view.getLedgerSnapshot();
  const allocation = view.getAllocation();
  const active = slots.filter((s) => s.active);
  const byStatus = {};
  for (const slot of active) byStatus[slot.status] = (byStatus[slot.status] || 0) + 1;
  return {
    generatedAt: new Date().toISOString(),
    ledger: ledgerSnapshot,
    allocation,
    slotCount: { active: active.length, retired: slots.length - active.length, byStatus },
    slots: slots.map((s) => ({
      id: s.id,
      active: s.active,
      status: s.status,
      track: s.assignment.track,
      approach: s.assignment.approach,
      model: s.assignment.model,
      lastFeedEntry: s.feed[s.feed.length - 1] || null,
      suggestionCount: s.suggestions.length,
    })),
  };
}

function buildPrompt(summary, question) {
  const lines = [
    `Fees collected (USD): ${summary.ledger.totalUsd}`,
    `Compute budget (USD): ${summary.allocation.budgetUsd}`,
    `Active slots: ${summary.slotCount.active} (max ${summary.allocation.maxSlots}, $${summary.allocation.usdPerSlot}/slot)`,
    `Status breakdown: ${JSON.stringify(summary.slotCount.byStatus)}`,
    ...summary.slots.map(
      (s) => `- ${s.id} [${s.active ? 'active' : 'retired'}/${s.status}] ${s.track} via ${s.approach} on ${s.model}: ${
        s.lastFeedEntry ? s.lastFeedEntry.message : 'no activity yet'
      }`,
    ),
  ];
  return `Current RAMherd state:\n${lines.join('\n')}\n\nViewer question: ${question}`;
}

/**
 * @param {{
 *   view: ReturnType<typeof createCoordinatorView>,
 *   llmProvider: import('./llm.js').LlmProvider,
 *   costLedger?: ReturnType<typeof import('./cost.js').createCostLedger>|null,
 * }} deps
 */
export function createCoordinator({ view, llmProvider, costLedger = null }) {
  if (!llmProvider || typeof llmProvider.complete !== 'function') {
    throw new TypeError('createCoordinator requires an llmProvider with complete()');
  }

  function getSummary() {
    return summarize(view);
  }

  /** @param {string} question */
  async function ask(question) {
    const trimmed = String(question || '').trim();
    if (!trimmed) return { ok: false, error: 'empty_question' };
    const summary = getSummary();
    const result = await llmProvider.complete({
      system:
        'You are the RAMherd coordinator agent. Answer only from the given state. ' +
        'You are read-only: you cannot start, stop, or resize agents, move funds, or approve ideas.',
      prompt: buildPrompt(summary, trimmed),
    });
    if (costLedger && result.usage) {
      // The Herder isn't a RAM/slot, but it's still a real LLM call when
      // live; recorded under a fixed pseudo-slot id so it shows up in totals
      // instead of going uncounted.
      costLedger.record({ slotId: 'herder', ramId: null, model: result.model, usage: result.usage, ref: summary.generatedAt });
    }
    return { ok: true, question: trimmed, answer: result.text, groundedAt: summary.generatedAt };
  }

  return Object.freeze({ getSummary, ask });
}
