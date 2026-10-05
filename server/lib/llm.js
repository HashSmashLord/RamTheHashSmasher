// Swappable LLM provider interface.
//
// Every solver slot and the coordinator agent call `provider.complete(...)`
// and never touch `fetch`/API keys directly. That keeps "which model, if
// any, actually runs" a single config decision:
//
//   - default: `createMockLlmProvider()` — deterministic, offline, free.
//   - only if BOTH `OPENROUTER_API_KEY` is set AND `RAMHERD_LIVE=true`:
//     `createOpenRouterProvider(...)` makes real (low-cost) calls.
//
// `isLiveMode(env)` is the one place that decision gets made; nothing else in
// this codebase reads `RAMHERD_LIVE` directly. `createLlmProvider` uses it, and
// so does the HashSmash pipeline policy (`hashsmash.js`) to gate the paid judge
// stage behind the exact same switch.

/**
 * @typedef {object} LlmProvider
 * @property {'mock'|'openrouter'|string} kind
 * @property {(req: { system?: string, prompt: string }) => Promise<{ text: string, mocked: boolean }>} complete
 */

/**
 * A provider that never calls out to the network. Produces short, visibly
 * synthetic text grounded in the prompt it was given, so a feed entry from
 * mock mode is never mistaken for a real model's claim.
 *
 * @returns {LlmProvider}
 */
export function createMockLlmProvider() {
  return {
    kind: 'mock',
    async complete({ prompt }) {
      const trimmed = String(prompt || '').trim();
      const excerpt = trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed;
      return {
        text: `[mock] no live model call was made (dry-run mode). Prompt excerpt: "${excerpt}"`,
        mocked: true,
      };
    },
  };
}

/**
 * A real OpenRouter-backed provider. Only constructed by `createLlmProvider`
 * when both the live flag and an API key are present; never constructed by
 * tests, which exercise it as a plain function against a fake `fetchImpl`.
 *
 * @param {{ apiKey: string, model?: string, fetchImpl?: typeof fetch }} opts
 * @returns {LlmProvider}
 */
export function createOpenRouterProvider({ apiKey, model = 'openrouter/auto', fetchImpl = fetch }) {
  if (!apiKey) throw new TypeError('createOpenRouterProvider requires an apiKey');
  return {
    kind: 'openrouter',
    async complete({ system, prompt }) {
      const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: prompt },
          ],
          max_tokens: 300,
        }),
      });
      if (!res.ok) {
        throw new Error(`openrouter request failed: ${res.status}`);
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content ?? '';
      return { text, mocked: false };
    },
  };
}

/**
 * The single switch between mock and live. Default is always mock: live
 * mode needs both an API key AND an explicit opt-in flag, so a bare
 * `OPENROUTER_API_KEY` sitting in the environment for some other tool never
 * silently turns on real spend here.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isLiveMode(env = process.env) {
  return env.RAMHERD_LIVE === 'true' && Boolean(env.OPENROUTER_API_KEY);
}

export function createLlmProvider(env = process.env) {
  if (!isLiveMode(env)) return createMockLlmProvider();
  return createOpenRouterProvider({
    apiKey: env.OPENROUTER_API_KEY,
    model: env.RAMHERD_LLM_MODEL || 'openrouter/auto',
  });
}
