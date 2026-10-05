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
