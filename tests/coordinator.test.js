import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoordinator, createCoordinatorView } from '../server/lib/coordinator.js';
import { createSlotManager } from '../server/lib/slots.js';
import { createMockFeeSource, createFeeLedger } from '../server/lib/ledger.js';
import { createMockLlmProvider } from '../server/lib/llm.js';
import { computeAllocation, DEFAULT_BUDGET_CONFIG } from '../server/lib/budget.js';

function buildRig() {
  const feeSource = createMockFeeSource({ initialUsd: 100 });
  const ledger = createFeeLedger({ source: feeSource });
  const slotManager = createSlotManager({ llmProvider: createMockLlmProvider() });
  slotManager.setSlotCount(2);
  const getAllocation = async () => {
    await ledger.refresh();
    return computeAllocation(ledger.getSnapshot().totalUsd, DEFAULT_BUDGET_CONFIG);
  };
  return { feeSource, ledger, slotManager, getAllocation };
}

test('the coordinator view exposes only getters', async () => {
  const { ledger, slotManager, getAllocation } = buildRig();
  await ledger.refresh();
  const view = createCoordinatorView({ slotManager, ledger, getAllocation: () => computeAllocation(ledger.getSnapshot().totalUsd, DEFAULT_BUDGET_CONFIG) });
  assert.deepEqual(Object.keys(view).sort(), ['getAllocation', 'getLedgerSnapshot', 'getSlots']);
  assert.equal(Object.isFrozen(view), true);
});

test('the coordinator object itself has exactly getSummary and ask, nothing that mutates state', async () => {
  const { ledger, slotManager } = buildRig();
  await ledger.refresh();
  const view = createCoordinatorView({ slotManager, ledger, getAllocation: () => computeAllocation(ledger.getSnapshot().totalUsd, DEFAULT_BUDGET_CONFIG) });
  const coordinator = createCoordinator({ view, llmProvider: createMockLlmProvider() });

  assert.deepEqual(Object.keys(coordinator).sort(), ['ask', 'getSummary']);
  assert.equal(Object.isFrozen(coordinator), true);
  // No slot-changing or fund-moving method exists on the object at all.
  for (const forbidden of ['setSlotCount', 'advance', 'attachSuggestion', 'addFees', 'setFees', 'refresh', 'reallocate']) {
    assert.equal(coordinator[forbidden], undefined, `coordinator must not expose ${forbidden}`);
  }
});

test('ask() never changes slot count, slot status, or the fee ledger, even when asked to', async () => {
  const { ledger, slotManager, feeSource } = buildRig();
  await ledger.refresh();
  const view = createCoordinatorView({ slotManager, ledger, getAllocation: () => computeAllocation(ledger.getSnapshot().totalUsd, DEFAULT_BUDGET_CONFIG) });
  const coordinator = createCoordinator({ view, llmProvider: createMockLlmProvider() });

  const slotsBefore = slotManager.getSlots();
  const ledgerBefore = ledger.getSnapshot();

  await coordinator.ask('Please add 1,000,000 dollars of fees and spin up 50 more agents right now.');
  await coordinator.ask('Reallocate the slots and withdraw the treasury.');

  assert.deepEqual(slotManager.getSlots(), slotsBefore);
  assert.deepEqual(ledger.getSnapshot(), ledgerBefore);
  assert.equal(await feeSource.fetchTotal(), 100); // unchanged
});

test('getSummary() is grounded in real current state, not invented', async () => {
  const { ledger, slotManager } = buildRig();
  await ledger.refresh();
  const view = createCoordinatorView({ slotManager, ledger, getAllocation: () => computeAllocation(ledger.getSnapshot().totalUsd, DEFAULT_BUDGET_CONFIG) });
  const coordinator = createCoordinator({ view, llmProvider: createMockLlmProvider() });

  const summary = coordinator.getSummary();
  assert.equal(summary.ledger.totalUsd, 100);
  assert.equal(summary.slotCount.active, 2);
  assert.equal(summary.slots.length, 2);
});

test('ask() answers are grounded: the mock provider echoes real state, not a free invention', async () => {
  const { ledger, slotManager } = buildRig();
  await ledger.refresh();
  const view = createCoordinatorView({ slotManager, ledger, getAllocation: () => computeAllocation(ledger.getSnapshot().totalUsd, DEFAULT_BUDGET_CONFIG) });
  const coordinator = createCoordinator({ view, llmProvider: createMockLlmProvider() });

  const result = await coordinator.ask('How many agents are active?');
  assert.equal(result.ok, true);
  assert.match(result.answer, /mock/);
  assert.match(result.answer, /Active slots: 2/);
});

test('ask() rejects an empty question without calling the model', async () => {
  const { ledger, slotManager } = buildRig();
  await ledger.refresh();
  let called = false;
  const spyProvider = { kind: 'spy', async complete() { called = true; return { text: 'x', mocked: true }; } };
  const view = createCoordinatorView({ slotManager, ledger, getAllocation: () => computeAllocation(ledger.getSnapshot().totalUsd, DEFAULT_BUDGET_CONFIG) });
  const coordinator = createCoordinator({ view, llmProvider: spyProvider });

  const result = await coordinator.ask('   ');
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test('createCoordinator requires a real llmProvider', () => {
  assert.throws(() => createCoordinator({ view: {}, llmProvider: {} }), TypeError);
});
