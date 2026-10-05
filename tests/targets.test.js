import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVE_TRACKS, APPROACHES, assignmentForIndex } from '../server/lib/targets.js';

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
