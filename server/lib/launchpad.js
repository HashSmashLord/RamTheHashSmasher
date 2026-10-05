// Launchpad: what a user-created RAM is allowed to be.
//
// Pure validation over a create request. A RAM works on exactly ONE hash
// family (SHA-256, SHA3-256 or BLAKE3), on one of that family's live HashSmash
// exploratory tracks, with one research approach from the brief's catalog, a
// short free-text brief of what to try, and one model from the real launch
// roster (server/lib/targets.js). Anything else is refused with a reason per
// field. Nothing here touches the network, a wallet or a key.
//
// The free-text brief goes through the same rule screen as viewer ideas
// (moderation.js `screenIdea`). That screen is a first filter, not the gate:
// the operator still approves the brief when confirming the launch, before
// the RAM's slot exists (see rams.js `confirmLaunch`).

import { PublicKey } from '@solana/web3.js';
import { ACTIVE_TRACKS, APPROACHES, DEFAULT_ROSTER } from './targets.js';
import { screenIdea } from './moderation.js';
import { DEFAULT_TREASURY } from './launchtx.js';

/** The three hash families a RAM can be pointed at, in manifest order. */
export const HASH_FAMILIES = Object.freeze([...new Set(ACTIVE_TRACKS.map((t) => t.hashFunction))]);

/** Family -> its live exploratory tracks. */
export const TRACKS_BY_FAMILY = Object.freeze(
  Object.fromEntries(
    HASH_FAMILIES.map((f) => [f, Object.freeze(ACTIVE_TRACKS.filter((t) => t.hashFunction === f).map((t) => Object.freeze({ track: t.track, rounds: t.rounds })))]),
  ),
);

/** Models a user may pick: exactly the verified launch-roster slugs. */
export const LAUNCHPAD_MODELS = Object.freeze([...new Set(DEFAULT_ROSTER.map((r) => r.model))]);

/** Human labels for the approach catalog (technical brief section 2.2). */
export const APPROACH_LABELS = Object.freeze({
  'literature-replication': 'Reproduce or adapt a published reduced-round attack',
  'structural-shortcut': 'Find round-specific structure to exploit',
  'sat-smt-search': 'SAT/SMT search for a better differential or preimage',
  'cost-model-tightening': 'Tighten the time/memory accounting of a correct construction',
  'formal-verification': 'Formally tighten the probability or injectivity argument',
  'trail-search-heuristics': 'New search heuristics for differential trails',
});

export const LIMITS = Object.freeze({
  approachDetail: Object.freeze({ min: 20, max: 600 }),
  tokenName: Object.freeze({ min: 1, max: 32 }),
  tokenSymbol: Object.freeze({ min: 1, max: 10 }),
});

const SYMBOL_RE = /^[A-Z0-9]+$/;
// Printable, no control/zero-width characters: token names end up on chain.
const NAME_RE = /^[\p{L}\p{N} .,'&!?:+()-]+$/u;

/**
 * Exactly one hash family. Arrays (even of length one), unknown names and a
 * track outside the family are refused.
 * @returns {{ ok: true, hashFamily: string, track: string, rounds: number } | { ok: false, field: string, reason: string }}
 */
export function validateHashFamily(hashFamily, track) {
  if (Array.isArray(hashFamily)) return { ok: false, field: 'hashFamily', reason: 'Pick exactly one hash family, not a list.' };
  if (typeof hashFamily !== 'string' || !hashFamily) return { ok: false, field: 'hashFamily', reason: `Pick one hash family: ${HASH_FAMILIES.join(', ')}.` };
  if (!HASH_FAMILIES.includes(hashFamily)) return { ok: false, field: 'hashFamily', reason: `Unknown hash family. Pick one of: ${HASH_FAMILIES.join(', ')}.` };
  const tracks = TRACKS_BY_FAMILY[hashFamily];
  if (track === undefined || track === null || track === '') return { ok: true, hashFamily, track: tracks[0].track, rounds: tracks[0].rounds };
  const found = tracks.find((t) => t.track === track);
  if (!found) return { ok: false, field: 'track', reason: `That track is not a ${hashFamily} track. Options: ${tracks.map((t) => t.track).join(', ')}.` };
  return { ok: true, hashFamily, track: found.track, rounds: found.rounds };
}

/** One catalog approach plus a 20-600 character brief that passes the screen. */
export function validateApproach(approach, approachDetail) {
  const errors = {};
  if (typeof approach !== 'string' || !APPROACHES.includes(approach)) {
    errors.approach = `Pick one approach: ${APPROACHES.join(', ')}.`;
  }
  if (typeof approachDetail !== 'string') {
    errors.approachDetail = 'Say what specifically your RAM should try.';
  } else {
    const text = approachDetail.trim();
    const { min, max } = LIMITS.approachDetail;
    if (text.length < min) errors.approachDetail = `Write at least ${min} characters on what your RAM should try.`;
    else if (text.length > max) errors.approachDetail = `Keep it to ${max} characters.`;
    else {
      const screen = screenIdea(text);
      if (!screen.ok) errors.approachDetail = `Screened out: ${screen.reason}`;
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, approach, approachDetail: approachDetail.trim() };
}

export function validateModel(model) {
  if (typeof model !== 'string' || !LAUNCHPAD_MODELS.includes(model)) {
    return { ok: false, field: 'model', reason: `Pick one of the roster models: ${LAUNCHPAD_MODELS.join(', ')}.` };
  }
  return { ok: true, model };
}

/**
 * A user wallet: a valid base58 ed25519 public key ON the curve (so a real
 * keypair can sign for it; a PDA cannot), and never the treasury itself.
 */
export function validateOwnerWallet(owner, { treasury = DEFAULT_TREASURY } = {}) {
  if (typeof owner !== 'string' || !owner) return { ok: false, field: 'owner', reason: 'Connect a wallet first.' };
  let key;
  try {
    key = new PublicKey(owner);
  } catch {
    return { ok: false, field: 'owner', reason: 'Not a valid Solana address.' };
  }
  if (key.toBase58() !== owner) return { ok: false, field: 'owner', reason: 'Not a canonical Solana address.' };
  if (!PublicKey.isOnCurve(key.toBytes())) return { ok: false, field: 'owner', reason: 'That address cannot sign (not a wallet).' };
  if (owner === treasury) return { ok: false, field: 'owner', reason: 'The treasury cannot own a RAM.' };
  return { ok: true, owner };
}

export function validateToken(tokenName, tokenSymbol) {
  const errors = {};
  const name = typeof tokenName === 'string' ? tokenName.trim() : '';
  const symbol = typeof tokenSymbol === 'string' ? tokenSymbol.trim().toUpperCase() : '';
  if (name.length < LIMITS.tokenName.min || Buffer.byteLength(name) > LIMITS.tokenName.max) {
    errors.tokenName = `Token name must be 1-${LIMITS.tokenName.max} characters.`;
  } else if (!NAME_RE.test(name)) {
    errors.tokenName = 'Token name has characters that are not allowed.';
  }
  if (symbol.length < LIMITS.tokenSymbol.min || symbol.length > LIMITS.tokenSymbol.max || !SYMBOL_RE.test(symbol)) {
    errors.tokenSymbol = `Symbol must be 1-${LIMITS.tokenSymbol.max} letters or digits.`;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, tokenName: name, tokenSymbol: symbol };
}

const ALLOWED_FIELDS = new Set(['owner', 'hashFamily', 'track', 'approach', 'approachDetail', 'model', 'tokenName', 'tokenSymbol']);

/**
 * Validates a whole create request. Unknown fields are refused too, so a
 * client cannot slip in e.g. `hashFamilies: [...]` or a payout address.
 * @returns {{ ok: true, value: object } | { ok: false, fields: Record<string, string> }}
 */
export function validateCreateRequest(body, { treasury = DEFAULT_TREASURY } = {}) {
  const fields = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, fields: { body: 'Expected a JSON object.' } };
  for (const key of Object.keys(body)) if (!ALLOWED_FIELDS.has(key)) fields[key] = 'Unknown field.';

  const owner = validateOwnerWallet(body.owner, { treasury });
  if (!owner.ok) fields[owner.field] = owner.reason;
  const family = validateHashFamily(body.hashFamily, body.track);
  if (!family.ok) fields[family.field] = family.reason;
  const approach = validateApproach(body.approach, body.approachDetail);
  if (!approach.ok) Object.assign(fields, approach.errors);
  const model = validateModel(body.model);
  if (!model.ok) fields[model.field] = model.reason;
  const token = validateToken(body.tokenName, body.tokenSymbol);
  if (!token.ok) Object.assign(fields, token.errors);

  if (Object.keys(fields).length) return { ok: false, fields };
  return {
    ok: true,
    value: {
      owner: owner.owner,
      hashFamily: family.hashFamily,
      track: family.track,
      rounds: family.rounds,
      approach: approach.approach,
      approachDetail: approach.approachDetail,
      model: model.model,
      tokenName: token.tokenName,
      tokenSymbol: token.tokenSymbol,
    },
  };
}

/** Public, static launchpad description for the frontend. */
export function launchpadCatalog() {
  return {
    hashFamilies: HASH_FAMILIES.map((family) => ({ family, tracks: TRACKS_BY_FAMILY[family].map((t) => ({ ...t })) })),
    approaches: APPROACHES.map((id) => ({ id, label: APPROACH_LABELS[id] })),
    models: DEFAULT_ROSTER.map((r) => ({ slug: r.model, ram: r.ram, track: r.track })),
    limits: JSON.parse(JSON.stringify(LIMITS)),
  };
}
