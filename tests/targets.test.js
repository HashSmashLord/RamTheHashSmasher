import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVE_TRACKS, APPROACHES, DEFAULT_ROSTER, assignmentForIndex } from '../server/lib/targets.js';

test('the active track catalog matches the six real HashSmash exploratory tracks', () => {
  const names = ACTIVE_TRACKS.map((t) => t.track).sort();
  assert.deepEqual(names, [
    'blake3-r1-exploratory',
    'blake3-r2-exploratory',
    'sha256-r31-exploratory',
    'sha256-r32-exploratory',
    'sha3-256-r5-exploratory',
    'sha3-256-r6-exploratory',
  ]);
  for (const t of ACTIVE_TRACKS) assert.equal(t.lane, 'exploratory');
});

test('assignmentForIndex cycles through tracks before repeating with a new approach', () => {
  const first = Array.from({ length: ACTIVE_TRACKS.length }, (_, i) => assignmentForIndex(i));
  const tracks = first.map((a) => a.track);
  assert.equal(new Set(tracks).size, ACTIVE_TRACKS.length); // no repeats within one cycle
  const second = assignmentForIndex(ACTIVE_TRACKS.length); // wraps to track 0 again
  assert.equal(second.track, ACTIVE_TRACKS[0].track);
  assert.ok(APPROACHES.includes(second.approach));
});

test('assignmentForIndex rejects a negative or non-integer index', () => {
  assert.throws(() => assignmentForIndex(-1), RangeError);
  assert.throws(() => assignmentForIndex(1.5), RangeError);
});

// --- per-RAM default models (docs/PRD.md "Decided": the launch roster) ---

const EXPECTED_ROSTER = [
  ['sha256-r31-exploratory', 'anthropic/claude-opus-5.5'],
  ['sha256-r32-exploratory', 'anthropic/claude-fable-5.1'],
  ['sha3-256-r5-exploratory', 'openai/gpt-6.1-sol-pro'],
  ['sha3-256-r6-exploratory', 'z-ai/glm-5.3-prime'],
  ['blake3-r1-exploratory', 'deepseek/deepseek-v4-pro'],
  ['blake3-r2-exploratory', 'qwen/qwen3.8-max-prime'],
];

test('each active track carries its exact default OpenRouter model, in roster order', () => {
  assert.deepEqual(ACTIVE_TRACKS.map((t) => [t.track, t.defaultModel]), EXPECTED_ROSTER);
});

test('DEFAULT_ROSTER is RAM 1..6, one per track, with the roster model', () => {
  assert.deepEqual(
    DEFAULT_ROSTER.map((r) => [r.ram, r.track, r.model]),
    EXPECTED_ROSTER.map(([track, model], i) => [i + 1, track, model]),
  );
  assert.ok(Object.isFrozen(DEFAULT_ROSTER));
});

test('assignmentForIndex hands each of the first six slots its track\'s model, and later slots follow their track', () => {
  for (let i = 0; i < EXPECTED_ROSTER.length; i++) {
    const a = assignmentForIndex(i);
    assert.equal(a.track, EXPECTED_ROSTER[i][0]);
    assert.equal(a.model, EXPECTED_ROSTER[i][1]);
  }
  const seventh = assignmentForIndex(6);
  assert.equal(seventh.track, 'sha256-r31-exploratory');
  assert.equal(seventh.model, 'anthropic/claude-opus-5.5');
});
