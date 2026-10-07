// Real, bounded research tools for a RAM's active loop: an EXPERIMENT the
// model can ask for mid-session, and a VERIFY of any candidate pair, both
// computed for real against the track's exact reduced-round target
// (reduced-hashes.js, a port of the organizer's own reference checker).
//
// The point (vs. what the loop had before): a RAM could only read titles and
// reason. Now it can test a hypothesis — "is this reduced target's output
// biased under this input difference?", "how many k-bit prefix collisions do
// N samples really give?" — and get back numbers that were genuinely
// computed, with the real sample count and real timing.
//
// Honesty rules, enforced here in code, not in a prompt:
//   - Every number in a result is computed by this module from the real
//     reduced-round function. Nothing is estimated and reported as measured;
//     "expected under a random function" figures are labeled as such.
//   - Bounded: hard caps on samples, message length and wall time per call.
//     A run that hits the time cap stops and reports exactly how many
//     samples it actually did (`samplesRun`), never the requested number.
//   - Deterministic and reproducible: messages come from a SHA-256 counter
//     stream over a recorded seed, so anyone can re-run the identical
//     experiment and get the identical result.
//   - A truncated-prefix collision or a low-weight output difference is
//     reported as exactly that. The organizer's target profiles list
//     "near-collisions or output truncation" as OUT OF SCOPE for an
//     ordinary-collision claim; every result says so. Only verifyPair with
//     two DISTINCT messages and all 256 output bits equal is a collision.
//   - Distinct inputs vs. repeated inputs are counted separately (the
//     organizer's own docs insist on this distinction).
//
// Results map onto the organizer's own experiment vocabulary
// (experiments/runner.py, docs/HEURISTIC_EXPERIMENTS.md): a k-bit prefix
// collision is its `digest-xor-mask` event with the top k bits masked and
// expected 0; a full match is its `full-collision` event. These are this
// harness's host-side computations, NOT an organizer-executed experiments
// report (that runs submitted Python in the organizer's Docker executor);
// every result says that too.

import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { TRACK_TARGETS, targetForTrack, digestForTrack, digest } from './reduced-hashes.js';

export const EXPERIMENT_KINDS = Object.freeze(['birthday', 'differential']);

/** Hard per-call bounds. A request above a cap is clamped and the clamp is disclosed. */
export const EXPERIMENT_LIMITS = Object.freeze({
  birthdayMaxSamples: 1 << 18,
  birthdayMinBits: 8,
  birthdayMaxBits: 44,
  differentialMaxSamples: 1 << 16,
  maxMessageBytes: 256,
  maxDiffBytes: 32,
  timeBudgetMs: 2000,
  /** VERIFY accepts messages up to the organizer's own max_message_bytes. */
  verifyMaxMessageBytes: 4096,
});

export const DEFAULT_SAMPLES = Object.freeze({ birthday: 1 << 16, differential: 4096 });

export const OUT_OF_SCOPE_NOTE = 'The organizer\'s target profile lists near-collisions and output truncation as out of scope for an ordinary-collision claim: '
  + 'a prefix match or a low-weight difference is evidence about the target\'s behavior, not a collision.';

export const HOST_SIDE_NOTE = 'Computed by this harness on its own host with a JS port of the organizer\'s reference reduced-round function '
  + '(pinned to the organizer\'s test vectors); not an organizer-executed experiments report, and the organizer\'s judge has not re-run it.';

const hex = (b) => Buffer.from(b).toString('hex');

// ---------------------------------------------------------------------------
// Request parsing (the model's "EXPERIMENT: ..." line)
// ---------------------------------------------------------------------------

function parseIntStrict(s) {
  if (!/^\d{1,9}$/.test(s)) return null;
  return Number(s);
}

/** Accepts plain integers and powers like 2^16. */
function parseCount(s) {
  const pow = /^2\^(\d{1,2})$/.exec(s);
  if (pow) return 2 ** Number(pow[1]);
  return parseIntStrict(s);
}

/**
 * Parses the parameter text of an "EXPERIMENT:" line into a validated
 * request, or `{ ok: false, error }` explaining exactly what was wrong.
 * Strict: unknown keys, malformed values and impossible combinations are
 * rejected (never guessed at); over-cap sample counts are clamped and the
 * clamp is recorded in `clamped`, so the feed can disclose it.
 *
 *   birthday     bits=<8..44> [samples=<n|2^k>] [len=<1..256>] [vary=<a>-<b>] [seed=<word>]
 *   differential at=<byte> xor=<hex, 1..32 bytes> [samples=<n|2^k>] [len=<1..256>] [seed=<word>]
 */
export function parseExperimentRequest(text, track) {
  if (!TRACK_TARGETS[track]) return { ok: false, error: `no reduced-round target is defined for ${track}` };
  const tokens = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  const kind = (tokens.shift() ?? '').toLowerCase();
  if (!EXPERIMENT_KINDS.includes(kind)) return { ok: false, error: `unknown experiment kind "${kind.slice(0, 30)}" (supported: ${EXPERIMENT_KINDS.join(', ')})` };
  const allowed = kind === 'birthday' ? ['bits', 'samples', 'len', 'vary', 'seed'] : ['at', 'xor', 'samples', 'len', 'seed'];
  const params = {};
  for (const tok of tokens) {
    const m = /^([a-z]+)=(\S+)$/i.exec(tok);
    if (!m) return { ok: false, error: `could not read "${tok.slice(0, 40)}" (expected key=value)` };
    const key = m[1].toLowerCase();
    if (!allowed.includes(key)) return { ok: false, error: `"${key}" is not a parameter of a ${kind} experiment (allowed: ${allowed.join(', ')})` };
    params[key] = m[2];
  }
  const clamped = [];
  const req = { kind, track };
  const len = params.len === undefined ? 64 : parseIntStrict(params.len);
  if (len === null || len < 1 || len > EXPERIMENT_LIMITS.maxMessageBytes) return { ok: false, error: `len must be 1..${EXPERIMENT_LIMITS.maxMessageBytes} bytes` };
  req.messageBytes = len;
  const maxSamples = kind === 'birthday' ? EXPERIMENT_LIMITS.birthdayMaxSamples : EXPERIMENT_LIMITS.differentialMaxSamples;
  let samples = params.samples === undefined ? DEFAULT_SAMPLES[kind] : parseCount(params.samples);
  if (samples === null || samples < 1) return { ok: false, error: 'samples must be a positive integer (or 2^k)' };
  if (samples > maxSamples) { clamped.push(`samples ${samples} -> ${maxSamples} (per-call cap)`); samples = maxSamples; }
  req.samples = samples;
  const seed = params.seed ?? 'ram-default';
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(seed)) return { ok: false, error: 'seed must be 1..40 characters of [A-Za-z0-9._-]' };
  req.seed = seed;
  if (kind === 'birthday') {
    const bits = params.bits === undefined ? null : parseIntStrict(params.bits);
    if (bits === null || bits < EXPERIMENT_LIMITS.birthdayMinBits || bits > EXPERIMENT_LIMITS.birthdayMaxBits) {
      return { ok: false, error: `bits must be ${EXPERIMENT_LIMITS.birthdayMinBits}..${EXPERIMENT_LIMITS.birthdayMaxBits} (a full 256-bit birthday search is 2^128 work and is not something one bounded call can do)` };
    }
    req.prefixBits = bits;
    if (params.vary !== undefined) {
      const v = /^(\d{1,3})-(\d{1,3})$/.exec(params.vary);
      if (!v) return { ok: false, error: 'vary must look like <first>-<last> byte index, e.g. vary=0-7' };
      const a = Number(v[1]); const b = Number(v[2]);
      if (a > b || b >= len) return { ok: false, error: `vary=${params.vary} must satisfy first <= last < len (${len})` };
      req.vary = [a, b];
    } else req.vary = [0, len - 1];
  } else {
    const at = params.at === undefined ? null : parseIntStrict(params.at);
    if (params.xor === undefined || !/^(?:[0-9a-f]{2})+$/i.test(params.xor)) return { ok: false, error: 'xor must be an even-length hex input difference, e.g. xor=80 or xor=00000001' };
    const diff = params.xor.toLowerCase();
    if (diff.length / 2 > EXPERIMENT_LIMITS.maxDiffBytes) return { ok: false, error: `xor difference is at most ${EXPERIMENT_LIMITS.maxDiffBytes} bytes` };
    if (/^0+$/.test(diff)) return { ok: false, error: 'xor must be a nonzero difference (a zero difference compares a message with itself)' };
    if (at === null || at + diff.length / 2 > len) return { ok: false, error: `at=<byte index> is required and at + difference length must fit inside len (${len})` };
    req.diffAt = at;
    req.diffHex = diff;
  }
  return { ok: true, request: req, clamped };
}

// ---------------------------------------------------------------------------
// Deterministic message stream
// ---------------------------------------------------------------------------

/** Bytes from SHA-256(seedMaterial || index || block) — real SHA-256, reproducible by anyone. */
function streamBytes(seedMaterial, index, n) {
  const out = Buffer.alloc(n);
  let filled = 0;
  for (let block = 0; filled < n; block++) {
    const h = createHash('sha256').update(seedMaterial).update(`|${index}|${block}`).digest();
    h.copy(out, filled, 0, Math.min(32, n - filled));
    filled += 32;
  }
  return out;
}

function seedMaterialFor(req) {
  return `ramherd-experiment-v1|${req.track}|${req.kind}|${req.seed}`;
}

/** The exact message number `index` a birthday experiment hashes (fixed base, `vary` range per sample). */
export function birthdayMessage(req, index) {
  const material = seedMaterialFor(req);
  const msg = streamBytes(`${material}|base`, 0, req.messageBytes);
  const [a, b] = req.vary;
  streamBytes(material, index, b - a + 1).copy(msg, a);
  return msg;
}

/** The exact pair number `index` a differential experiment hashes. */
export function differentialPair(req, index) {
  const m = streamBytes(seedMaterialFor(req), index, req.messageBytes);
  const m2 = Buffer.from(m);
  const diff = Buffer.from(req.diffHex, 'hex');
  for (let i = 0; i < diff.length; i++) m2[req.diffAt + i] ^= diff[i];
  return [m, m2];
}

// ---------------------------------------------------------------------------
// Bit helpers
// ---------------------------------------------------------------------------

const POPCNT = Uint8Array.from({ length: 256 }, (_, i) => { let c = 0; for (let x = i; x; x >>= 1) c += x & 1; return c; });

/** Number of leading bits (MSB first over the digest bytes) on which a and b agree. */
export function equalPrefixBits(a, b) {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ^ b[i];
    if (x) return i * 8 + Math.clz32(x) - 24;
  }
  return a.length * 8;
}

export function hammingDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POPCNT[a[i] ^ b[i]];
  return d;
}

/** The top `bits` of a digest as a plain number (bits <= 48 fit a double exactly). */
function prefixKey(d, bits) {
  let v = 0;
  const full = Math.floor(bits / 8);
  for (let i = 0; i < full; i++) v = v * 256 + d[i];
  const rem = bits % 8;
  if (rem) v = v * 2 ** rem + (d[full] >>> (8 - rem));
  return v;
}

/** The organizer's digest-xor-mask event (experiments/runner.py) for a top-`bits` prefix match. */
export function prefixMaskEvent(bits, digestBytes = 32) {
  const mask = Buffer.alloc(digestBytes);
  for (let i = 0; i < bits; i++) mask[i >> 3] |= 0x80 >> (i & 7);
  return { kind: 'digest-xor-mask', mask_hex: mask.toString('hex'), expected_hex: Buffer.alloc(digestBytes).toString('hex') };
}

// ---------------------------------------------------------------------------
// Experiments (pure, synchronous, bounded; runExperimentInWorker runs them off the main thread)
// ---------------------------------------------------------------------------

function runBirthday(req, { timeBudgetMs, nowMs }) {
  const target = targetForTrack(req.track);
  const start = nowMs();
  const buckets = new Map(); // prefix -> index or array of indices
  // Every sample's full digest, so a prefix hit is classified without
  // re-hashing: different full digests => certainly distinct messages; equal
  // full digests => regenerate both and compare bytes (a repeated input, or
  // a genuine full collision).
  const digests = new Uint8Array(req.samples * 32);
  const sameDigest = (j, i) => { for (let k = 0; k < 32; k++) if (digests[j * 32 + k] !== digests[i * 32 + k]) return false; return true; };
  let samplesRun = 0;
  let distinctPairs = 0;
  let repeatedInputs = 0;
  let fullCollisionPairs = 0;
  let bestPair = null;
  let regenerated = 0;
  let stoppedEarly = false;
  for (let i = 0; i < req.samples; i++) {
    if ((i & 1023) === 0 && i > 0 && nowMs() - start > timeBudgetMs) { stoppedEarly = true; break; }
    const msg = birthdayMessage(req, i);
    const d = digestForTrack(req.track, msg);
    digests.set(d, i * 32);
    samplesRun++;
    const key = prefixKey(d, req.prefixBits);
    const prev = buckets.get(key);
    if (prev === undefined) { buckets.set(key, i); continue; }
    const members = Array.isArray(prev) ? prev : [prev];
    let repeated = false;
    let newPairs = 0;
    let newFull = 0;
    let pairCandidate = null;
    for (const j of members) {
      if (sameDigest(j, i)) {
        regenerated++;
        if (birthdayMessage(req, j).equals(msg)) { repeated = true; break; }
        newFull++;
      }
      newPairs++;
      const od = digests.subarray(j * 32, j * 32 + 32);
      const eq = equalPrefixBits(od, d);
      if (!pairCandidate || eq > pairCandidate.eq) pairCandidate = { j, eq, od };
    }
    if (repeated) { repeatedInputs++; continue; }
    distinctPairs += newPairs;
    fullCollisionPairs += newFull;
    if (pairCandidate && (!bestPair || pairCandidate.eq > bestPair.equalPrefixBits)) {
      const { j, eq, od } = pairCandidate;
      regenerated++;
      bestPair = { messageAHex: hex(birthdayMessage(req, j)), messageBHex: hex(msg), digestAHex: hex(od), digestBHex: hex(d), equalPrefixBits: eq, hammingDistance: hammingDistance(od, d), indices: [j, i] };
    }
    buckets.set(key, [...members, i]);
  }
  const elapsedMs = nowMs() - start;
  const distinctInputs = samplesRun - repeatedInputs;
  const expectedPairs = (distinctInputs * (distinctInputs - 1)) / 2 / 2 ** req.prefixBits;
  const firstPair = bestPair;
  return {
    kind: 'birthday',
    track: req.track,
    target: { algorithm: target.algorithm, rounds: target.rounds, profileId: target.profileId },
    params: { prefixBits: req.prefixBits, messageBytes: req.messageBytes, vary: req.vary, seed: req.seed },
    samplesRequested: req.samples,
    samplesRun,
    stoppedEarly,
    elapsedMs,
    hashEvaluations: samplesRun,
    messageRegenerations: regenerated,
    distinctInputs,
    repeatedInputs,
    prefixCollisionPairs: distinctPairs,
    fullCollisionPairs,
    expectedPairsIfRandom: expectedPairs,
    /** The recorded pair agreeing on the most leading digest bits (VERIFY: EXP#n re-checks exactly this pair). */
    bestPair: firstPair,
    organizerEvent: prefixMaskEvent(req.prefixBits),
    fullCollision: fullCollisionPairs > 0,
    interpretation: `${distinctPairs} distinct-input pair(s) agreed on the first ${req.prefixBits} digest bits over ${distinctInputs} distinct inputs (${repeatedInputs} repeated input(s) excluded); `
      + `a random ${req.prefixBits}-bit function would give about ${expectedPairs.toPrecision(3)} on average. ${OUT_OF_SCOPE_NOTE}`,
  };
}

function runDifferential(req, { timeBudgetMs, nowMs }) {
  const target = targetForTrack(req.track);
  const bits = target.digestBits;
  const start = nowMs();
  const flips = new Uint32Array(bits);
  let samplesRun = 0;
  let sumHw = 0;
  let minHw = Infinity;
  let maxHw = -1;
  let zeroDiff = 0;
  let best = null;
  let stoppedEarly = false;
  for (let i = 0; i < req.samples; i++) {
    if ((i & 255) === 0 && i > 0 && nowMs() - start > timeBudgetMs) { stoppedEarly = true; break; }
    const [m, m2] = differentialPair(req, i);
    const d1 = digestForTrack(req.track, m);
    const d2 = digestForTrack(req.track, m2);
    samplesRun++;
    let hw = 0;
    for (let b = 0; b < d1.length; b++) {
      const x = d1[b] ^ d2[b];
      if (!x) continue;
      hw += POPCNT[x];
      for (let k = 0; k < 8; k++) if (x & (0x80 >> k)) flips[b * 8 + k]++;
    }
    sumHw += hw;
    if (hw > maxHw) maxHw = hw;
    if (hw === 0) zeroDiff++;
    if (hw < minHw) {
      minHw = hw;
      best = { messageAHex: hex(m), messageBHex: hex(m2), digestAHex: hex(d1), digestBHex: hex(d2), hammingDistance: hw, equalPrefixBits: equalPrefixBits(d1, d2), index: i };
    }
  }
  const elapsedMs = nowMs() - start;
  const n = samplesRun;
  // Two-sided Hoeffding bound per output bit, Bonferroni-corrected over all
  // output bits at alpha 0.01 (same family of interval as the organizer's
  // addition-xor-sampled-v1 evaluator), assuming independent samples.
  const alpha = 0.01;
  const epsilon = n ? Math.sqrt(Math.log((2 * bits) / alpha) / (2 * n)) : null;
  let maxBias = 0;
  let maxBiasBit = null;
  let biasedBits = 0;
  let neverFlipped = 0;
  let alwaysFlipped = 0;
  for (let k = 0; k < bits; k++) {
    const p = n ? flips[k] / n : 0;
    const bias = Math.abs(p - 0.5);
    if (bias > maxBias) { maxBias = bias; maxBiasBit = k; }
    if (epsilon !== null && bias > epsilon) biasedBits++;
    if (flips[k] === 0) neverFlipped++;
    if (n && flips[k] === n) alwaysFlipped++;
  }
  return {
    kind: 'differential',
    track: req.track,
    target: { algorithm: target.algorithm, rounds: target.rounds, profileId: target.profileId },
    params: { diffAt: req.diffAt, diffHex: req.diffHex, messageBytes: req.messageBytes, seed: req.seed },
    samplesRequested: req.samples,
    samplesRun,
    stoppedEarly,
    elapsedMs,
    hashEvaluations: 2 * samplesRun,
    meanOutputDiffWeight: n ? sumHw / n : null,
    minOutputDiffWeight: n ? minHw : null,
    maxOutputDiffWeight: n ? maxHw : null,
    zeroDifferencePairs: zeroDiff,
    bitsNeverFlipped: neverFlipped,
    bitsAlwaysFlipped: alwaysFlipped,
    maxBitBias: maxBias,
    maxBitBiasIndex: maxBiasBit,
    biasThreshold: epsilon,
    significantlyBiasedBits: biasedBits,
    bestPair: best,
    fullCollision: zeroDiff > 0,
    interpretation: `Over ${n} message pairs differing by ${req.diffHex} at byte ${req.diffAt}: mean output-difference weight ${n ? (sumHw / n).toFixed(2) : 'n/a'} of ${bits} `
      + `(about ${bits / 2} for a random function), minimum ${n ? minHw : 'n/a'}, ${zeroDiff} pair(s) with identical digests; ${biasedBits} output bit(s) deviate from 1/2 by more than the `
      + `Hoeffding/Bonferroni threshold ${epsilon === null ? 'n/a' : epsilon.toFixed(4)} (alpha 0.01, assumes independent samples). ${OUT_OF_SCOPE_NOTE}`,
  };
}

/**
 * Runs one validated experiment request synchronously and returns its real
 * result. Prefer runExperimentInWorker in the server (keeps the event loop
 * free); this is what the worker itself calls, and what tests call directly.
 */
export function runExperiment(req, { timeBudgetMs = EXPERIMENT_LIMITS.timeBudgetMs, nowMs = () => performance.now() } = {}) {
  if (!req || !EXPERIMENT_KINDS.includes(req.kind)) throw new RangeError('unknown experiment kind');
  targetForTrack(req.track);
  const result = req.kind === 'birthday' ? runBirthday(req, { timeBudgetMs, nowMs }) : runDifferential(req, { timeBudgetMs, nowMs });
  return { ...result, status: 'completed', computedBy: 'host-js-port', note: HOST_SIDE_NOTE };
}

/**
 * Runs an experiment on a worker thread, so a RAM's bounded experiment never
 * blocks the server's event loop. A hard wall-clock kill (`hardTimeoutMs`,
 * above the experiment's own cooperative time budget) terminates the worker
 * and resolves with an honest `status: 'timed-out'` — no partial numbers are
 * invented for a run that did not report back.
 */
export function runExperimentInWorker(req, { timeBudgetMs = EXPERIMENT_LIMITS.timeBudgetMs, hardTimeoutMs = timeBudgetMs + 8000 } = {}) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise(value); } };
    const worker = new Worker(new URL('./research-tools-worker.js', import.meta.url), { workerData: { req, timeBudgetMs } });
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish({ status: 'timed-out', kind: req.kind, track: req.track, error: `the experiment did not report back within ${hardTimeoutMs} ms and was stopped; no result exists for it` });
    }, hardTimeoutMs);
    timer.unref?.();
    worker.once('message', (msg) => {
      finish(msg.ok ? msg.result : { status: 'error', kind: req.kind, track: req.track, error: msg.error });
      worker.terminate().catch(() => {});
    });
    worker.once('error', (err) => finish({ status: 'error', kind: req.kind, track: req.track, error: err.message }));
    worker.once('exit', (code) => finish({ status: 'error', kind: req.kind, track: req.track, error: `experiment worker exited (code ${code}) without a result` }));
  });
}

// ---------------------------------------------------------------------------
// VERIFY
// ---------------------------------------------------------------------------

/**
 * Parses the parameter text of a "VERIFY:" line: either two hex messages
 * ("VERIFY: <hexA> <hexB>") or a reference to a pair a session experiment
 * actually recorded ("VERIFY: EXP#3") — the latter exists because a model
 * copying hundreds of hex characters is itself error-prone.
 */
export function parseVerifyRequest(text) {
  const raw = String(text ?? '').trim();
  const ref = /^EXP#(\d{1,6})$/i.exec(raw);
  if (ref) return { ok: true, request: { experimentRef: `EXP#${Number(ref[1])}` } };
  const parts = raw.split(/\s+/);
  if (parts.length !== 2) return { ok: false, error: 'VERIFY needs exactly two hex messages, or EXP#<n> to re-check a pair an experiment recorded' };
  const max = 2 * EXPERIMENT_LIMITS.verifyMaxMessageBytes;
  for (const p of parts) {
    if (!/^(?:[0-9a-fA-F]{2})*$/.test(p) || p.length > max) return { ok: false, error: `each message must be even-length hex of at most ${EXPERIMENT_LIMITS.verifyMaxMessageBytes} bytes` };
  }
  return { ok: true, request: { messageAHex: parts[0].toLowerCase(), messageBHex: parts[1].toLowerCase() } };
}

/**
 * Recomputes both digests under the track's exact target with the JS port
 * and reports the truth: whether the messages are distinct, whether all
 * output bits agree (`fullCollision` — the organizer certificate checker's
 * exact acceptance rule: distinct messages, equal digests), and how close
 * they are otherwise. slots.js additionally has the organizer's real Python
 * recompute the same pair (hashsmash.js organizerDigests) and only treats a
 * result as confirmed when both agree.
 */
export function verifyPair({ track, messageAHex, messageBHex }) {
  const target = targetForTrack(track);
  return { track, ...comparePair({ algorithm: target.algorithm, rounds: target.rounds, profileId: target.profileId }, messageAHex, messageBHex) };
}

/**
 * The comparison itself, for any (algorithm, rounds) the organizer's
 * reference supports — verifyPair pins it to a track's exact target. The
 * acceptance rule is the organizer certificate checker's
 * (verifier/certificates.py): the two messages must differ, and both
 * complete digests must be equal.
 */
export function comparePair(target, messageAHex, messageBHex) {
  const a = Buffer.from(messageAHex, 'hex');
  const b = Buffer.from(messageBHex, 'hex');
  const da = digest(a, target.algorithm, target.rounds);
  const db = digest(b, target.algorithm, target.rounds);
  const distinct = !a.equals(b);
  const digestsEqual = Buffer.from(da).equals(Buffer.from(db));
  return {
    kind: 'verify',
    status: 'completed',
    target: { algorithm: target.algorithm, rounds: target.rounds, profileId: target.profileId ?? null },
    messageAHex: a.toString('hex'),
    messageBHex: b.toString('hex'),
    messageBytes: [a.length, b.length],
    distinct,
    digestAHex: hex(da),
    digestBHex: hex(db),
    digestsEqual,
    fullCollision: distinct && digestsEqual,
    equalPrefixBits: equalPrefixBits(da, db),
    hammingDistance: hammingDistance(da, db),
    computedBy: 'host-js-port',
  };
}

/** What store.js hands to createSlotManager as `researchTools`: experiments off the main thread, VERIFY in-process (two hashes). */
export const realResearchTools = Object.freeze({ runExperiment: (req) => runExperimentInWorker(req), verifyPair });

export { TRACK_TARGETS };
