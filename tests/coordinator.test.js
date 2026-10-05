import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoordinator, createCoordinatorView, HERDER_SYSTEM_PROMPT } from '../server/lib/coordinator.js';
import { createSlotManager } from '../server/lib/slots.js';
import { createMockFeeSource, createFeeLedger } from '../server/lib/ledger.js';
import { createMockLlmProvider } from '../server/lib/llm.js';
import { computeAllocation, DEFAULT_BUDGET_CONFIG } from '../server/lib/budget.js';
import { createCostLedger } from '../server/lib/cost.js';

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

test('ask() reports its own usage to costLedger under a fixed "herder" id, not the viewer-facing answer', async () => {
  const { ledger, slotManager } = buildRig();
  await ledger.refresh();
  const view = createCoordinatorView({ slotManager, ledger, getAllocation: () => computeAllocation(ledger.getSnapshot().totalUsd, DEFAULT_BUDGET_CONFIG) });
  const costLedger = createCostLedger();
  const coordinator = createCoordinator({ view, llmProvider: createMockLlmProvider(), costLedger });

  const result = await coordinator.ask('How many agents are active?');
  assert.equal(result.costUsd, undefined); // not part of the answer
  assert.equal(costLedger.forSlot('herder').entries.length, 1);
});

test('ask() works exactly as before with no costLedger (it is optional)', async () => {
  const { ledger, slotManager } = buildRig();
  await ledger.refresh();
  const view = createCoordinatorView({ slotManager, ledger, getAllocation: () => computeAllocation(ledger.getSnapshot().totalUsd, DEFAULT_BUDGET_CONFIG) });
  const coordinator = createCoordinator({ view, llmProvider: createMockLlmProvider() });
  const result = await coordinator.ask('How many agents are active?');
  assert.equal(result.ok, true);
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

function spyRig(text = 'an answer') {
  const calls = [];
  const provider = { kind: 'spy', async complete(req) { calls.push(req); return { text, mocked: true, model: null, usage: null }; } };
  return { calls, provider };
}

test('ask() sends the Herder system prompt, with real background and the honesty rules', async () => {
  const { ledger, slotManager } = buildRig();
  await ledger.refresh();
  const view = createCoordinatorView({ slotManager, ledger, getAllocation: () => computeAllocation(ledger.getSnapshot().totalUsd, DEFAULT_BUDGET_CONFIG) });
  const { calls, provider } = spyRig();
  const coordinator = createCoordinator({ view, llmProvider: provider });
  await coordinator.ask('What is HashSmash?');

  assert.equal(calls[0].system, HERDER_SYSTEM_PROMPT);
  // Background a viewer actually asks about.
  assert.match(HERDER_SYSTEM_PROMPT, /HashSmash/);
  assert.match(HERDER_SYSTEM_PROMPT, /sha256-r31.*sha256-r32.*sha3-256-r5.*sha3-256-r6.*blake3-r1.*blake3-r2/);
  assert.match(HERDER_SYSTEM_PROMPT, /Poseidon is not open/);
  assert.match(HERDER_SYSTEM_PROMPT, /log2\(T\).*Lower is better/);
  assert.match(HERDER_SYSTEM_PROMPT, /Aumasson \(@veorq\)/);
  assert.match(HERDER_SYSTEM_PROMPT, /Khovratovich \(@Khovr\)/);
  // Honesty and read-only rules that must never drop out.
  assert.match(HERDER_SYSTEM_PROMPT, /Nothing from this herd has been accepted/);
  assert.match(HERDER_SYSTEM_PROMPT, /not broken/);
  assert.match(HERDER_SYSTEM_PROMPT, /Viewers cannot direct a RAM/);
  assert.match(HERDER_SYSTEM_PROMPT, /read-only/);
  assert.match(HERDER_SYSTEM_PROMPT, /do not relay messages to RAMs/);
  // Live numbers stay out of the static prompt: they come from state.
  assert.doesNotMatch(HERDER_SYSTEM_PROMPT, /\$\d/);
});

test('ask() gives the model room to answer after reasoning (no fixed 300-token cap)', async () => {
  const { ledger, slotManager } = buildRig();
  await ledger.refresh();
  const view = createCoordinatorView({ slotManager, ledger, getAllocation: () => computeAllocation(ledger.getSnapshot().totalUsd, DEFAULT_BUDGET_CONFIG) });
  const { calls, provider } = spyRig();
  const coordinator = createCoordinator({ view, llmProvider: provider });
  await coordinator.ask('Can I tell a RAM what to do?');
  assert.ok(calls[0].maxTokens > 300);
  assert.deepEqual(calls[0].reasoning, { effort: 'low' });
});

test('ask() treats an empty completion as no answer, not a blank reply', async () => {
  const { ledger, slotManager } = buildRig();
  await ledger.refresh();
  const view = createCoordinatorView({ slotManager, ledger, getAllocation: () => computeAllocation(ledger.getSnapshot().totalUsd, DEFAULT_BUDGET_CONFIG) });
  for (const text of ['', '   \n', null]) {
    const coordinator = createCoordinator({ view, llmProvider: spyRig(text).provider });
    const result = await coordinator.ask('What happens if nothing is found?');
    assert.deepEqual(result, { ok: false, error: 'empty_answer' });
  }
});
