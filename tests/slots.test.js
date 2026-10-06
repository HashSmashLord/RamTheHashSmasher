import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlotManager, SLOT_STATUSES, updateBestResult, loopGrounding } from '../server/lib/slots.js';
import { createMockLlmProvider, createOpenRouterProvider } from '../server/lib/llm.js';
import { createCostLedger } from '../server/lib/cost.js';

function manager() {
  return createSlotManager({ llmProvider: createMockLlmProvider() });
}

test('updateBestResult only ever moves toward a genuinely better REAL number, never invents or regresses', () => {
  const ready = (timeLog2, successProbability) => ({ submissionState: 'ready', timeLog2, successProbability });
  const slot = { bestResult: null };
  assert.equal(updateBestResult(slot, null), null, 'nothing to learn from yet');
  assert.equal(slot.bestResult, null);
  updateBestResult(slot, ready(90, 0.5));
  assert.deepEqual(slot.bestResult, { timeLog2: 90, successProbability: 0.5 });
  // A worse real number never overwrites the best one.
  updateBestResult(slot, ready(95, 0.3));
  assert.deepEqual(slot.bestResult, { timeLog2: 90, successProbability: 0.5 });
  // A genuinely better real number on either axis does.
  updateBestResult(slot, ready(86, 0.3));
  assert.deepEqual(slot.bestResult, { timeLog2: 86, successProbability: 0.5 });
  updateBestResult(slot, ready(86, 0.9));
  assert.deepEqual(slot.bestResult, { timeLog2: 86, successProbability: 0.9 });
  // Non-numeric fields (e.g. a harness draft with no success claim) are ignored, not treated as zero.
  updateBestResult(slot, ready(null, null));
  assert.deepEqual(slot.bestResult, { timeLog2: 86, successProbability: 0.9 });
});

test('updateBestResult requires submissionState === \'ready\', even with real-looking positive numbers -- real bug, 2026-10-06: the organizer\'s own draft_claim() template carries success_probability 0.39 and a real time_log2 while still submission_state \'draft\', which used to flow straight into bestResult (and from there, into a real Yukon submission decision) as if it were this RAM\'s own finding. An unverified loop-draft is submission_state \'draft\' for exactly the same reason until it passes real adversarial verification (runLoopVerification), so checking state, not just candidate kind, correctly covers both', () => {
  const fresh = { bestResult: null };
  updateBestResult(fresh, { kind: 'harness-draft', submissionState: 'draft', timeLog2: 128, successProbability: 0.39 });
  assert.equal(fresh.bestResult, null, 'a draft-state candidate never establishes a first bestResult, however real-looking its numbers are');
  updateBestResult(fresh, { kind: 'loop-draft', submissionState: 'draft', timeLog2: 50, successProbability: 0.6 });
  assert.equal(fresh.bestResult, null, 'an unverified loop-draft is submission_state draft too, and is refused the same way');

  const withGenuine = { bestResult: { timeLog2: 86, successProbability: 0.3 } };
  updateBestResult(withGenuine, { kind: 'harness-draft', submissionState: 'draft', timeLog2: 10, successProbability: 0.99 });
  assert.deepEqual(withGenuine.bestResult, { timeLog2: 86, successProbability: 0.3 }, 'a draft-state candidate never overwrites a genuine prior result either, however much "better" its placeholder numbers look');

  // A genuinely 'ready' candidate still works exactly as before, loop-draft or research.
  updateBestResult(withGenuine, { kind: 'loop-draft', submissionState: 'ready', timeLog2: 80, successProbability: 0.35 });
  assert.deepEqual(withGenuine.bestResult, { timeLog2: 80, successProbability: 0.35 });
  updateBestResult(withGenuine, { kind: 'research', submissionState: 'ready', timeLog2: 70, successProbability: 0.4 });
  assert.deepEqual(withGenuine.bestResult, { timeLog2: 70, successProbability: 0.4 });
});

test('loopGrounding asks the model to beat its real best so far, or says honestly there is none yet', () => {
  const slot = { feed: [], bestResult: null, lastSearch: null };
  assert.match(loopGrounding(slot), /no real measured result yet this session/);
  slot.bestResult = { timeLog2: 86, successProbability: 0.9 };
  const g = loopGrounding(slot);
  assert.match(g, /best REAL result so far this session: time 2\^86, success probability 0\.9/);
  assert.match(g, /Try to beat it/);
});

test('setSlotCount(0) starts with no slots', () => {
  const m = manager();
  assert.equal(m.getActiveCount(), 0);
  assert.deepEqual(m.getSlots(), []);
});

test('setSlotCount(n) activates n slots, each assigned a real HashSmash track', () => {
  const m = manager();
  m.setSlotCount(3);
  const slots = m.getSlots();
  assert.equal(slots.length, 3);
  for (const slot of slots) {
    assert.equal(slot.active, true);
    assert.equal(slot.status, 'idle');
    assert.match(slot.assignment.track, /exploratory$/);
    assert.ok(slot.assignment.approach);
    assert.equal(slot.feed.length, 1);
    assert.equal(slot.feed[0].type, 'activated');
  }
});

test('growing the pool keeps existing slots untouched and only adds new ones', () => {
  const m = manager();
  m.setSlotCount(2);
  const before = m.getSlots().map((s) => s.id);
  m.setSlotCount(5);
  const after = m.getSlots();
  assert.equal(after.length, 5);
  assert.deepEqual(after.slice(0, 2).map((s) => s.id), before);
});

test('shrinking the pool retires slots instead of deleting them', () => {
  const m = manager();
  m.setSlotCount(4);
  m.setSlotCount(2);
  assert.equal(m.getActiveCount(), 2);
  assert.equal(m.getSlots().length, 4); // all four still visible
  const retired = m.getSlots().filter((s) => !s.active);
  assert.equal(retired.length, 2);
  assert.equal(retired[0].feed.at(-1).type, 'retired');
});

test('a retired slot keeps its full history and cannot be advanced', async () => {
  const m = manager();
  m.setSlotCount(1);
  const [slot] = m.getSlots();
  m.setSlotCount(0);
  await assert.rejects(() => m.advance(slot.id), /retired/);
});

test('advance() cycles idle -> thinking -> running-experiment -> submitted -> idle', async () => {
  const m = manager();
  m.setSlotCount(1);
  const [{ id }] = m.getSlots();

  let slot = await m.advance(id);
  assert.equal(slot.status, 'thinking');
  assert.ok(SLOT_STATUSES.includes(slot.status));

  slot = await m.advance(id);
  assert.equal(slot.status, 'running-experiment');

  slot = await m.advance(id);
  assert.equal(slot.status, 'submitted');

  slot = await m.advance(id);
  assert.equal(slot.status, 'idle');
  assert.equal(slot.feed.at(-1).type, 'cycle-reset');
});

test('the "thinking" step reports its usage to costLedger, keyed by slot id', async () => {
  const costLedger = createCostLedger();
  const m = createSlotManager({ llmProvider: createMockLlmProvider(), costLedger });
  m.setSlotCount(1);
  const [{ id }] = m.getSlots();
  await m.advance(id); // idle -> thinking: the one step that calls the provider
  const forSlot = costLedger.forSlot(id);
  assert.equal(forSlot.entries.length, 1);
  assert.equal(forSlot.totals.calls, 1); // mock mode: honestly zero tokens/cost, but it IS recorded
});

test('cost tracking never appears on the public slot snapshot', async () => {
  const costLedger = createCostLedger();
  const m = createSlotManager({ llmProvider: createMockLlmProvider(), costLedger });
  m.setSlotCount(1);
  const [{ id }] = m.getSlots();
  const slot = await m.advance(id);
  assert.equal(slot.costUsd, undefined);
  assert.equal(slot.usage, undefined);
  assert.equal(JSON.stringify(slot).includes('cost'), false);
});

test('without a costLedger, advance() works exactly as before (costLedger is optional)', async () => {
  const m = manager();
  m.setSlotCount(1);
  const [{ id }] = m.getSlots();
  const slot = await m.advance(id);
  assert.equal(slot.status, 'thinking');
});

test('an owned RAM\'s cost is recorded against its ramId, not just its slot id', async () => {
  const costLedger = createCostLedger();
  const m = createSlotManager({ llmProvider: createMockLlmProvider(), costLedger });
  const slot = m.createOwnedSlot({ ramId: 'ram-0001', owner: 'wallet', track: 'sha256-r31-exploratory', approach: 'owner-pick', model: 'anthropic/claude-opus-5.5', brief: 'x' });
  await m.advance(slot.id);
  assert.equal(costLedger.forRam('ram-0001').entries.length, 1);
});

test('advance() with outcome "failed" lands in the failed status', async () => {
  const m = manager();
  m.setSlotCount(1);
  const [{ id }] = m.getSlots();
  await m.advance(id); // idle -> thinking
  await m.advance(id); // thinking -> running-experiment
  const slot = await m.advance(id, { outcome: 'failed' });
  assert.equal(slot.status, 'failed');
});

test('advancing an unknown slot id throws', async () => {
  const m = manager();
  await assert.rejects(() => m.advance('nope'), RangeError);
});

test('the feed is append-only: there is no method to edit or remove a past entry', () => {
  const m = manager();
  m.setSlotCount(1);
  const [slot] = m.getSlots();
  assert.equal(slot.editFeed, undefined);
  assert.equal(slot.deleteFeedEntry, undefined);
  // snapshots are copies: mutating one never touches manager state
  slot.feed.push({ ts: 'fake', type: 'fake', message: 'fake' });
  assert.equal(m.getSlot(slot.id).feed.length, 1);
});

test('attachSuggestion appends labeled viewer-suggestion context, not a command', () => {
  const m = manager();
  m.setSlotCount(1);
  const [{ id }] = m.getSlots();
  const slot = m.attachSuggestion(id, { id: 'idea-1', text: 'try a SAT solver' });
  assert.equal(slot.suggestions.length, 1);
  assert.equal(slot.suggestions[0].label, 'viewer suggestion');
  assert.equal(slot.suggestions[0].text, 'try a SAT solver');
  assert.equal(slot.feed.at(-1).type, 'suggestion-attached');
});

test('createSlotManager requires a real llmProvider', () => {
  assert.throws(() => createSlotManager({ llmProvider: {} }), TypeError);
});

// --- pipelineRunner wiring: failure mapping (fake runner; the real-Python
// path is covered end to end in tests/hashsmash.test.js) ---

function fakeRunner(runCycle) {
  return { supportsTrack: (t) => t === 'sha256-r31-exploratory', runCycle };
}

async function toPipelineStep(m) {
  m.setSlotCount(1);
  const [{ id }] = m.getSlots();
  await m.advance(id);
  await m.advance(id);
  return id;
}

test('pipeline slot: an environment-blocked intake fails the slot and says it was the environment', async () => {
  const m = createSlotManager({
    llmProvider: createMockLlmProvider(),
    pipelineRunner: fakeRunner(async () => ({
      head: 'abc', workspace: '/ws', precheck: { ok: true, errors: [] },
      stages: [
        { stage: 'check', outcome: 'ok', exitCode: 0, status: 'mechanically_valid', detail: '' },
        { stage: 'intake', outcome: 'environment-blocked', exitCode: 3, status: null, detail: 'Docker is unavailable' },
      ],
    })),
  });
  const id = await toPipelineStep(m);
  const slot = await m.advance(id);
  assert.equal(slot.status, 'failed');
  assert.equal(slot.feed.at(-1).type, 'pipeline-blocked');
  assert.match(slot.feed.at(-1).message, /Docker is unavailable/);
});

test('pipeline slot: a runner exception fails the slot with a pipeline-error entry', async () => {
  const m = createSlotManager({
    llmProvider: createMockLlmProvider(),
    pipelineRunner: fakeRunner(async () => { throw new Error('no python'); }),
  });
  const id = await toPipelineStep(m);
  const slot = await m.advance(id);
  assert.equal(slot.status, 'failed');
  assert.equal(slot.feed.at(-1).type, 'pipeline-error');
  assert.equal(slot.pipeline.error, 'no python');
});

test('pipeline slot: a failed precheck never reports success', async () => {
  const m = createSlotManager({
    llmProvider: createMockLlmProvider(),
    pipelineRunner: fakeRunner(async () => ({ head: 'abc', workspace: '/ws', precheck: { ok: false, errors: ['claim.json: bad'] }, stages: [] })),
  });
  const id = await toPipelineStep(m);
  const slot = await m.advance(id);
  assert.equal(slot.status, 'failed');
  assert.equal(slot.feed.at(-1).type, 'pipeline-precheck');
});

// --- per-RAM models: what each slot actually sends to the provider ---

const ROSTER_MODELS = [
  'anthropic/claude-opus-5.5',
  'anthropic/claude-fable-5.1',
  'openai/gpt-6.1-sol-pro',
  'z-ai/glm-5.3-prime',
  'deepseek/deepseek-v4-pro',
  'qwen/qwen3.8-max-prime',
];

function spyProvider() {
  const calls = [];
  return {
    calls,
    provider: {
      kind: 'spy',
      async complete(req) {
        calls.push(req);
        return { text: 'spy', mocked: true, model: req.model ?? null };
      },
    },
  };
}

async function thinkAll(m) {
  for (const { id } of m.getSlots()) await m.advance(id); // idle -> thinking: the one LLM call
}

test('with no override, each of the six slots calls the provider with its own roster model', async () => {
  const { calls, provider } = spyProvider();
  const m = createSlotManager({ llmProvider: provider });
  m.setSlotCount(6);
  assert.deepEqual(m.getSlots().map((s) => [s.assignment.model, s.assignment.modelSource]), ROSTER_MODELS.map((x) => [x, 'roster']));
  await thinkAll(m);
  assert.deepEqual(calls.map((c) => c.model), ROSTER_MODELS);
  // and each call is about that slot's own track
  const tracks = m.getSlots().map((s) => s.assignment.track);
  calls.forEach((c, i) => assert.ok(c.prompt.includes(tracks[i])));
});

test('a modelOverride forces one model on every slot and every provider call', async () => {
  const { calls, provider } = spyProvider();
  const m = createSlotManager({ llmProvider: provider, modelOverride: 'openrouter/test-model' });
  m.setSlotCount(6);
  for (const s of m.getSlots()) {
    assert.equal(s.assignment.model, 'openrouter/test-model');
    assert.equal(s.assignment.modelSource, 'override');
    assert.ok(s.assignment.defaultModel); // the roster model is still recorded on the track
  }
  await thinkAll(m);
  assert.equal(calls.length, 6);
  assert.ok(calls.every((c) => c.model === 'openrouter/test-model'));
});

test('per-slot models reach the HTTP body through the real OpenRouter provider (fake fetch, no network)', async () => {
  const sent = [];
  const fetchImpl = async (url, opts) => {
    sent.push(JSON.parse(opts.body).model);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'next step' } }] }) };
  };
  const provider = createOpenRouterProvider({ apiKey: 'sk-fake', fetchImpl });
  const m = createSlotManager({ llmProvider: provider });
  m.setSlotCount(6);
  await thinkAll(m);
  assert.deepEqual(sent, ROSTER_MODELS);
});

test('createSlotManager rejects a blank or non-string modelOverride', () => {
  assert.throws(() => createSlotManager({ llmProvider: createMockLlmProvider(), modelOverride: '  ' }), TypeError);
  assert.throws(() => createSlotManager({ llmProvider: createMockLlmProvider(), modelOverride: 42 }), TypeError);
});
