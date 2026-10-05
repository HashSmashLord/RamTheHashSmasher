import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlotManager, SLOT_STATUSES } from '../server/lib/slots.js';
import { createMockLlmProvider } from '../server/lib/llm.js';

function manager() {
  return createSlotManager({ llmProvider: createMockLlmProvider() });
}

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
