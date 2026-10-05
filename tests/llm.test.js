import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlmProvider, createMockLlmProvider, createOpenRouterProvider, isLiveMode, modelOverride } from '../server/lib/llm.js';

test('mock provider never touches the network and labels its output as mocked', async () => {
  const provider = createMockLlmProvider();
  const result = await provider.complete({ prompt: 'what next?' });
  assert.equal(provider.kind, 'mock');
  assert.equal(result.mocked, true);
  assert.match(result.text, /mock/);
});

test('createLlmProvider defaults to mock with no env set at all', () => {
  const provider = createLlmProvider({});
  assert.equal(provider.kind, 'mock');
});

test('createLlmProvider stays mock if the API key is set but RAMHERD_LIVE is not', () => {
  const provider = createLlmProvider({ OPENROUTER_API_KEY: 'sk-fake' });
  assert.equal(provider.kind, 'mock');
});

test('createLlmProvider stays mock if RAMHERD_LIVE=true but there is no API key', () => {
  const provider = createLlmProvider({ RAMHERD_LIVE: 'true' });
  assert.equal(provider.kind, 'mock');
});

test('createLlmProvider only goes live with both RAMHERD_LIVE=true and an API key', () => {
  const provider = createLlmProvider({ RAMHERD_LIVE: 'true', OPENROUTER_API_KEY: 'sk-fake' });
  assert.equal(provider.kind, 'openrouter');
});

test('createOpenRouterProvider makes exactly one HTTP call per complete(), using the injected fetch', async () => {
  let calls = 0;
  let sawAuth;
  const fakeFetch = async (url, opts) => {
    calls += 1;
    sawAuth = opts.headers.Authorization;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'reduced-round trail found' } }] }),
    };
  };
  const provider = createOpenRouterProvider({ apiKey: 'sk-fake', fetchImpl: fakeFetch });
  const result = await provider.complete({ prompt: 'what next?' });
  assert.equal(calls, 1);
  assert.equal(sawAuth, 'Bearer sk-fake');
  assert.equal(result.text, 'reduced-round trail found');
  assert.equal(result.mocked, false);
});

test('createOpenRouterProvider surfaces a failed HTTP response as an error', async () => {
  const fakeFetch = async () => ({ ok: false, status: 402 });
  const provider = createOpenRouterProvider({ apiKey: 'sk-fake', fetchImpl: fakeFetch });
  await assert.rejects(() => provider.complete({ prompt: 'x' }), /402/);
});

test('createOpenRouterProvider requires an apiKey', () => {
  assert.throws(() => createOpenRouterProvider({ apiKey: '' }), TypeError);
});

test('isLiveMode needs both RAMHERD_LIVE=true and an API key', () => {
  assert.equal(isLiveMode({}), false);
  assert.equal(isLiveMode({ RAMHERD_LIVE: 'true' }), false);
  assert.equal(isLiveMode({ OPENROUTER_API_KEY: 'x' }), false);
  assert.equal(isLiveMode({ RAMHERD_LIVE: 'true', OPENROUTER_API_KEY: 'x' }), true);
});

// --- per-call model ---

function recordingFetch() {
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  return { bodies, fetchImpl };
}

test('createOpenRouterProvider sends the per-call model, not its default', async () => {
  const { bodies, fetchImpl } = recordingFetch();
  const provider = createOpenRouterProvider({ apiKey: 'sk-fake', model: 'openrouter/auto', fetchImpl });
  const result = await provider.complete({ prompt: 'x', model: 'z-ai/glm-5.3-prime' });
  assert.equal(bodies[0].model, 'z-ai/glm-5.3-prime');
  assert.equal(result.model, 'z-ai/glm-5.3-prime');
});

test('createOpenRouterProvider falls back to its default model when a call names none', async () => {
  const { bodies, fetchImpl } = recordingFetch();
  const provider = createOpenRouterProvider({ apiKey: 'sk-fake', model: 'some/default', fetchImpl });
  await provider.complete({ prompt: 'x' });
  assert.equal(bodies[0].model, 'some/default');
});

test('mock provider reports the model it was asked for but never calls it', async () => {
  const result = await createMockLlmProvider().complete({ prompt: 'x', model: 'qwen/qwen3.8-max-prime' });
  assert.equal(result.mocked, true);
  assert.equal(result.model, 'qwen/qwen3.8-max-prime');
  assert.match(result.text, /not called/);
});

test('mock provider reports honestly-zero usage, not a fabricated cost', async () => {
  const result = await createMockLlmProvider().complete({ prompt: 'x' });
  assert.deepEqual(result.usage, { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: null });
});

test('createOpenRouterProvider reads real token counts and cost straight off the response', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160, cost: 0.00234 },
    }),
  });
  const provider = createOpenRouterProvider({ apiKey: 'sk-fake', fetchImpl: fakeFetch });
  const result = await provider.complete({ prompt: 'x' });
  assert.deepEqual(result.usage, { promptTokens: 120, completionTokens: 40, totalTokens: 160, costUsd: 0.00234 });
});

test('createOpenRouterProvider leaves costUsd null (not 0) when the response omits it', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }),
  });
  const provider = createOpenRouterProvider({ apiKey: 'sk-fake', fetchImpl: fakeFetch });
  const result = await provider.complete({ prompt: 'x' });
  assert.equal(result.usage.costUsd, null);
  assert.equal(result.usage.totalTokens, 12);
});

test('createOpenRouterProvider defaults usage to zero when the response has no usage field at all', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
  const provider = createOpenRouterProvider({ apiKey: 'sk-fake', fetchImpl: fakeFetch });
  const result = await provider.complete({ prompt: 'x' });
  assert.deepEqual(result.usage, { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: null });
});

test('modelOverride reads RAMHERD_LLM_MODEL, and treats unset or blank as no override', () => {
  assert.equal(modelOverride({}), null);
  assert.equal(modelOverride({ RAMHERD_LLM_MODEL: '' }), null);
  assert.equal(modelOverride({ RAMHERD_LLM_MODEL: '   ' }), null);
  assert.equal(modelOverride({ RAMHERD_LLM_MODEL: ' openai/gpt-6.1-sol-pro ' }), 'openai/gpt-6.1-sol-pro');
});

test('RAMHERD_LLM_MODEL alone never turns live mode on', () => {
  assert.equal(createLlmProvider({ RAMHERD_LLM_MODEL: 'anthropic/claude-opus-5.5' }).kind, 'mock');
  assert.equal(createLlmProvider({ RAMHERD_LLM_MODEL: 'x', OPENROUTER_API_KEY: 'sk-fake' }).kind, 'mock');
});
