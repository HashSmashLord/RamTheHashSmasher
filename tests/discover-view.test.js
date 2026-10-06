// Discover (/discover): src/discover-view.js's pure status filtering and link-building, plus
// the new RAMherdAPI.launchpad.listRams() client (src/mock-data.js), checked against a real
// server end to end — a draft never counts as launched; a RAM the operator actually confirmed
// does, with its real round label, image URL and (only once a mint is on record) pump.fun link.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { randomBytes } from 'node:crypto';
import { startApp } from './helpers/harness.js';
import { makePng } from './helpers/png.js';
import { isLaunched, launchedRams, pumpFunUrl, ramRoundLabel, tokenImageUrl } from '../src/discover-view.js';
import { RAMherdAPI } from '../src/mock-data.js';

const wallet = () => Keypair.generate().publicKey.toBase58();
const sig = () => bs58.encode(randomBytes(64)); // shaped like a tx signature

test('isLaunched / launchedRams: only RAM_STATUSES "active" counts, never draft/awaiting-signature/cancelled', () => {
  assert.equal(isLaunched({ status: 'active' }), true);
  for (const status of ['draft', 'awaiting-signature', 'cancelled', 'something-unknown']) {
    assert.equal(isLaunched({ status }), false, status);
  }
  assert.equal(isLaunched(null), false);
  assert.equal(isLaunched(undefined), false);

  const rams = [
    { id: 'a', status: 'draft' },
    { id: 'b', status: 'active' },
    { id: 'c', status: 'cancelled' },
    { id: 'd', status: 'active' },
    { id: 'e', status: 'awaiting-signature' },
  ];
  assert.deepEqual(launchedRams(rams).map((r) => r.id), ['b', 'd']);
  assert.deepEqual(launchedRams(null), []);
  assert.deepEqual(launchedRams(undefined), []);
  assert.deepEqual(launchedRams([]), []);
});

test('ramRoundLabel: the RAM\'s own recorded family and rounds, never the raw track id', () => {
  assert.equal(ramRoundLabel({ hashFamily: 'SHA-256', rounds: 31 }), 'SHA-256 r31');
  assert.equal(ramRoundLabel({ hashFamily: 'BLAKE3', rounds: 2 }), 'BLAKE3 r2');
  assert.equal(ramRoundLabel({ hashFamily: 'SHA-256' }), '', 'no rounds on record');
  assert.equal(ramRoundLabel({ rounds: 31 }), '', 'no family on record');
  assert.equal(ramRoundLabel({}), '');
  assert.equal(ramRoundLabel(null), '');
});

test('tokenImageUrl: the pinned gateway URL when there is one, else this server\'s own self-hosted route; never guessed', () => {
  assert.equal(tokenImageUrl({ token: { image: 'https://pinata.example/x.png', imageId: 'img-0123456789abcdef01234567' } }), 'https://pinata.example/x.png');
  assert.equal(tokenImageUrl({ token: { image: null, imageId: 'img-0123456789abcdef01234567' } }), '/api/launchpad/images/img-0123456789abcdef01234567');
  assert.equal(tokenImageUrl({ token: {} }), null);
  assert.equal(tokenImageUrl({}), null);
  assert.equal(tokenImageUrl(null), null);
});

test('pumpFunUrl: built only from a real recorded mint; null, never guessed, when there is none', () => {
  const mint = wallet();
  assert.equal(pumpFunUrl({ token: { mint } }), `https://pump.fun/coin/${mint}`);
  assert.equal(pumpFunUrl({ token: { mint: null } }), null);
  assert.equal(pumpFunUrl({ token: {} }), null);
  assert.equal(pumpFunUrl({}), null);
  assert.equal(pumpFunUrl(null), null);
});

test('RAMherdAPI.launchpad.listRams(): honest empty fallback with no backend reachable (no DOM/location under node)', async () => {
  const res = await RAMherdAPI.launchpad.listRams();
  assert.equal(res.mock, true);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.rams, [], 'never invents a row');
});

test('against a real server: GET /api/launchpad/rams lists every status; discover-view keeps only the one actually launched', async (t) => {
  const s = await startApp({ launchpadRateLimit: { max: 1000, windowMs: 60_000 } });
  t.after(() => s.stop());

  async function uploadImage(note) {
    const res = await fetch(`${s.base}/api/launchpad/images`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: makePng({ note }) });
    assert.equal(res.status, 201);
    return (await res.json()).image.id;
  }

  async function createRam(over) {
    const res = await s.postJson('/api/launchpad/rams', {
      owner: wallet(),
      hashFamily: 'SHA3-256',
      track: 'sha3-256-r5-exploratory',
      approach: 'sat-smt-search',
      approachDetail: 'SAT-solver search for a better 5-round preimage differential than the published one.',
      model: 'openai/gpt-6.1-sol-pro',
      tokenName: 'Draft Token',
      tokenSymbol: 'DRFT',
      image: await uploadImage('discover-view.test'),
      ...over,
    });
    assert.equal(res.status, 201);
    return (await res.json()).ram;
  }

  const draft = await createRam({ tokenName: 'Still Drafting', tokenSymbol: 'DRAFT' });
  const launching = await createRam({
    hashFamily: 'BLAKE3',
    track: 'blake3-r2-exploratory',
    tokenName: 'Actually Launched',
    tokenSymbol: 'REAL',
  });

  // Mirrors tests/ram-resolve.test.js: prepareLaunch direct on the store (no lookup table
  // needed for this), then confirm through the real admin route, same as the operator would.
  const mint = wallet();
  s.store.rams.prepareLaunch(launching.id, mint);
  const confirmed = await s.postJson(`/api/admin/launchpad/rams/${launching.id}/confirm`, { signature: sig(), briefApproved: true }, { headers: s.adminHeaders() });
  assert.equal(confirmed.status, 200);

  const listed = await (await s.get('/api/launchpad/rams')).json();
  assert.equal(listed.rams.length, 2, 'the real route lists every status, draft and active alike');
  assert.ok(listed.rams.some((r) => r.id === draft.id && r.status === 'draft'));

  const onlyLaunched = launchedRams(listed.rams);
  assert.deepEqual(onlyLaunched.map((r) => r.id), [launching.id], 'the draft never counts as launched');
  assert.equal(onlyLaunched[0].status, 'active');
  assert.equal(ramRoundLabel(onlyLaunched[0]), 'BLAKE3 r2');
  assert.equal(pumpFunUrl(onlyLaunched[0]), `https://pump.fun/coin/${mint}`);
  assert.equal(tokenImageUrl(onlyLaunched[0]), onlyLaunched[0].token.image || `/api/launchpad/images/${onlyLaunched[0].token.imageId}`);
});
