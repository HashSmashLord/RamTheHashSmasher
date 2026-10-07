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
//
// Which model: every `complete()` call may carry its own `model`. Solver slots
// always pass their assigned one (per-RAM roster in targets.js, or the
// `RAMHERD_LLM_MODEL` override, resolved by `modelOverride(env)` below). A call
// with no `model` (the coordinator today) uses the provider's default.
//
// Token budget: `max_tokens` defaults to 300. A call may pass `maxTokens` and
// `reasoning` (OpenRouter's reasoning control, e.g. `{ effort: 'low' }`).
// The coordinator does: `openrouter/auto` often routes to a reasoning model
// that spent all 300 tokens thinking and returned an empty answer.

/**
 * @typedef {object} LlmUsage
 * @property {number} promptTokens
 * @property {number} completionTokens
 * @property {number} totalTokens
 * @property {number|null} costUsd - null when the provider didn't report a cost (always null in mock mode).
 */

/**
 * @typedef {object} LlmProvider
 * @property {'mock'|'openrouter'|string} kind
 * @property {(req: { system?: string, prompt: string, model?: string, maxTokens?: number, reasoning?: object }) => Promise<{ text: string, mocked: boolean, model: string|null, usage: LlmUsage, finishReason: string|null, reasoningTokens?: number|null }>} complete
 */

/** Usage shape for a call that made no real request (mock mode, or a provider that reports none). */
function zeroUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: null };
}

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
    async complete({ prompt, model }) {
      const trimmed = String(prompt || '').trim();
      const excerpt = trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed;
      const wouldCall = model ? ` Assigned model (not called): ${model}.` : '';
      return {
        text: `[mock] no live model call was made (dry-run mode).${wouldCall} Prompt excerpt: "${excerpt}"`,
        mocked: true,
        model: model || null,
        usage: zeroUsage(),
        finishReason: 'stop',
      };
    },
  };
}

/**
 * A real OpenRouter-backed provider. Only constructed by `createLlmProvider`
 * when both the live flag and an API key are present; never constructed by
 * tests, which exercise it as a plain function against a fake `fetchImpl`.
 *
 * `model` is only the fallback for calls that don't name one; a per-call
 * `model` (what every solver slot sends) always wins.
 *
 * @param {{ apiKey: string, model?: string, fetchImpl?: typeof fetch }} opts
 * @returns {LlmProvider}
 */
export function createOpenRouterProvider({ apiKey, model: defaultModel = 'openrouter/auto', fetchImpl = fetch }) {
  if (!apiKey) throw new TypeError('createOpenRouterProvider requires an apiKey');
  return {
    kind: 'openrouter',
    async complete({ system, prompt, model, maxTokens = 300, reasoning }) {
      const useModel = model || defaultModel;
      const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: useModel,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: prompt },
          ],
          max_tokens: maxTokens,
          ...(reasoning ? { reasoning } : {}),
        }),
      });
      if (!res.ok) {
        throw new Error(`openrouter request failed: ${res.status}`);
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content ?? '';
      // Why generation stopped ("stop", or "length" when max_tokens ran out).
      // Kept rather than dropped: on a reasoning model, hidden reasoning counts
      // against max_tokens, and "length" with an empty `text` means the model
      // spent the whole budget reasoning and never wrote an answer. Without
      // this a caller cannot tell that apart from a model that chose to say
      // nothing (the 2026-10-07 live loop stall, see sandbox-activity.js).
      const finishReason = data?.choices?.[0]?.finish_reason ?? null;
      // OpenRouter always includes `usage` on the completed response (no
      // request flag needed): prompt/completion/total tokens by the model's
      // own tokenizer, and `cost` in USD actually charged to the account. A
      // field that's missing (rare, provider-dependent) stays null rather
      // than being coerced to 0, so a cost total downstream can tell "zero"
      // from "not reported" instead of silently understating real spend.
      const u = data?.usage;
      const usage = {
        promptTokens: Number.isFinite(u?.prompt_tokens) ? u.prompt_tokens : 0,
        completionTokens: Number.isFinite(u?.completion_tokens) ? u.completion_tokens : 0,
        totalTokens: Number.isFinite(u?.total_tokens) ? u.total_tokens : 0,
        costUsd: Number.isFinite(u?.cost) ? u.cost : null,
      };
      // Hidden reasoning tokens (already inside completionTokens), when reported.
      const rt = u?.completion_tokens_details?.reasoning_tokens;
      const reasoningTokens = Number.isFinite(rt) ? rt : null;
      return { text, mocked: false, model: useModel, usage, finishReason, reasoningTokens };
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

/**
 * Optional `RAMHERD_LLM_MODEL`: one OpenRouter slug forced on every slot (e.g.
 * to test with a single cheap model). Unset or blank -> null, meaning each
 * slot uses its own roster model. This is the only place it is read.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function modelOverride(env = process.env) {
  const value = String(env.RAMHERD_LLM_MODEL ?? '').trim();
  return value || null;
}

export function createLlmProvider(env = process.env) {
  if (!isLiveMode(env)) return createMockLlmProvider();
  return createOpenRouterProvider({
    apiKey: env.OPENROUTER_API_KEY,
    // Fallback for calls that name no model (the coordinator). Solver slots
    // always name theirs.
    model: modelOverride(env) || 'openrouter/auto',
  });
}
