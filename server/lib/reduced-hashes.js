// Reduced-round hash functions for the six HashSmash pipeline tracks, ported
// line for line from the ORGANIZER'S OWN reference checker in the vendored
// repo (reference/hash-smash/verifier/hash_functions.py, keccak.py,
// blake3.py) — the exact functions its certificate checker
// (verifier/certificates.py) calls as `digest(message, track.algorithm,
// track.rounds)`. Same semantics, deliberately:
//
//   SHA-256 (FIPS 180-4): the first r compression steps on EVERY padded
//     block, standard IV, standard schedule/constants at their original
//     indices, feed-forward kept, big-endian digest.
//   SHA3-256 (FIPS 202): Keccak-f[1600] PREFIX rounds 0..r-1 in every sponge
//     permutation (not Keccak-p's last-round convention), rate 1088, suffix
//     0x06, pad10*1, first 32 squeeze bytes.
//   BLAKE3: unkeyed, standard chunk tree / counters / flags / feed-forward /
//     root output, the first r rounds of every chunk, parent and root
//     compression.
//
// This is NOT an attack and NOT a substitute for the organizer's checker:
// it exists so a RAM's research loop can run real, cheap, bounded experiments
// in-process (research-tools.js), fast enough to matter. Correctness is pinned
// by tests/reduced-hashes.test.js against the organizer's own independent
// vectors (NIST intermediate states, XKCP Keccak prefix states, BLAKE3 Rust
// reference prefix vectors), against Node's own full-round SHA-256/SHA3-256,
// and against the organizer's Python itself on random inputs. Anything that
// ever matters for a claim (a found pair) is ALSO recomputed by the
// organizer's real Python (hashsmash.js organizerDigests) before it is
// reported as fact.

const M32 = 0xffffffff;

// ---------------------------------------------------------------------------
// SHA-256 (verifier/hash_functions.py)
// ---------------------------------------------------------------------------

const SHA256_K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export const SHA256_IV = Object.freeze([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);

const ror = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

function sha256Compress(state, block, off, rounds, w) {
  for (let i = 0; i < 16; i++) {
    const j = off + 4 * i;
    w[i] = ((block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3]) >>> 0;
  }
  // Organizer: `for i in range(16, rounds)` — no expansion at all for rounds <= 16.
  for (let i = 16; i < rounds; i++) {
    const x = w[i - 15];
    const y = w[i - 2];
    const s0 = ror(x, 7) ^ ror(x, 18) ^ (x >>> 3);
    const s1 = ror(y, 17) ^ ror(y, 19) ^ (y >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
  }
  let a = state[0]; let b = state[1]; let c = state[2]; let d = state[3];
  let e = state[4]; let f = state[5]; let g = state[6]; let h = state[7];
  for (let i = 0; i < rounds; i++) {
    const S1 = ror(e, 6) ^ ror(e, 11) ^ ror(e, 25);
    const t1 = (h + S1 + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) >>> 0;
    const S0 = ror(a, 2) ^ ror(a, 13) ^ ror(a, 22);
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
    h = g; g = f; f = e; e = (d + t1) >>> 0;
    d = c; c = b; b = a; a = (t1 + t2) >>> 0;
  }
  state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0;
  state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0;
  state[4] = (state[4] + e) >>> 0; state[5] = (state[5] + f) >>> 0;
  state[6] = (state[6] + g) >>> 0; state[7] = (state[7] + h) >>> 0;
}

/** SHA-256 with the first `rounds` (1..64) compression steps on every padded block. */
export function sha256Reduced(data, rounds) {
  assertBytes(data);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 64) throw new RangeError('unsupported SHA-256 round count');
  const len = data.length;
  const padLen = len + 1 + ((55 - len) % 64 + 64) % 64 + 8;
  const padded = new Uint8Array(padLen);
  padded.set(data);
  padded[len] = 0x80;
  // 64-bit big-endian bit length (messages here are far below 2^53 bits).
  const bits = len * 8;
  const hi = Math.floor(bits / 2 ** 32);
  const lo = bits >>> 0;
  padded[padLen - 8] = (hi >>> 24) & 0xff; padded[padLen - 7] = (hi >>> 16) & 0xff;
  padded[padLen - 6] = (hi >>> 8) & 0xff; padded[padLen - 5] = hi & 0xff;
  padded[padLen - 4] = (lo >>> 24) & 0xff; padded[padLen - 3] = (lo >>> 16) & 0xff;
  padded[padLen - 2] = (lo >>> 8) & 0xff; padded[padLen - 1] = lo & 0xff;
  const state = Uint32Array.from(SHA256_IV);
  const w = new Uint32Array(64);
  for (let off = 0; off < padLen; off += 64) sha256Compress(state, padded, off, rounds, w);
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[4 * i] = state[i] >>> 24; out[4 * i + 1] = (state[i] >>> 16) & 0xff;
    out[4 * i + 2] = (state[i] >>> 8) & 0xff; out[4 * i + 3] = state[i] & 0xff;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Keccak-f[1600] / SHA3-256 (verifier/keccak.py), 64-bit lanes as (lo, hi)
// 32-bit halves: lane i lives at [2i] (low word) and [2i+1] (high word).
// ---------------------------------------------------------------------------

const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808An, 0x8000000080008000n,
  0x000000000000808Bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008An, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000An,
  0x000000008000808Bn, 0x800000000000008Bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800An, 0x800000008000000An,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const RC_LO = Uint32Array.from(KECCAK_RC, (c) => Number(c & 0xffffffffn));
const RC_HI = Uint32Array.from(KECCAK_RC, (c) => Number(c >> 32n));
const RHO = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
// Organizer: moved[y + 5*((2x+3y) % 5)] = rot(lanes[x+5y] ^ theta[x], RHO[x+5y]).
const PI_DEST = Array.from({ length: 25 }, (_, idx) => { const x = idx % 5; const y = (idx / 5) | 0; return y + 5 * ((2 * x + 3 * y) % 5); });

/** Keccak-f[1600] prefix rounds 0..rounds-1, in place on a Uint32Array(50). */
export function keccakF1600(s, rounds) {
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 24) throw new RangeError('unsupported Keccak prefix round count');
  const cLo = new Uint32Array(5); const cHi = new Uint32Array(5);
  const bLo = new Uint32Array(25); const bHi = new Uint32Array(25);
  for (let r = 0; r < rounds; r++) {
    for (let x = 0; x < 5; x++) {
      cLo[x] = s[2 * x] ^ s[2 * (x + 5)] ^ s[2 * (x + 10)] ^ s[2 * (x + 15)] ^ s[2 * (x + 20)];
      cHi[x] = s[2 * x + 1] ^ s[2 * (x + 5) + 1] ^ s[2 * (x + 10) + 1] ^ s[2 * (x + 15) + 1] ^ s[2 * (x + 20) + 1];
    }
    for (let x = 0; x < 5; x++) {
      const pLo = cLo[(x + 4) % 5]; const pHi = cHi[(x + 4) % 5];
      const nLo = cLo[(x + 1) % 5]; const nHi = cHi[(x + 1) % 5];
      // theta[x] = C[x-1] ^ rot(C[x+1], 1)
      const dLo = pLo ^ ((nLo << 1) | (nHi >>> 31));
      const dHi = pHi ^ ((nHi << 1) | (nLo >>> 31));
      for (let y = 0; y < 25; y += 5) { s[2 * (x + y)] ^= dLo; s[2 * (x + y) + 1] ^= dHi; }
    }
    for (let i = 0; i < 25; i++) {
      const lo = s[2 * i]; const hi = s[2 * i + 1]; const n = RHO[i];
      let rlo; let rhi;
      if (n === 0) { rlo = lo; rhi = hi; } else if (n < 32) {
        rlo = (lo << n) | (hi >>> (32 - n)); rhi = (hi << n) | (lo >>> (32 - n));
      } else if (n === 32) { rlo = hi; rhi = lo; } else {
        const m = n - 32;
        rlo = (hi << m) | (lo >>> (32 - m)); rhi = (lo << m) | (hi >>> (32 - m));
      }
      bLo[PI_DEST[i]] = rlo; bHi[PI_DEST[i]] = rhi;
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        const i = x + y; const i1 = ((x + 1) % 5) + y; const i2 = ((x + 2) % 5) + y;
        s[2 * i] = bLo[i] ^ (~bLo[i1] & bLo[i2]);
        s[2 * i + 1] = bHi[i] ^ (~bHi[i1] & bHi[i2]);
      }
    }
    s[0] ^= RC_LO[r]; s[1] ^= RC_HI[r];
  }
  return s;
}

/** SHA3-256 with the first `rounds` (1..24) Keccak-f[1600] rounds per absorbed block. */
export function sha3_256Reduced(data, rounds) {
  assertBytes(data);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 24) throw new RangeError('unsupported Keccak prefix round count');
  const rate = 136;
  const total = Math.ceil((data.length + 1) / rate) * rate;
  const padded = new Uint8Array(total);
  padded.set(data);
  padded[data.length] = 0x06;
  padded[total - 1] |= 0x80;
  const s = new Uint32Array(50);
  for (let off = 0; off < total; off += rate) {
    for (let lane = 0; lane < rate / 8; lane++) {
      const j = off + 8 * lane;
      s[2 * lane] ^= (padded[j] | (padded[j + 1] << 8) | (padded[j + 2] << 16) | (padded[j + 3] << 24)) >>> 0;
      s[2 * lane + 1] ^= (padded[j + 4] | (padded[j + 5] << 8) | (padded[j + 6] << 16) | (padded[j + 7] << 24)) >>> 0;
    }
    keccakF1600(s, rounds);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    const v = s[i];
    out[4 * i] = v & 0xff; out[4 * i + 1] = (v >>> 8) & 0xff; out[4 * i + 2] = (v >>> 16) & 0xff; out[4 * i + 3] = v >>> 24;
  }
  return out;
}

// ---------------------------------------------------------------------------
// BLAKE3 (verifier/blake3.py)
// ---------------------------------------------------------------------------

const B3_IV = SHA256_IV;
const B3_PERM = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];
export const BLAKE3_FLAGS = Object.freeze({ CHUNK_START: 1, CHUNK_END: 2, PARENT: 4, ROOT: 8 });

function g(v, a, b, c, d, x, y) {
  v[a] = (v[a] + v[b] + x) >>> 0; v[d] = ror(v[d] ^ v[a], 16);
  v[c] = (v[c] + v[d]) >>> 0; v[b] = ror(v[b] ^ v[c], 12);
  v[a] = (v[a] + v[b] + y) >>> 0; v[d] = ror(v[d] ^ v[a], 8);
  v[c] = (v[c] + v[d]) >>> 0; v[b] = ror(v[b] ^ v[c], 7);
}

function b3Compress(cv, words, counter, blockLen, flags, rounds) {
  const v = [cv[0], cv[1], cv[2], cv[3], cv[4], cv[5], cv[6], cv[7], B3_IV[0], B3_IV[1], B3_IV[2], B3_IV[3],
    counter >>> 0, Math.floor(counter / 2 ** 32) >>> 0, blockLen >>> 0, flags >>> 0];
  let m = words.slice();
  for (let r = 0; r < rounds; r++) {
    g(v, 0, 4, 8, 12, m[0], m[1]); g(v, 1, 5, 9, 13, m[2], m[3]);
    g(v, 2, 6, 10, 14, m[4], m[5]); g(v, 3, 7, 11, 15, m[6], m[7]);
    g(v, 0, 5, 10, 15, m[8], m[9]); g(v, 1, 6, 11, 12, m[10], m[11]);
    g(v, 2, 7, 8, 13, m[12], m[13]); g(v, 3, 4, 9, 14, m[14], m[15]);
    m = B3_PERM.map((i) => m[i]);
  }
  const out = new Array(16);
  for (let i = 0; i < 8; i++) { out[i] = (v[i] ^ v[i + 8]) >>> 0; out[i + 8] = (v[i + 8] ^ cv[i]) >>> 0; }
  return out;
}

function b3Words(block) {
  const padded = new Uint8Array(64);
  padded.set(block);
  const w = new Array(16);
  for (let i = 0; i < 16; i++) w[i] = (padded[4 * i] | (padded[4 * i + 1] << 8) | (padded[4 * i + 2] << 16) | (padded[4 * i + 3] << 24)) >>> 0;
  return w;
}

function b3ChunkOutput(chunk, counter, rounds) {
  let cv = B3_IV.slice();
  const lastOffset = Math.max(0, Math.floor((chunk.length - 1) / 64) * 64);
  for (let off = 0; off <= lastOffset; off += 64) {
    const block = chunk.subarray(off, off + 64);
    const flags = off === 0 ? BLAKE3_FLAGS.CHUNK_START : 0;
    const words = b3Words(block);
    if (off === lastOffset) return [cv, words, counter, block.length, flags | BLAKE3_FLAGS.CHUNK_END];
    cv = b3Compress(cv, words, counter, 64, flags, rounds).slice(0, 8);
  }
  throw new Error('unreachable');
}

const b3ParentOutput = (left, right) => [B3_IV.slice(), [...left, ...right], 0, 64, BLAKE3_FLAGS.PARENT];

/** Unkeyed BLAKE3-256 with the first `rounds` (1..7) rounds in every compression. */
export function blake3Reduced(data, rounds) {
  assertBytes(data);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 7) throw new RangeError('unsupported BLAKE3 prefix round count');
  const chunkCount = Math.max(1, Math.ceil(data.length / 1024));
  const stack = [];
  for (let counter = 0; counter < chunkCount - 1; counter++) {
    const out = b3ChunkOutput(data.subarray(counter * 1024, (counter + 1) * 1024), counter, rounds);
    let cv = b3Compress(...out, rounds).slice(0, 8);
    let total = counter + 1;
    while ((total & 1) === 0) {
      cv = b3Compress(...b3ParentOutput(stack.pop(), cv), rounds).slice(0, 8);
      total >>= 1;
    }
    stack.push(cv);
  }
  let output = b3ChunkOutput(data.subarray((chunkCount - 1) * 1024), chunkCount - 1, rounds);
  while (stack.length) output = b3ParentOutput(stack.pop(), b3Compress(...output, rounds).slice(0, 8));
  const [cv, words, , blockLen, flags] = output;
  const root = b3Compress(cv, words, 0, blockLen, flags | BLAKE3_FLAGS.ROOT, rounds);
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[4 * i] = root[i] & 0xff; out[4 * i + 1] = (root[i] >>> 8) & 0xff;
    out[4 * i + 2] = (root[i] >>> 16) & 0xff; out[4 * i + 3] = root[i] >>> 24;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Track table
// ---------------------------------------------------------------------------

function assertBytes(data) {
  if (!(data instanceof Uint8Array)) throw new TypeError('hash input must be bytes (Uint8Array/Buffer)');
}

/**
 * The six pipeline tracks' targets, exactly as the vendored organizer repo
 * defines them (target-profiles/<target>-prefix-v1.json: algorithm, rounds,
 * digest_bits; verifier/frontier_tracks.py: profile id). tests/
 * reduced-hashes.test.js reads every one of those real profile files and
 * fails on any drift, so this table can never silently disagree with the
 * organizer's own definition.
 */
export const TRACK_TARGETS = Object.freeze({
  'sha256-r31-exploratory': Object.freeze({ algorithm: 'sha256', rounds: 31, fullRounds: 64, digestBits: 256, profileId: 'sha256-r31-prefix-v1' }),
  'sha256-r32-exploratory': Object.freeze({ algorithm: 'sha256', rounds: 32, fullRounds: 64, digestBits: 256, profileId: 'sha256-r32-prefix-v1' }),
  'sha3-256-r5-exploratory': Object.freeze({ algorithm: 'sha3_256', rounds: 5, fullRounds: 24, digestBits: 256, profileId: 'sha3-256-r5-prefix-v1' }),
  'sha3-256-r6-exploratory': Object.freeze({ algorithm: 'sha3_256', rounds: 6, fullRounds: 24, digestBits: 256, profileId: 'sha3-256-r6-prefix-v1' }),
  'blake3-r1-exploratory': Object.freeze({ algorithm: 'blake3', rounds: 1, fullRounds: 7, digestBits: 256, profileId: 'blake3-r1-prefix-v1' }),
  'blake3-r2-exploratory': Object.freeze({ algorithm: 'blake3', rounds: 2, fullRounds: 7, digestBits: 256, profileId: 'blake3-r2-prefix-v1' }),
});

const BY_ALGORITHM = { sha256: sha256Reduced, sha3_256: sha3_256Reduced, blake3: blake3Reduced };

/** Same signature as the organizer's `digest(data, algorithm, rounds)`. */
export function digest(data, algorithm, rounds) {
  const fn = BY_ALGORITHM[algorithm];
  if (!fn) throw new RangeError(`unsupported algorithm: ${algorithm}`);
  return fn(data, rounds);
}

export function targetForTrack(track) {
  const t = TRACK_TARGETS[track];
  if (!t) throw new RangeError(`no reduced-round target for track: ${track}`);
  return t;
}

/** The exact reduced-round hash a track's organizer checker uses. */
export function digestForTrack(track, data) {
  const t = targetForTrack(track);
  return digest(data, t.algorithm, t.rounds);
}

export { M32 as MASK32 };
