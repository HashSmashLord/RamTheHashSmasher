// server/lib/research-tools.js: the research loop's real EXPERIMENT and
// VERIFY tools. Every assertion about a result is checked against an
// INDEPENDENT recomputation here (brute-force pair recounts, re-hashing every
// reported message, regenerating the deterministic message stream), so a
// result that was fabricated, inflated or merely plausible would fail.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExperimentRequest, parseVerifyRequest, runExperiment, runExperimentInWorker, verifyPair, comparePair,
  birthdayMessage, differentialPair, equalPrefixBits, hammingDistance, prefixMaskEvent, EXPERIMENT_LIMITS, realResearchTools,
} from '../server/lib/research-tools.js';
import { digestForTrack } from '../server/lib/reduced-hashes.js';

const R31 = 'sha256-r31-exploratory';
const B1 = 'blake3-r1-exploratory';
const req = (text, track = R31) => {
  const p = parseExperimentRequest(text, track);
  assert.equal(p.ok, true, p.error);
  return p.request;
};
const hexOf = (b) => Buffer.from(b).toString('hex');

// ---- request parsing ----

test('parseExperimentRequest: well-formed birthday and differential requests, with defaults and 2^k counts', () => {
  assert.deepEqual(parseExperimentRequest('birthday bits=24 samples=2^12 len=32 vary=0-7 seed=s1', R31), {
    ok: true, clamped: [], request: { kind: 'birthday', track: R31, messageBytes: 32, samples: 4096, seed: 's1', prefixBits: 24, vary: [0, 7] },
  });
  const d = parseExperimentRequest('differential at=60 xor=80', B1);
  assert.equal(d.ok, true);
  assert.deepEqual(d.request, { kind: 'differential', track: B1, messageBytes: 64, samples: 4096, seed: 'ram-default', diffAt: 60, diffHex: '80' });
});

test('parseExperimentRequest: over-cap sample counts are clamped AND the clamp is disclosed, never silently changed', () => {
  const p = parseExperimentRequest('birthday bits=40 samples=99999999', R31);
  assert.equal(p.ok, true);
  assert.equal(p.request.samples, EXPERIMENT_LIMITS.birthdayMaxSamples);
  assert.match(p.clamped[0], /samples 99999999 -> 262144/);
});

test('parseExperimentRequest: malformed, unknown or impossible requests are rejected with a reason, never guessed at', () => {
  const bad = [
    ['collide everything', /unknown experiment kind/],
    ['birthday', /bits must be/],
    ['birthday bits=256', /bits must be 8\.\.44.*2\^128/],
    ['birthday bits=32 rounds=5', /not a parameter/],
    ['birthday bits=32 vary=9-2', /vary/],
    ['birthday bits=32 len=8 vary=0-8', /vary/],
    ['birthday bits=32 len=999', /len must be/],
    ['birthday bits=32 seed=$(rm)', /seed must be/],
    ['differential at=0 xor=00', /nonzero/],
    ['differential at=63 xor=8000', /fit inside len/],
    ['differential xor=80', /at=<byte index> is required/],
    ['differential at=0 xor=zz', /even-length hex/],
  ];
  for (const [text, why] of bad) {
    const p = parseExperimentRequest(text, R31);
    assert.equal(p.ok, false, text);
    assert.match(p.error, why, text);
  }
  assert.equal(parseExperimentRequest('birthday bits=20', 'sha1-r80-exploratory').ok, false, 'no target defined -> nothing runs');
});

test('parseVerifyRequest: two hex messages, or EXP#<n>; anything else is rejected', () => {
  assert.deepEqual(parseVerifyRequest('AB01 ab02'), { ok: true, request: { messageAHex: 'ab01', messageBHex: 'ab02' } });
  assert.deepEqual(parseVerifyRequest('exp#07'), { ok: true, request: { experimentRef: 'EXP#7' } });
  assert.equal(parseVerifyRequest('abc def').ok, false, 'odd-length hex');
  assert.equal(parseVerifyRequest('ab').ok, false, 'one message');
  assert.equal(parseVerifyRequest(`${'00'.repeat(4097)} 00`).ok, false, 'over the organizer max_message_bytes');
});

// ---- birthday ----

test('birthday: every sample really runs, and the reported pair count equals an independent brute-force recount', () => {
  const r = req('birthday bits=14 samples=1500 len=16 seed=bf');
  const res = runExperiment(r);
  assert.equal(res.status, 'completed');
  assert.equal(res.samplesRun, 1500);
  assert.equal(res.stoppedEarly, false);
  // Independent O(n^2) recount from the same deterministic messages.
  const msgs = Array.from({ length: 1500 }, (_, i) => birthdayMessage(r, i));
  const ds = msgs.map((m) => digestForTrack(R31, m));
  let pairs = 0;
  let repeats = 0;
  const seen = new Set();
  for (let i = 0; i < ds.length; i++) {
    const key = msgs[i].toString('hex');
    if (seen.has(key)) { repeats++; continue; }
    seen.add(key);
    for (let j = 0; j < i; j++) if (!msgs[j].equals(msgs[i]) && equalPrefixBits(ds[i], ds[j]) >= 14) pairs++;
  }
  assert.equal(res.repeatedInputs, repeats);
  assert.equal(res.prefixCollisionPairs, pairs);
  assert.ok(pairs > 0, 'at 14 bits and 1500 samples real prefix collisions exist (~68 expected)');
  assert.equal(res.expectedPairsIfRandom, (1500 * 1499) / 2 / 2 ** 14);
});

test('birthday: the reported closest pair is real -- distinct messages, re-hashed independently, really agreeing on at least the requested bits, and not a full collision', () => {
  const res = runExperiment(req('birthday bits=24 samples=2^14 seed=pair'));
  const p = res.bestPair;
  assert.ok(p, 'at 24 bits and 2^14 samples a prefix pair exists for this seed');
  assert.notEqual(p.messageAHex, p.messageBHex);
  const da = digestForTrack(R31, Buffer.from(p.messageAHex, 'hex'));
  const db = digestForTrack(R31, Buffer.from(p.messageBHex, 'hex'));
  assert.equal(hexOf(da), p.digestAHex);
  assert.equal(hexOf(db), p.digestBHex);
  assert.ok(equalPrefixBits(da, db) >= 24);
  assert.equal(p.equalPrefixBits, equalPrefixBits(da, db));
  assert.equal(p.hammingDistance, hammingDistance(da, db));
  assert.equal(res.fullCollision, false);
  assert.equal(res.fullCollisionPairs, 0);
  assert.deepEqual(res.organizerEvent, prefixMaskEvent(24));
  assert.match(res.organizerEvent.mask_hex, /^ffffff0{58}$/);
  assert.match(res.interpretation, /out of scope for an ordinary-collision claim/);
  assert.match(res.note, /not an organizer-executed experiments report/);
});

test('birthday: repeated inputs are counted separately and never reported as collisions', () => {
  // Only one byte varies: at most 256 distinct messages exist, so most samples repeat.
  const res = runExperiment(req('birthday bits=16 samples=4096 len=8 vary=3-3 seed=rep', B1));
  assert.equal(res.samplesRun, 4096);
  assert.ok(res.distinctInputs <= 256);
  assert.equal(res.distinctInputs + res.repeatedInputs, 4096);
  if (res.bestPair) assert.notEqual(res.bestPair.messageAHex, res.bestPair.messageBHex);
  assert.equal(res.fullCollision, false);
});

test('experiments are deterministic: the same request reproduces the identical result; a different seed gives different samples', () => {
  const strip = ({ elapsedMs, ...rest }) => rest;
  const a = runExperiment(req('birthday bits=20 samples=3000 seed=same'));
  const b = runExperiment(req('birthday bits=20 samples=3000 seed=same'));
  assert.deepEqual(strip(a), strip(b));
  assert.notEqual(birthdayMessage(req('birthday bits=20 seed=x'), 0).toString('hex'), birthdayMessage(req('birthday bits=20 seed=y'), 0).toString('hex'));
});

test('the time cap stops a run early and the result reports exactly how many samples actually ran, never the requested number', () => {
  let t = 0;
  const nowMs = () => { t += 1; return t; }; // 1 "ms" per clock read: the budget runs out fast
  const res = runExperiment(req('birthday bits=30 samples=2^18'), { timeBudgetMs: 5, nowMs });
  assert.equal(res.stoppedEarly, true);
  assert.ok(res.samplesRun < res.samplesRequested);
  assert.equal(res.samplesRequested, 2 ** 18);
  assert.equal(res.distinctInputs + res.repeatedInputs, res.samplesRun);
  assert.equal(res.expectedPairsIfRandom, (res.distinctInputs * (res.distinctInputs - 1)) / 2 / 2 ** 30, 'the random-function baseline uses the samples that actually ran');
});

// ---- differential ----

test('differential: the mean/min/max output-difference weights equal an independent recomputation over the same pairs', () => {
  const r = req('differential at=10 xor=01 samples=300 seed=dd');
  const res = runExperiment(r);
  assert.equal(res.samplesRun, 300);
  assert.equal(res.hashEvaluations, 600);
  let sum = 0; let min = Infinity; let max = -1; let zero = 0;
  for (let i = 0; i < 300; i++) {
    const [m, m2] = differentialPair(r, i);
    assert.equal(m[10] ^ m2[10], 1);
    const hw = hammingDistance(digestForTrack(R31, m), digestForTrack(R31, m2));
    sum += hw; min = Math.min(min, hw); max = Math.max(max, hw); if (hw === 0) zero++;
  }
  assert.equal(res.meanOutputDiffWeight, sum / 300);
  assert.equal(res.minOutputDiffWeight, min);
  assert.equal(res.maxOutputDiffWeight, max);
  assert.equal(res.zeroDifferencePairs, zero);
  const bp = res.bestPair;
  assert.equal(hammingDistance(digestForTrack(R31, Buffer.from(bp.messageAHex, 'hex')), digestForTrack(R31, Buffer.from(bp.messageBHex, 'hex'))), min);
});

test('differential: a real, measured difference between targets -- 1-round BLAKE3 is grossly non-random under a one-bit input difference, 31-round SHA-256 is not', () => {
  const blake = runExperiment(req('differential at=60 xor=80 samples=4096 seed=signal', B1));
  const sha = runExperiment(req('differential at=60 xor=80 samples=4096 seed=signal', R31));
  assert.ok(blake.meanOutputDiffWeight < 32, `blake3-r1 mean weight ${blake.meanOutputDiffWeight}`);
  assert.ok(blake.bitsNeverFlipped > 100, `blake3-r1 never-flipped bits ${blake.bitsNeverFlipped}`);
  assert.ok(blake.significantlyBiasedBits > 100);
  assert.ok(sha.meanOutputDiffWeight > 124 && sha.meanOutputDiffWeight < 132, `sha256-r31 mean weight ${sha.meanOutputDiffWeight}`);
  assert.equal(sha.bitsNeverFlipped, 0);
  assert.equal(sha.zeroDifferencePairs, 0);
  assert.equal(blake.zeroDifferencePairs, 0, 'non-random is not the same as colliding');
});

// ---- worker ----

test('runExperimentInWorker: a real worker thread returns the identical result to an in-process run', async () => {
  const r = req('birthday bits=18 samples=3000 seed=w');
  const inProc = runExperiment(r);
  const viaWorker = await runExperimentInWorker(r);
  const strip = ({ elapsedMs, ...rest }) => rest;
  assert.equal(viaWorker.status, 'completed');
  assert.deepEqual(strip(viaWorker), strip(inProc));
  assert.equal(realResearchTools.verifyPair, verifyPair);
});

test('runExperimentInWorker: a worker that does not report back in time is killed and reported as timed out, with no invented numbers', async () => {
  const res = await runExperimentInWorker(req('birthday bits=40 samples=2^18'), { timeBudgetMs: 60_000, hardTimeoutMs: 30 });
  assert.equal(res.status, 'timed-out');
  assert.equal(res.samplesRun, undefined);
  assert.equal(res.prefixCollisionPairs, undefined);
});

// ---- verify ----

test('verifyPair: a genuine full collision is identified as one (the organizer\'s own 8-round SHA-256 control), and the same pair is correctly NOT one on a pipeline track', () => {
  const a = '00'.repeat(40);
  const b = `${'00'.repeat(32)}01${'00'.repeat(7)}`;
  const shallow = comparePair({ algorithm: 'sha256', rounds: 8 }, a, b);
  assert.equal(shallow.distinct, true);
  assert.equal(shallow.digestsEqual, true);
  assert.equal(shallow.fullCollision, true);
  assert.equal(shallow.equalPrefixBits, 256);
  const r31 = verifyPair({ track: R31, messageAHex: a, messageBHex: b });
  assert.equal(r31.fullCollision, false);
  assert.equal(r31.digestsEqual, false);
  assert.equal(r31.target.profileId, 'sha256-r31-prefix-v1');
  assert.equal(r31.digestAHex, hexOf(digestForTrack(R31, Buffer.from(a, 'hex'))));
  assert.ok(r31.hammingDistance > 0);
});

test('verifyPair: identical messages are never a collision, even though their digests are equal', () => {
  const v = verifyPair({ track: B1, messageAHex: 'abcd', messageBHex: 'ABCD'.toLowerCase() });
  assert.equal(v.distinct, false);
  assert.equal(v.digestsEqual, true);
  assert.equal(v.fullCollision, false);
});
