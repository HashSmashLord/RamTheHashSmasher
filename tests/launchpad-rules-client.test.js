import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HASH_FAMILIES,
  APPROACHES,
  MODELS,
  LIMITS,
  CREATE_FEE_SOL,
  CREATE_FEE_LAMPORTS,
  TREASURY,
  familyByName,
  familyOfTrack,
  validateHashFamily,
  validateApproach,
  validateModel,
  validateToken,
  validateOwner,
  validateDraft,
  normalizeSymbol,
  toRamRequest,
} from '../src/launchpad-rules.js';

const OWNER = '5M6Pc7ossZ8cuQAjnexH9vv2axEJoncgZ3C6uD2PJqHm'; // any valid-shaped address
const DETAIL = 'Extend the published 31-step collision path by one round using a SAT-guided search.';

const goodDraft = () => ({
  owner: OWNER,
  hashFamily: 'SHA-256',
  track: 'sha256-r32-exploratory',
  approach: 'sat-smt-search',
  approachDetail: DETAIL,
  model: 'anthropic/claude-opus-5.5',
  tokenName: 'Ram Thirty Two',
  tokenSymbol: 'r32',
  image: 'img-0123456789abcdef01234567',
});

test('constants: three families, two tracks each, real track ids and rounds', () => {
  assert.deepEqual(HASH_FAMILIES.map((f) => f.family), ['SHA-256', 'SHA3-256', 'BLAKE3']);
  assert.deepEqual(
    HASH_FAMILIES.flatMap((f) => f.tracks.map((t) => [t.track, t.rounds])),
    [
      ['sha256-r31-exploratory', 31],
      ['sha256-r32-exploratory', 32],
      ['sha3-256-r5-exploratory', 5],
      ['sha3-256-r6-exploratory', 6],
      ['blake3-r1-exploratory', 1],
      ['blake3-r2-exploratory', 2],
    ],
  );
  assert.ok(Object.isFrozen(HASH_FAMILIES) && Object.isFrozen(HASH_FAMILIES[0].tracks));
});

test('constants: six approaches, six models, limits, fee and treasury', () => {
  assert.deepEqual(APPROACHES.map((a) => a.id), [
    'literature-replication',
    'structural-shortcut',
    'sat-smt-search',
    'cost-model-tightening',
    'formal-verification',
    'trail-search-heuristics',
  ]);
  for (const a of APPROACHES) assert.ok(a.label.length > 10, a.id);
  assert.deepEqual(MODELS, [
    'anthropic/claude-opus-5.5',
    'anthropic/claude-fable-5.1',
    'openai/gpt-6.1-sol-pro',
    'openai/gpt-6.1-sol-pro',
    'deepseek/deepseek-v4-pro',
    'qwen/qwen3.8-max-prime',
  ]);
  assert.deepEqual(LIMITS, {
    approachDetail: { min: 20, max: 600 },
    tokenName: { min: 1, max: 32 },
    tokenSymbol: { min: 1, max: 10 },
  });
  assert.equal(CREATE_FEE_SOL, '0.01');
  assert.equal(CREATE_FEE_LAMPORTS, 10_000_000);
  assert.equal(TREASURY, '5M6Pc7ossZ8cuQAjnexH9vv2axEJoncgZ3C6uD2PJqHm');
});

test('familyByName and familyOfTrack are exact', () => {
  assert.equal(familyByName('BLAKE3').family, 'BLAKE3');
  assert.equal(familyByName('blake3'), undefined);
  assert.equal(familyOfTrack('sha3-256-r6-exploratory').family, 'SHA3-256');
  assert.equal(familyOfTrack('sha3-256-r7-exploratory'), undefined);
});

test('validateHashFamily accepts each family, with or without a track of its own', () => {
  for (const f of HASH_FAMILIES) {
    assert.deepEqual(validateHashFamily(f.family), { ok: true, errors: {} });
    assert.equal(validateHashFamily(f.family, '').ok, true);
    assert.equal(validateHashFamily(f.family, null).ok, true);
    for (const t of f.tracks) assert.equal(validateHashFamily(f.family, t.track).ok, true, t.track);
  }
});

test('validateHashFamily rejects arrays, even of one valid family', () => {
  for (const v of [['SHA-256'], ['SHA-256', 'BLAKE3'], []]) {
    const r = validateHashFamily(v);
    assert.equal(r.ok, false);
    assert.match(r.errors.hashFamily, /one/i);
  }
});

test('validateHashFamily rejects empty, non-string and unknown values', () => {
  for (const v of [undefined, null, '', '   ', 42, {}, 'sha-256', 'SHA256', 'MD5', 'SHA-256,BLAKE3']) {
    const r = validateHashFamily(v);
    assert.equal(r.ok, false, String(v));
    assert.ok(r.errors.hashFamily, String(v));
    assert.equal(r.errors.track, undefined);
  }
});

test('validateHashFamily rejects a track from another family or an unknown track', () => {
  const cross = validateHashFamily('SHA-256', 'blake3-r1-exploratory');
  assert.equal(cross.ok, false);
  assert.ok(cross.errors.track);
  assert.equal(cross.errors.hashFamily, undefined);
  assert.equal(validateHashFamily('BLAKE3', 'blake3-r3-exploratory').ok, false);
  assert.equal(validateHashFamily('BLAKE3', ['blake3-r1-exploratory']).ok, false);
  assert.equal(validateHashFamily('BLAKE3', 'blake3-r1').ok, false); // short id is not the track id
});

test('validateApproach: id must be one of six; detail 20–600 after trimming', () => {
  for (const a of APPROACHES) assert.equal(validateApproach(a.id, DETAIL).ok, true, a.id);
  assert.ok(validateApproach('crack-it', DETAIL).errors.approach);
  assert.ok(validateApproach('', DETAIL).errors.approach);
  assert.ok(validateApproach(['sat-smt-search'], DETAIL).errors.approach);

  assert.equal(validateApproach('sat-smt-search', 'x'.repeat(20)).ok, true);
  assert.equal(validateApproach('sat-smt-search', 'x'.repeat(600)).ok, true);
  assert.match(validateApproach('sat-smt-search', 'x'.repeat(19)).errors.approachDetail, /at least 20/);
  assert.match(validateApproach('sat-smt-search', 'x'.repeat(601)).errors.approachDetail, /600/);
  // Whitespace padding does not count toward the minimum.
  assert.equal(validateApproach('sat-smt-search', `   ${'x'.repeat(19)}     `).ok, false);
  assert.equal(validateApproach('sat-smt-search', `  ${'x'.repeat(600)}  `).ok, true);
  assert.ok(validateApproach('sat-smt-search', undefined).errors.approachDetail);
  assert.ok(validateApproach('sat-smt-search', 12345678901234567890).errors.approachDetail);
});

test('validateModel accepts only the six slugs, exactly', () => {
  for (const m of MODELS) assert.equal(validateModel(m).ok, true, m);
  for (const m of ['', 'gpt-4', 'anthropic/claude-opus-5.5 ', 'Anthropic/claude-opus-5.5', null, ['openai/gpt-6.1-sol-pro']]) {
    assert.equal(validateModel(m).ok, false, String(m));
    assert.ok(validateModel(m).errors.model);
  }
});

test('validateToken: name 1–32 after trim, no control characters', () => {
  assert.equal(validateToken('R', 'R').ok, true);
  assert.equal(validateToken('x'.repeat(32), 'RAM').ok, true);
  assert.ok(validateToken('x'.repeat(33), 'RAM').errors.tokenName);
  assert.ok(validateToken('', 'RAM').errors.tokenName);
  assert.ok(validateToken('   ', 'RAM').errors.tokenName);
  assert.ok(validateToken(undefined, 'RAM').errors.tokenName);
  assert.ok(validateToken('Ram\nHerd', 'RAM').errors.tokenName);
});

test('validateToken: symbol 1–10, A–Z0–9 only, checked after uppercasing', () => {
  assert.equal(validateToken('Ram', 'ram1').ok, true);
  assert.equal(validateToken('Ram', 'ABCDEFGHIJ').ok, true);
  assert.equal(validateToken('Ram', ' r32 ').ok, true);
  assert.ok(validateToken('Ram', 'ABCDEFGHIJK').errors.tokenSymbol);
  assert.ok(validateToken('Ram', '').errors.tokenSymbol);
  for (const bad of ['RAM-1', 'RAM 1', 'RAM$', 'ÄBC', 'RAM_1', '🐏']) {
    assert.match(validateToken('Ram', bad).errors.tokenSymbol, /A to Z/, bad);
  }
  assert.ok(validateToken('Ram', null).errors.tokenSymbol);
  assert.equal(normalizeSymbol(' ram1 '), 'RAM1');
});

test('validateOwner checks base58 address shape', () => {
  assert.equal(validateOwner(OWNER).ok, true);
  for (const bad of ['', '0OIl' + 'x'.repeat(40), 'short', null, OWNER + 'xxxxxxxx']) {
    assert.equal(validateOwner(bad).ok, false, String(bad));
  }
});

test('validateDraft passes a complete draft and collects every field error', () => {
  assert.deepEqual(validateDraft(goodDraft()), { ok: true, errors: {} });
  assert.equal(validateDraft({ ...goodDraft(), track: '' }).ok, true);

  const r = validateDraft({});
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.errors).sort(), [
    'approach',
    'approachDetail',
    'hashFamily',
    'image',
    'model',
    'owner',
    'tokenName',
    'tokenSymbol',
  ]);
  assert.equal(validateDraft(null).ok, false);
  assert.equal(validateDraft({ ...goodDraft(), hashFamily: ['SHA-256'] }).ok, false);
  assert.ok(validateDraft({ ...goodDraft(), track: 'blake3-r2-exploratory' }).errors.track);
});

test('toRamRequest trims, uppercases, defaults the track, and sends one family string', () => {
  const body = toRamRequest({ ...goodDraft(), track: '', tokenName: '  Ram  ', tokenSymbol: ' r32 ', approachDetail: `  ${DETAIL}  ` });
  assert.equal(body.hashFamily, 'SHA-256');
  assert.equal(typeof body.hashFamily, 'string');
  assert.equal(body.track, 'sha256-r31-exploratory');
  assert.equal(body.tokenName, 'Ram');
  assert.equal(body.tokenSymbol, 'R32');
  assert.equal(body.approachDetail, DETAIL);
  assert.deepEqual(Object.keys(body).sort(), [
    'approach', 'approachDetail', 'hashFamily', 'image', 'model', 'owner', 'tokenName', 'tokenSymbol', 'track',
  ]);
  assert.equal(toRamRequest(goodDraft()).track, 'sha256-r32-exploratory');
});
