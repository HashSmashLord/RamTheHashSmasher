// /herd#ram/<id> resolution (src/ram-resolve.js): a slot id, or a launchpad RAM id (the
// website link pinned into its token's metadata before the RAM had a slot).

import test from 'node:test';
import { makePng } from './helpers/png.js';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { randomBytes } from 'node:crypto';
import { resolveRamId } from '../src/ram-resolve.js';
import { startApp } from './helpers/harness.js';

/** A fake fetch over a fixed path -> body table; anything else 404s. Records paths. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (path) => {
    calls.push(path);
    if (!(path in routes)) return { ok: false, status: 404, json: async () => ({}) };
    const r = routes[path];
    if (r === 500) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => r };
  };
  return { impl, calls };
}

test('a slot id resolves straight to its slot; the launchpad is never asked', async () => {
  const f = fakeFetch({ '/api/slots/slot-4': { slot: { id: 'slot-4' } } });
  const r = await resolveRamId('slot-4', { fetchImpl: f.impl });
  assert.deepEqual(r, { kind: 'slot', slot: { id: 'slot-4' } });
  assert.deepEqual(f.calls, ['/api/slots/slot-4']);
});

test('an owned slot (ramId set) resolves as "launched" too, not the bare "slot" shape -- every board tile and Discover card links by slot id, so this is the path a real visitor actually takes', async () => {
  const ram = { id: 'ram-0007', status: 'active', slotId: 'slot-6', token: { name: 'Keccak Knocker' } };
  const f = fakeFetch({
    '/api/slots/slot-6': { slot: { id: 'slot-6', kind: 'owned', ramId: 'ram-0007' } },
    '/api/launchpad/rams/ram-0007': { ram },
  });
  const r = await resolveRamId('slot-6', { fetchImpl: f.impl });
  assert.equal(r.kind, 'launched');
  assert.equal(r.slot.id, 'slot-6');
  assert.equal(r.ram.id, 'ram-0007');
  assert.deepEqual(f.calls, ['/api/slots/slot-6', '/api/launchpad/rams/ram-0007']);
});

test('an active launchpad id: slot 404 -> launchpad record -> its own slot', async () => {
  const ram = { id: 'ram-0001', status: 'active', slotId: 'slot-6' };
  const f = fakeFetch({ '/api/launchpad/rams/ram-0001': { ram }, '/api/slots/slot-6': { slot: { id: 'slot-6', kind: 'owned' } } });
  const r = await resolveRamId('ram-0001', { fetchImpl: f.impl });
  assert.equal(r.kind, 'launched');
  assert.equal(r.slot.id, 'slot-6');
  assert.equal(r.ram.id, 'ram-0001');
  assert.deepEqual(f.calls, ['/api/slots/ram-0001', '/api/launchpad/rams/ram-0001', '/api/slots/slot-6']);
});

test('a launchpad id that has not launched resolves to an honest not-launched record, never a slot', async () => {
  for (const status of ['draft', 'awaiting-signature', 'cancelled']) {
    const f = fakeFetch({ '/api/launchpad/rams/ram-0002': { ram: { id: 'ram-0002', status, slotId: null } } });
    const r = await resolveRamId('ram-0002', { fetchImpl: f.impl });
    assert.equal(r.kind, 'not-launched', status);
    assert.equal(r.ram.status, status);
    assert.equal(r.slot, undefined);
  }
});

test('unknown anywhere -> null; an active RAM whose slot is missing -> null (nothing invented); 5xx throws', async () => {
  assert.equal(await resolveRamId('nope', { fetchImpl: fakeFetch({}).impl }), null);
  const orphan = fakeFetch({ '/api/launchpad/rams/ram-0003': { ram: { id: 'ram-0003', status: 'active', slotId: 'slot-99' } } });
  assert.equal(await resolveRamId('ram-0003', { fetchImpl: orphan.impl }), null);
  await assert.rejects(resolveRamId('slot-1', { fetchImpl: fakeFetch({ '/api/slots/slot-1': 500 }).impl }), /500/);
});

test('against a real server: the same launchpad id resolves before and after the operator confirms', async (t) => {
  const s = await startApp({ launchpadRateLimit: { max: 1000, windowMs: 60_000 } });
  t.after(() => s.stop());
  const fetchImpl = (path, opts) => fetch(`${s.base}${path}`, opts);
  // The token image first, through the real upload route, as the entry slip does.
  const up = await fetch(`${s.base}/api/launchpad/images`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: makePng({ note: 'ram-resolve.test' }) });
  assert.equal(up.status, 201);
  const { image } = await up.json();
  const res = await s.postJson('/api/launchpad/rams', {
    owner: Keypair.generate().publicKey.toBase58(),
    hashFamily: 'SHA3-256',
    track: 'sha3-256-r6-exploratory',
    approach: 'literature-replication',
    approachDetail: 'Adapt the known 6-round Keccak collision attack to the exploratory cost model.',
    model: 'z-ai/glm-5.3-prime',
    tokenName: 'Keccak Knocker',
    tokenSymbol: 'KECK',
    image: image.id,
  });
  assert.equal(res.status, 201);
  const { ram } = await res.json();

  // The metadata's website link is this id, on the herd page.
  const meta = await (await s.get(`/api/launchpad/rams/${ram.id}/metadata.json`)).json();
  assert.equal(meta.external_url, `${s.config.launchpad.publicBaseUrl}/herd#ram/${ram.id}`);

  let r = await resolveRamId(ram.id, { fetchImpl });
  assert.equal(r.kind, 'not-launched');
  assert.equal(r.ram.status, 'draft');

  // The unsigned-transaction route needs an RPC; record the browser's mint directly, as it would.
  s.store.rams.prepareLaunch(ram.id, Keypair.generate().publicKey.toBase58());
  assert.equal((await resolveRamId(ram.id, { fetchImpl })).ram.status, 'awaiting-signature');

  const ok = await s.postJson(`/api/admin/launchpad/rams/${ram.id}/confirm`, { signature: bs58.encode(randomBytes(64)), briefApproved: true }, { headers: s.adminHeaders() });
  assert.equal(ok.status, 200);
  const active = (await ok.json()).ram;

  r = await resolveRamId(ram.id, { fetchImpl });
  assert.equal(r.kind, 'launched');
  assert.equal(r.slot.id, active.slotId);
  assert.equal(r.slot.kind, 'owned');
  assert.equal(r.slot.ramId, ram.id);
  // And the slot id itself -- the id every real link on the site actually uses -- resolves
  // the same "launched" way, same token/funding facts attached, not the bare slot shape.
  const bySlot = await resolveRamId(active.slotId, { fetchImpl });
  assert.equal(bySlot.kind, 'launched');
  assert.equal(bySlot.slot.id, active.slotId);
  assert.equal(bySlot.ram.id, ram.id);

  // The roster ceiling grew by one with that launch, visible on the public route.
  const { allocation } = await (await s.get('/api/allocation')).json();
  assert.equal(allocation.maxSlots, allocation.maxSlotsBase + 1);
  assert.equal(allocation.launchesConfirmed, 1);
});
