import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../server/lib/ratelimit.js';

test('allows up to max hits, then blocks', () => {
  const clock = { t: 0 };
  const rl = createRateLimiter({ max: 3, windowMs: 60_000, now: () => clock.t });
  assert.equal(rl.hit('a').allowed, true);
  assert.equal(rl.hit('a').allowed, true);
  assert.equal(rl.hit('a').allowed, true);
  assert.equal(rl.hit('a').allowed, false);
  rl.stop();
});

test('keys are independent', () => {
  const clock = { t: 0 };
  const rl = createRateLimiter({ max: 1, windowMs: 60_000, now: () => clock.t });
  assert.equal(rl.hit('a').allowed, true);
  assert.equal(rl.hit('a').allowed, false);
  assert.equal(rl.hit('b').allowed, true);
  rl.stop();
});

test('the window slides', () => {
  const clock = { t: 0 };
  const rl = createRateLimiter({ max: 1, windowMs: 10_000, now: () => clock.t });
  rl.hit('a');
  assert.equal(rl.hit('a').allowed, false);
  clock.t += 10_001;
  assert.equal(rl.hit('a').allowed, true);
  rl.stop();
});

test('countDenied:false refuses past max without growing the key\'s history', () => {
  const clock = { t: 0 };
  const rl = createRateLimiter({ max: 2, windowMs: 10_000, now: () => clock.t, countDenied: false });
  assert.equal(rl.hit('g').allowed, true);
  assert.equal(rl.hit('g').allowed, true);
  for (let i = 0; i < 1000; i++) assert.equal(rl.hit('g').allowed, false);
  clock.t += 10_001;
  // With denied hits not counted, the window frees up as soon as the 2 allowed hits age out.
  assert.equal(rl.hit('g').allowed, true);
  rl.stop();
});
