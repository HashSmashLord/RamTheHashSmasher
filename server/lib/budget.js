// Compute budget -> agent-slot allocator.
//
// Pure math over a fee total and a config object. Nothing here touches the
// ledger's source, the LLM provider, or a slot manager directly — callers
// (the slot manager, the HTTP layer) read `getAllocation()` and decide, as a
// separate deliberate step, whether to actually resize the slot pool.

/**
 * @typedef {object} BudgetConfig
 * @property {number} usdPerSlot - $ of compute budget that funds one parallel solver slot.
 * @property {number} allocationFraction - fraction of fees collected that becomes compute
 *   budget (0..1). The rest is modeled as going to treasury/other costs; not our concern here.
 * @property {number} minSlots - floor on slot count (0 is allowed: no budget, no slots).
 * @property {number} maxSlots - ceiling on slot count, independent of budget (a safety cap).
 */

/** @type {BudgetConfig} */
export const DEFAULT_BUDGET_CONFIG = {
  usdPerSlot: 5,
  allocationFraction: 1,
  minSlots: 0,
  maxSlots: 12,
};

function assertConfig(config) {
  const { usdPerSlot, allocationFraction, minSlots, maxSlots } = config;
  if (!Number.isFinite(usdPerSlot) || usdPerSlot <= 0) {
    throw new RangeError('usdPerSlot must be a positive finite number');
  }
  if (!Number.isFinite(allocationFraction) || allocationFraction < 0 || allocationFraction > 1) {
    throw new RangeError('allocationFraction must be between 0 and 1');
  }
  if (!Number.isInteger(minSlots) || minSlots < 0) {
    throw new RangeError('minSlots must be a non-negative integer');
  }
  if (!Number.isInteger(maxSlots) || maxSlots < minSlots) {
    throw new RangeError('maxSlots must be an integer >= minSlots');
  }
}

/**
 * Converts a fee total into a compute budget in USD.
 *
 * @param {number} feeTotalUsd
 * @param {BudgetConfig} [config]
 */
export function computeBudgetUsd(feeTotalUsd, config = DEFAULT_BUDGET_CONFIG) {
  if (!Number.isFinite(feeTotalUsd) || feeTotalUsd < 0) {
    throw new RangeError('feeTotalUsd must be a non-negative finite number');
  }
  assertConfig(config);
  return feeTotalUsd * config.allocationFraction;
}

/**
 * Decides how many parallel solver-agent slots a compute budget supports.
 *
 * @param {number} budgetUsd
 * @param {BudgetConfig} [config]
 */
export function computeSlotCount(budgetUsd, config = DEFAULT_BUDGET_CONFIG) {
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) {
    throw new RangeError('budgetUsd must be a non-negative finite number');
  }
  assertConfig(config);
  const raw = Math.floor(budgetUsd / config.usdPerSlot);
  return Math.min(config.maxSlots, Math.max(config.minSlots, raw));
}

/**
 * Convenience: fee total -> full allocation snapshot in one call.
 *
 * @param {number} feeTotalUsd
 * @param {BudgetConfig} [config]
 */
export function computeAllocation(feeTotalUsd, config = DEFAULT_BUDGET_CONFIG) {
  const budgetUsd = computeBudgetUsd(feeTotalUsd, config);
  const slotCount = computeSlotCount(budgetUsd, config);
  return {
    feeTotalUsd,
    budgetUsd,
    slotCount,
    usdPerSlot: config.usdPerSlot,
    allocationFraction: config.allocationFraction,
    minSlots: config.minSlots,
    maxSlots: config.maxSlots,
  };
}
