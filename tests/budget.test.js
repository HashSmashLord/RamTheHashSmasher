import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBudgetUsd, computeSlotCount, computeAllocation, DEFAULT_BUDGET_CONFIG, withLaunchCeiling, SLOTS_PER_CONFIRMED_LAUNCH } from '../server/lib/budget.js';

test('computeBudgetUsd applies the allocation fraction', () => {
  assert.equal(computeBudgetUsd(100, { ...DEFAULT_BUDGET_CONFIG, allocationFraction: 1 }), 100);
  assert.equal(computeBudgetUsd(100, { ...DEFAULT_BUDGET_CONFIG, allocationFraction: 0.5 }), 50);
  assert.equal(computeBudgetUsd(100, { ...DEFAULT_BUDGET_CONFIG, allocationFraction: 0 }), 0);
});

test('computeBudgetUsd rejects a negative fee total', () => {
  assert.throws(() => computeBudgetUsd(-1), RangeError);
});

test('computeSlotCount divides budget by the configured $-per-slot, floored', () => {
  const config = { usdPerSlot: 5, allocationFraction: 1, minSlots: 0, maxSlots: 100 };
  assert.equal(computeSlotCount(0, config), 0);
  assert.equal(computeSlotCount(4.99, config), 0);
  assert.equal(computeSlotCount(5, config), 1);
  assert.equal(computeSlotCount(24.99, config), 4);
  assert.equal(computeSlotCount(25, config), 5);
});

test('computeSlotCount is clamped to [minSlots, maxSlots]', () => {
  const config = { usdPerSlot: 1, allocationFraction: 1, minSlots: 2, maxSlots: 6 };
  assert.equal(computeSlotCount(0, config), 2); // floor wins even with no budget
  assert.equal(computeSlotCount(3, config), 3);
  assert.equal(computeSlotCount(1000, config), 6); // ceiling wins no matter how much budget
});

test('the $-per-slot ratio is a config value, not hardcoded: changing it changes the result', () => {
  const cheap = computeSlotCount(100, { usdPerSlot: 1, allocationFraction: 1, minSlots: 0, maxSlots: 1000 });
  const expensive = computeSlotCount(100, { usdPerSlot: 25, allocationFraction: 1, minSlots: 0, maxSlots: 1000 });
  assert.equal(cheap, 100);
  assert.equal(expensive, 4);
});

test('computeSlotCount rejects a bad config', () => {
  assert.throws(() => computeSlotCount(10, { usdPerSlot: 0, allocationFraction: 1, minSlots: 0, maxSlots: 1 }), RangeError);
  assert.throws(() => computeSlotCount(10, { usdPerSlot: 1, allocationFraction: 2, minSlots: 0, maxSlots: 1 }), RangeError);
  assert.throws(() => computeSlotCount(10, { usdPerSlot: 1, allocationFraction: 1, minSlots: 5, maxSlots: 1 }), RangeError);
});

test('computeAllocation ties fee total straight through to a slot count', () => {
  const config = { usdPerSlot: 10, allocationFraction: 0.8, minSlots: 0, maxSlots: 20 };
  const allocation = computeAllocation(100, config);
  assert.equal(allocation.feeTotalUsd, 100);
  assert.equal(allocation.budgetUsd, 80);
  assert.equal(allocation.slotCount, 8);
  assert.equal(allocation.usdPerSlot, 10);
});

test('withLaunchCeiling: +1 roster seat of ceiling per confirmed launch, pure, never below the base', () => {
  const base = { usdPerSlot: 5, allocationFraction: 1, minSlots: 0, maxSlots: 12 };
  assert.equal(SLOTS_PER_CONFIRMED_LAUNCH, 1);
  assert.equal(withLaunchCeiling(base, 0).maxSlots, 12);
  assert.equal(withLaunchCeiling(base, 3).maxSlots, 15);
  assert.equal(withLaunchCeiling(base, 3, 2).maxSlots, 18);
  assert.equal(base.maxSlots, 12); // the input config is never mutated
  assert.throws(() => withLaunchCeiling(base, -1), RangeError);
  assert.throws(() => withLaunchCeiling(base, 1.5), RangeError);
  assert.throws(() => withLaunchCeiling(base, 1, -1), RangeError);
});

test('a grown ceiling is still only a cap: fees must pay for every seat under it', () => {
  const grown = withLaunchCeiling({ usdPerSlot: 5, allocationFraction: 1, minSlots: 0, maxSlots: 12 }, 3);
  assert.equal(computeAllocation(30, grown).slotCount, 6); // $30 funds 6, ceiling 15 doesn't add seats
  assert.equal(computeAllocation(1000, grown).slotCount, 15); // capped at the grown ceiling, not 12
  assert.equal(computeAllocation(1000, grown).maxSlots, 15);
});
