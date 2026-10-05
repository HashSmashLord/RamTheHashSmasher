import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { loadConfig } from '../server/config.js';

const budgetConfig = loadConfig({}).budget;

test('store with no RAMHERD_LLM_MODEL: six slots get the six roster models, in order, still mocked', async () => {
  const store = createStore({ budgetConfig, env: {} });
  assert.equal(store.llmProvider.kind, 'mock');
  store.slotManager.setSlotCount(6);
  const slots = store.slotManager.getSlots();
  assert.deepEqual(slots.map((s) => s.assignment.model), [
    'anthropic/claude-opus-5.5',
    'anthropic/claude-fable-5.1',
    'openai/gpt-6.1-sol-pro',
    'z-ai/glm-5.3-prime',
    'deepseek/deepseek-v4-pro',
    'qwen/qwen3.8-max-prime',
  ]);
  const after = await store.slotManager.advance(slots[3].id);
  assert.match(after.feed.at(-1).message, /\[mock\].*z-ai\/glm-5\.3-prime/);
});

test('store with RAMHERD_LLM_MODEL set: every slot uses the override, and it stays mock without the live gate', async () => {
  const store = createStore({ budgetConfig, env: { RAMHERD_LLM_MODEL: 'openrouter/forced', OPENROUTER_API_KEY: 'sk-fake' } });
  assert.equal(store.llmProvider.kind, 'mock');
  store.slotManager.setSlotCount(6);
  for (const s of store.slotManager.getSlots()) {
    assert.equal(s.assignment.model, 'openrouter/forced');
    assert.equal(s.assignment.modelSource, 'override');
  }
  const [first] = store.slotManager.getSlots();
  const after = await store.slotManager.advance(first.id);
  assert.match(after.feed.at(-1).message, /openrouter\/forced/);
});

test('a real LLM call\'s usage reaches costLedger, backend-only (never on the public slot)', async () => {
  const store = createStore({ budgetConfig, env: {} });
  store.slotManager.setSlotCount(1);
  const [slot] = store.slotManager.getSlots();
  const after = await store.slotManager.advance(slot.id); // idle -> thinking
  assert.equal(after.costUsd, undefined);
  assert.equal(store.costLedger.forSlot(slot.id).entries.length, 1);
});

test('an owned RAM\'s known compute cost also charges its own funding account', async () => {
  const store = createStore({ budgetConfig, env: {} });
  store.ramFunds.open('ram-9999', 'some-wallet');
  const owned = store.slotManager.createOwnedSlot({
    ramId: 'ram-9999', owner: 'some-wallet', track: 'sha256-r31-exploratory', approach: 'owner-pick', model: 'anthropic/claude-opus-5.5', brief: 'try something',
  });
  await store.slotManager.advance(owned.id); // mock mode: usage is zero/null, so nothing is charged
  assert.equal(store.ramFunds.get('ram-9999').totals.computeSpentUsd, 0);
  // Simulate a live call reporting a real known cost, same path a real OpenRouter response takes.
  store.costLedger.record({ slotId: owned.id, ramId: 'ram-9999', model: 'anthropic/claude-opus-5.5', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.015 } });
  assert.equal(store.ramFunds.get('ram-9999').totals.computeSpentUsd, 0.015);
});

test('a cost recorded against a RAM with no open funding account never throws', async () => {
  const store = createStore({ budgetConfig, env: {} });
  assert.doesNotThrow(() => {
    store.costLedger.record({ slotId: 'slot-x', ramId: 'ram-never-opened', model: 'm', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.01 } });
  });
});
