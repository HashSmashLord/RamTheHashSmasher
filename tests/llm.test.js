import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlmProvider, createMockLlmProvider, createOpenRouterProvider, isLiveMode } from '../server/lib/llm.js';

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
