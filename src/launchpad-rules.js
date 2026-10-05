// RAMherd launchpad: the rules a "Create a RAM" draft must meet, shared by the page
// (launch.js) and by node tests. Pure ESM: no DOM, no fetch, no globals.
//
// The server holds its own copy of these rules and is the authority; this file exists so the
// form can say what is wrong before anything is sent. A test cross-checks the two.

/**
 * The three hash families a RAM can work on, each with its real HashSmash exploratory tracks
 * (same ids and round counts as server/lib/targets.js). A RAM works on exactly one family.
 */
export const HASH_FAMILIES = Object.freeze([
  Object.freeze({
    family: 'SHA-256',
    tracks: Object.freeze([
      Object.freeze({ track: 'sha256-r31-exploratory', rounds: 31 }),
      Object.freeze({ track: 'sha256-r32-exploratory', rounds: 32 }),
    ]),
  }),
  Object.freeze({
    family: 'SHA3-256',
    tracks: Object.freeze([
      Object.freeze({ track: 'sha3-256-r5-exploratory', rounds: 5 }),
      Object.freeze({ track: 'sha3-256-r6-exploratory', rounds: 6 }),
    ]),
  }),
  Object.freeze({
    family: 'BLAKE3',
    tracks: Object.freeze([
      Object.freeze({ track: 'blake3-r1-exploratory', rounds: 1 }),
      Object.freeze({ track: 'blake3-r2-exploratory', rounds: 2 }),
    ]),
  }),
]);

/** The six research approaches (ids match server/lib/targets.js APPROACHES). */
export const APPROACHES = Object.freeze([
  Object.freeze({ id: 'literature-replication', label: 'Reproduce or adapt a published reduced-round attack' }),
  Object.freeze({ id: 'structural-shortcut', label: 'Find round-specific structure to exploit' }),
  Object.freeze({ id: 'sat-smt-search', label: 'SAT/SMT search for a better differential or preimage' }),
  Object.freeze({ id: 'cost-model-tightening', label: 'Tighten the time/memory accounting of a correct construction' }),
  Object.freeze({ id: 'formal-verification', label: 'Formally tighten the probability or injectivity argument' }),
  Object.freeze({ id: 'trail-search-heuristics', label: 'New search heuristics for differential trails' }),
]);

/** The six OpenRouter model slugs a RAM can run (the launch roster's models). */
export const MODELS = Object.freeze([
  'anthropic/claude-opus-5.5',
  'anthropic/claude-fable-5.1',
  'openai/gpt-6.1-sol-pro',
  'z-ai/glm-5.3-prime',
  'deepseek/deepseek-v4-pro',
  'qwen/qwen3.8-max-prime',
]);

export const LIMITS = Object.freeze({
  approachDetail: Object.freeze({ min: 20, max: 600 }),
  tokenName: Object.freeze({ min: 1, max: 32 }),
  tokenSymbol: Object.freeze({ min: 1, max: 10 }),
});

export const CREATE_FEE_SOL = '0.2';
export const CREATE_FEE_LAMPORTS = 200_000_000;

/** The RAMherd treasury: receives the create fee and 100% of the token's creator fees. */
export const TREASURY = '5M6Pc7ossZ8cuQAjnexH9vv2axEJoncgZ3C6uD2PJqHm';

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SYMBOL_CHARS = /^[A-Z0-9]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const result = (errors) => ({ ok: Object.keys(errors).length === 0, errors });

/** The family record for a name, or undefined. Exact match only ("sha-256" is not "SHA-256"). */
export function familyByName(name) {
  return HASH_FAMILIES.find((f) => f.family === name);
}

/** The family a track id belongs to, or undefined. */
export function familyOfTrack(track) {
  return HASH_FAMILIES.find((f) => f.tracks.some((t) => t.track === track));
}

/**
 * Exactly one hash family, and optionally one track inside it.
 * Rejects arrays (a RAM works one family, never several), empty values, unknown names, and a
 * track that belongs to another family or does not exist. An absent/empty track is fine: the
 * family's first track is used.
 */
export function validateHashFamily(value, track) {
  const errors = {};
  if (Array.isArray(value)) {
    errors.hashFamily = 'Choose one hash family. A RAM works on one family, not several.';
  } else if (typeof value !== 'string' || value.trim() === '') {
    errors.hashFamily = 'Choose a hash family: SHA-256, SHA3-256 or BLAKE3.';
  } else if (!familyByName(value)) {
    errors.hashFamily = `"${value}" is not one of SHA-256, SHA3-256 or BLAKE3.`;
  }
  if (!errors.hashFamily && track !== undefined && track !== null && track !== '') {
    const family = familyByName(value);
    if (typeof track !== 'string' || !family.tracks.some((t) => t.track === track)) {
      errors.track = `That round is not one of ${family.family}'s tracks.`;
    }
  }
  return result(errors);
}

/** One approach id from APPROACHES, and a 20–600 character description (trimmed). */
export function validateApproach(id, detail) {
  const errors = {};
  if (typeof id !== 'string' || !APPROACHES.some((a) => a.id === id)) {
    errors.approach = 'Choose one of the six approaches.';
  }
  const { min, max } = LIMITS.approachDetail;
  if (typeof detail !== 'string') {
    errors.approachDetail = `Say what your RAM should try, in ${min} to ${max} characters.`;
  } else {
    const n = detail.trim().length;
    if (n < min) errors.approachDetail = `Write at least ${min} characters (${n} so far).`;
    else if (n > max) errors.approachDetail = `Keep it to ${max} characters (${n} now).`;
  }
  return result(errors);
}

/** One of the six model slugs, exactly. */
export function validateModel(slug) {
  const errors = {};
  if (typeof slug !== 'string' || !MODELS.includes(slug)) errors.model = 'Choose one of the six models.';
  return result(errors);
}

/** Uppercases and trims a symbol the way the form does before it is checked or sent. */
export function normalizeSymbol(symbol) {
  return typeof symbol === 'string' ? symbol.trim().toUpperCase() : symbol;
}

/**
 * Token name: 1–32 characters after trimming, no control characters.
 * Token symbol: 1–10 characters, A–Z and 0–9 only, checked after uppercasing (so "ram1" is
 * accepted as "RAM1"; "RAM-1" and "RAM 1" are not).
 */
export function validateToken(name, symbol) {
  const errors = {};
  const nameLimit = LIMITS.tokenName;
  if (typeof name !== 'string' || name.trim().length < nameLimit.min) {
    errors.tokenName = 'Give the token a name.';
  } else if (name.trim().length > nameLimit.max) {
    errors.tokenName = `Keep the name to ${nameLimit.max} characters.`;
  } else if (CONTROL_CHARS.test(name)) {
    errors.tokenName = 'The name has a character that cannot be printed.';
  }
  const symLimit = LIMITS.tokenSymbol;
  const sym = normalizeSymbol(symbol);
  if (typeof sym !== 'string' || sym.length < symLimit.min) {
    errors.tokenSymbol = 'Give the token a symbol.';
  } else if (sym.length > symLimit.max) {
    errors.tokenSymbol = `Keep the symbol to ${symLimit.max} characters.`;
  } else if (!SYMBOL_CHARS.test(sym)) {
    errors.tokenSymbol = 'Letters A to Z and digits 0 to 9 only.';
  }
  return result(errors);
}

/** A Solana address in base58 (32–44 characters). Shape only: not an on-curve check. */
export function validateOwner(owner) {
  const errors = {};
  if (typeof owner !== 'string' || !BASE58_ADDRESS.test(owner)) errors.owner = 'Connect a wallet first.';
  return result(errors);
}

/**
 * The whole draft. `form` = { owner, hashFamily, track, approach, approachDetail, model,
 * tokenName, tokenSymbol }. Returns { ok, errors: { field: message } }.
 */
export function validateDraft(form) {
  const f = form && typeof form === 'object' ? form : {};
  const errors = {
    ...validateOwner(f.owner).errors,
    ...validateHashFamily(f.hashFamily, f.track).errors,
    ...validateApproach(f.approach, f.approachDetail).errors,
    ...validateModel(f.model).errors,
    ...validateToken(f.tokenName, f.tokenSymbol).errors,
  };
  return result(errors);
}

/**
 * The request body for POST /api/launchpad/rams, from a draft that passed validateDraft:
 * trimmed text, uppercased symbol, the family's first track when none was picked.
 * `hashFamily` is always a single string.
 */
export function toRamRequest(form) {
  const family = familyByName(form.hashFamily);
  return {
    owner: form.owner,
    hashFamily: form.hashFamily,
    track: form.track || (family ? family.tracks[0].track : undefined),
    approach: form.approach,
    approachDetail: String(form.approachDetail).trim(),
    model: form.model,
    tokenName: String(form.tokenName).trim(),
    tokenSymbol: normalizeSymbol(form.tokenSymbol),
  };
}
