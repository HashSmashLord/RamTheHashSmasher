// HashSmash lane/target catalog.
//
// Grounded in `reference/hash-smash/benchmark.json` and
// `docs/research/hashsmash-technical-brief.md` section 2.2 ("Legitimate
// approaches that fit the exploratory track").
//
// The Yukon root manifest currently declares exactly six *exploratory*
// tracks as active solver assignments (rigorous lanes, MD5/SHA-1/Keccak[800]
// and Poseidon all exist in the local research catalog but are excluded from
// the active manifest). A solver-agent slot's "lane/target" is one of these
// six; its "approach" is one of the six concrete research angles the
// technical brief identifies as realistic for an AI agent to attempt and
// get a non-garbage review outcome on. Cycling multiple slots over the same
// target with different approaches is this file's own assignment policy,
// not something the manifest itself defines.

/** The six active exploratory tracks, in manifest order. */
export const ACTIVE_TRACKS = [
  {
    track: 'sha256-r31-exploratory',
    hashFunction: 'SHA-256',
    rounds: 31,
    lane: 'exploratory',
    editablePath: 'lanes/exploratory/candidates/sha256-r31',
  },
  {
    track: 'sha256-r32-exploratory',
    hashFunction: 'SHA-256',
    rounds: 32,
    lane: 'exploratory',
    editablePath: 'lanes/exploratory/candidates/sha256-r32',
  },
  {
    track: 'sha3-256-r5-exploratory',
    hashFunction: 'SHA3-256',
    rounds: 5,
    lane: 'exploratory',
    editablePath: 'lanes/exploratory/candidates/sha3-256-r5',
  },
  {
    track: 'sha3-256-r6-exploratory',
    hashFunction: 'SHA3-256',
    rounds: 6,
    lane: 'exploratory',
    editablePath: 'lanes/exploratory/candidates/sha3-256-r6',
  },
  {
    track: 'blake3-r1-exploratory',
    hashFunction: 'BLAKE3',
    rounds: 1,
    lane: 'exploratory',
    editablePath: 'lanes/exploratory/candidates/blake3-r1',
  },
  {
    track: 'blake3-r2-exploratory',
    hashFunction: 'BLAKE3',
    rounds: 2,
    lane: 'exploratory',
    editablePath: 'lanes/exploratory/candidates/blake3-r2',
  },
];

/**
 * Research angles a solver slot can be assigned alongside a track — the six
 * approaches `docs/research/hashsmash-technical-brief.md` section 2.2
 * identifies as realistic for an AI agent to attempt here and get a real
 * (non-garbage) review outcome on, in the order the brief lists them.
 */
export const APPROACHES = [
  // 1. Reproduce/adapt a published reduced-round attack (what sha256-r31/r32 do).
  'literature-replication',
  // 2. Find round-specific structure (e.g. BLAKE3 r1's independent output halves).
  'structural-shortcut',
  // 3. SAT/SMT-based differential or preimage search for a better characteristic.
  'sat-smt-search',
  // 4. Tighten time/memory accounting on an already-correct construction.
  'cost-model-tightening',
  // 5. Formal-verification-flavored tightening of the probability/injectivity argument.
  'formal-verification',
  // 6. Novel search heuristics for differential trails on the shallow, unexploited targets.
  'trail-search-heuristics',
];

/**
 * Deterministically picks the Nth (track, approach) assignment, cycling
 * through tracks first and then approaches, so a growing slot pool spreads
 * across targets before doubling up on the same track.
 *
 * @param {number} index - 0-based slot-assignment index.
 */
export function assignmentForIndex(index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError('index must be a non-negative integer');
  }
  const track = ACTIVE_TRACKS[index % ACTIVE_TRACKS.length];
  const approach = APPROACHES[Math.floor(index / ACTIVE_TRACKS.length) % APPROACHES.length];
  return { ...track, approach };
}
