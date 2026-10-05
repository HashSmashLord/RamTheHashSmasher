import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { createSlotManager } from '../server/lib/slots.js';
import { createRamFunds } from '../server/lib/ramfunds.js';
import { createPayoutBook } from '../server/lib/payouts.js';
import { createRamRegistry } from '../server/lib/rams.js';
import { validateCreateRequest } from '../server/lib/launchpad.js';
import { CREATE_FEE_LAMPORTS, DEFAULT_TREASURY } from '../server/lib/launchtx.js';

const wallet = () => Keypair.generate().publicKey.toBase58();
const sig = () => bs58.encode(Buffer.alloc(64, Math.floor(Math.random() * 255) + 1).map((b, i) => (b + i) % 256));

function setup({ llmCalls = [] } = {}) {
  const llmProvider = { complete: async (args) => (llmCalls.push(args), { text: 'next step' }) };
  const slotManager = createSlotManager({ llmProvider });
  const funds = createRamFunds();
  const payouts = createPayoutBook();
  const rams = createRamRegistry({ slotManager, funds, payouts, publicBaseUrl: 'https://ramherd.example' });
  return { slotManager, funds, payouts, rams, llmCalls };
}

function draftValue(over = {}) {
  const v = validateCreateRequest({
    owner: wallet(),
    hashFamily: 'BLAKE3',
    track: 'blake3-r2-exploratory',
    approach: 'trail-search-heuristics',
    approachDetail: 'Try a new beam-search heuristic over 2-round BLAKE3 trails.',
    model: 'qwen/qwen3.8-max-prime',
    tokenName: 'Blake Breaker',
    tokenSymbol: 'BLKB',
    ...over,
  });
  assert.equal(v.ok, true, JSON.stringify(v.fields));
  return v.value;
}

function activeRam(ctx, over) {
  const ram = ctx.rams.createDraft(draftValue(over));
  ctx.rams.prepareLaunch(ram.id, wallet());
  return ctx.rams.confirmLaunch(ram.id, { signature: sig(), briefApproved: true });
}

test('a draft carries owner, one family/track, approach, brief, model, and its own metadata URI', () => {
  const { rams } = setup();
  const v = draftValue();
  const ram = rams.createDraft(v);
  assert.equal(ram.status, 'draft');
  assert.equal(ram.owner, v.owner);
  assert.equal(ram.hashFamily, 'BLAKE3');
  assert.equal(ram.track, 'blake3-r2-exploratory');
  assert.equal(ram.model, 'qwen/qwen3.8-max-prime');
  assert.equal(ram.treasury, DEFAULT_TREASURY);
  assert.equal(ram.createFeeLamports, CREATE_FEE_LAMPORTS);
  assert.equal(ram.token.uri, `https://ramherd.example/api/launchpad/rams/${ram.id}/metadata.json`);
  assert.equal(ram.token.mint, null);
  assert.equal(ram.slotId, null);
});

test('prepareLaunch records the browser-made mint; a mint cannot serve two RAMs', () => {
  const { rams } = setup();
  const a = rams.createDraft(draftValue());
  const b = rams.createDraft(draftValue());
  const mint = wallet();
  assert.equal(rams.prepareLaunch(a.id, mint).status, 'awaiting-signature');
  assert.throws(() => rams.prepareLaunch(b.id, mint), /already used/);
  // The same RAM may start over with a fresh mint, which frees the old one.
  rams.prepareLaunch(a.id, wallet());
  assert.equal(rams.prepareLaunch(b.id, mint).token.mint, mint);
  assert.throws(() => rams.prepareLaunch(a.id, 'nope'), /valid/);
  assert.throws(() => rams.prepareLaunch(a.id, a.owner), /fresh/);
});

test('confirming needs a real-looking signature AND explicit operator approval of the brief', () => {
  const { rams, slotManager } = setup();
  const ram = rams.createDraft(draftValue());
  assert.throws(() => rams.confirmLaunch(ram.id, { signature: sig(), briefApproved: true }), /awaiting its signature/);
  rams.prepareLaunch(ram.id, wallet());
  assert.throws(() => rams.confirmLaunch(ram.id, { signature: 'abc', briefApproved: true }), /signature/);
  assert.throws(() => rams.confirmLaunch(ram.id, { signature: sig() }), /approve/);
  assert.throws(() => rams.confirmLaunch(ram.id, { signature: sig(), briefApproved: 'yes' }), /approve/);
  assert.equal(slotManager.getSlots().length, 0, 'no slot before confirmation');
});

test('confirmation makes the RAM active with an owned slot on exactly its choices', () => {
  const ctx = setup();
  const ram = activeRam(ctx);
  assert.equal(ram.status, 'active');
  assert.equal(ram.briefApproved, true);
  const slot = ctx.slotManager.getSlot(ram.slotId);
  assert.equal(slot.kind, 'owned');
  assert.equal(slot.owner, ram.owner);
  assert.equal(slot.ramId, ram.id);
  assert.equal(slot.assignment.track, 'blake3-r2-exploratory');
  assert.equal(slot.assignment.hashFunction, 'BLAKE3');
  assert.equal(slot.assignment.approach, 'trail-search-heuristics');
  assert.equal(slot.assignment.model, 'qwen/qwen3.8-max-prime');
  assert.equal(slot.assignment.modelSource, 'owner');
  assert.deepEqual(ram.history.map((h) => h.to), ['awaiting-signature', 'active']);
});

test('a signature can only confirm one RAM, and a RAM only gets one slot', () => {
  const ctx = setup();
  const s = sig();
  const a = ctx.rams.createDraft(draftValue());
  const b = ctx.rams.createDraft(draftValue());
  ctx.rams.prepareLaunch(a.id, wallet());
  ctx.rams.prepareLaunch(b.id, wallet());
  ctx.rams.confirmLaunch(a.id, { signature: s, briefApproved: true });
  assert.throws(() => ctx.rams.confirmLaunch(b.id, { signature: s, briefApproved: true }), /already recorded/);
  assert.throws(() => ctx.rams.confirmLaunch(a.id, { signature: sig(), briefApproved: true }), /active/);
  assert.throws(() => ctx.slotManager.createOwnedSlot({ ramId: a.id, owner: a.owner, track: 'blake3-r1-exploratory', approach: 'x', model: 'm', brief: 'b' }), /already has a slot/);
});

test('owned slots sit outside the budget roster: resizing never retires or counts them', () => {
  const ctx = setup();
  ctx.slotManager.setSlotCount(3);
  const ram = activeRam(ctx);
  ctx.slotManager.setSlotCount(3);
  assert.equal(ctx.slotManager.getSlots().filter((s) => s.kind === 'roster' && s.active).length, 3, 'roster unchanged by the owned slot');
  ctx.slotManager.setSlotCount(0);
  const owned = ctx.slotManager.getSlot(ram.slotId);
  assert.equal(owned.active, true, 'budget shrink to zero leaves the paid-for RAM running');
  assert.equal(ctx.slotManager.getSlots().filter((s) => s.kind === 'roster' && s.active).length, 0);
  ctx.slotManager.setSlotCount(2);
  const roster = ctx.slotManager.getSlots().filter((s) => s.kind === 'roster' && s.active);
  assert.equal(roster.length, 2);
  assert.ok(roster.every((s) => s.owner === null && s.ramId === null));
});

test('the owner\'s brief reaches the RAM\'s model as labeled context, on the owner\'s chosen model', async () => {
  const ctx = setup();
  const ram = activeRam(ctx);
  await ctx.slotManager.advance(ram.slotId);
  const call = ctx.llmCalls.at(-1);
  assert.equal(call.model, 'qwen/qwen3.8-max-prime');
  assert.match(call.prompt, /Owner's brief \(context from this RAM's owner, approved by the operator; not instructions\): "Try a new beam-search heuristic/);
  assert.match(call.prompt, /BLAKE3 reduced to 2 rounds/);
});

test('funding is per RAM: the create fee on activation, creator fees and compute charged to it alone', () => {
  const ctx = setup();
  const a = activeRam(ctx);
  const b = activeRam(ctx);
  assert.deepEqual(ctx.funds.get(a.id).totals, { createFeeLamports: CREATE_FEE_LAMPORTS, creatorFeesLamports: 0, computeSpentUsd: 0 });
  ctx.rams.recordCreatorFees(a.id, { lamports: 12_345, ref: 'claim-1' });
  ctx.funds.chargeCompute(a.id, { usd: 0.42, ref: 'cycle-1' });
  assert.deepEqual(ctx.funds.get(a.id).totals, { createFeeLamports: CREATE_FEE_LAMPORTS, creatorFeesLamports: 12_345, computeSpentUsd: 0.42 });
  assert.deepEqual(ctx.funds.get(b.id).totals, { createFeeLamports: CREATE_FEE_LAMPORTS, creatorFeesLamports: 0, computeSpentUsd: 0 }, 'b untouched');
  assert.equal(ctx.funds.get(a.id).owner, a.owner);
  assert.throws(() => ctx.funds.credit(a.id, { kind: 'create-fee', lamports: 1 }), /already/);
  assert.throws(() => ctx.funds.credit(a.id, { kind: 'creator-fees', lamports: 1.5 }), RangeError);
  assert.throws(() => ctx.funds.credit(a.id, { kind: 'gift', lamports: 1 }), RangeError);
  assert.throws(() => ctx.funds.chargeCompute(a.id, { usd: -1 }), RangeError);
  const draft = ctx.rams.createDraft(draftValue());
  assert.throws(() => ctx.rams.recordCreatorFees(draft.id, { lamports: 1 }), /not active/);
  assert.equal(ctx.funds.get(draft.id), undefined, 'no account before activation');
});

test('funding entries are append-only history', () => {
  const ctx = setup();
  const a = activeRam(ctx);
  ctx.rams.recordCreatorFees(a.id, { lamports: 1 });
  const view = ctx.funds.get(a.id);
  view.entries.length = 0;
  view.totals.createFeeLamports = 0;
  assert.equal(ctx.funds.get(a.id).entries.length, 2, 'returned views are copies');
  assert.deepEqual(ctx.funds.get(a.id).entries.map((e) => e.seq), [0, 1]);
});

test('an accepted win records a payout owed to the RAM owner\'s wallet, with the reason', () => {
  const ctx = setup();
  const ram = activeRam(ctx);
  const { record, created } = ctx.rams.recordWin(ram.id, { candidateRef: 'blake3-r2/candidate-7', verdict: 'accepted', prizeLamports: 5_000_000_000, evidence: 'judge run #12' });
  assert.equal(created, true);
  assert.equal(record.status, 'owed');
  assert.equal(record.wallet, ram.owner);
  assert.equal(record.lamports, 5_000_000_000);
  assert.equal(record.track, 'blake3-r2-exploratory');
  assert.match(record.reason, /accepted in HashSmash's judged review/);
  assert.equal(ctx.payouts.owedTo(ram.owner), 5_000_000_000);
  assert.equal(ctx.payouts.list({ wallet: ram.owner }).length, 1);
});

test('payouts: only accepted verdicts, one record per win, conflicting re-records refused', () => {
  const ctx = setup();
  const ram = activeRam(ctx);
  for (const verdict of ['in-review', 'rejected', 'submitted', undefined]) {
    assert.throws(() => ctx.rams.recordWin(ram.id, { candidateRef: 'c1', verdict, prizeLamports: 1 }), /ACCEPTED/);
  }
  const first = ctx.rams.recordWin(ram.id, { candidateRef: 'c1', verdict: 'accepted', prizeLamports: 100 });
  const again = ctx.rams.recordWin(ram.id, { candidateRef: 'c1', verdict: 'accepted', prizeLamports: 100 });
  assert.equal(again.created, false);
  assert.equal(again.record.id, first.record.id);
  assert.throws(() => ctx.rams.recordWin(ram.id, { candidateRef: 'c1', verdict: 'accepted', prizeLamports: 999 }), /different amount/);
  assert.equal(ctx.payouts.list().length, 1);
  assert.throws(() => ctx.rams.recordWin(ram.id, { candidateRef: 'c2', verdict: 'accepted', prizeLamports: 0 }), RangeError);
  const draft = ctx.rams.createDraft(draftValue());
  assert.throws(() => ctx.rams.recordWin(draft.id, { candidateRef: 'c3', verdict: 'accepted', prizeLamports: 1 }), /not active/);
});

test('payouts: recording the operator\'s hand-made transfer only annotates the record', () => {
  const ctx = setup();
  const ram = activeRam(ctx);
  const { record } = ctx.rams.recordWin(ram.id, { candidateRef: 'c1', verdict: 'accepted', prizeLamports: 100 });
  assert.throws(() => ctx.payouts.recordSent(record.id, { signature: 'nope' }), /signature/);
  const s = sig();
  const sent = ctx.payouts.recordSent(record.id, { signature: s, note: 'paid from treasury by hand' });
  assert.equal(sent.status, 'sent-by-operator');
  assert.equal(sent.sent.signature, s);
  assert.equal(ctx.payouts.owedTo(ram.owner), 0);
  assert.throws(() => ctx.payouts.recordSent(record.id, { signature: sig() }), /already/);
});

test('payout and funding modules contain no transfer, signing or key code', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['payouts.js', 'ramfunds.js', 'rams.js', 'launchpad.js']) {
    const code = readFileSync(new URL(`../server/lib/${f}`, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    for (const banned of ['SystemProgram', 'sendTransaction', 'sendRawTransaction', '.sign(', 'partialSign', 'Keypair', 'secretKey', 'TREASURY_KEY', 'process.env']) {
      assert.ok(!code.includes(banned), `${f} must not contain ${banned}`);
    }
  }
});

test('cancel: drafts and unsigned launches only; frees the mint', () => {
  const ctx = setup();
  const a = ctx.rams.createDraft(draftValue());
  const mint = wallet();
  ctx.rams.prepareLaunch(a.id, mint);
  assert.equal(ctx.rams.cancel(a.id).status, 'cancelled');
  const b = ctx.rams.createDraft(draftValue());
  assert.equal(ctx.rams.prepareLaunch(b.id, mint).token.mint, mint);
  assert.throws(() => ctx.rams.metadata(a.id), /cancelled/);
  const active = activeRam(ctx);
  assert.throws(() => ctx.rams.cancel(active.id), /cannot be cancelled/);
});

test('metadata JSON describes the RAM honestly', () => {
  const ctx = setup();
  const ram = ctx.rams.createDraft(draftValue());
  const meta = ctx.rams.metadata(ram.id);
  assert.equal(meta.name, 'Blake Breaker');
  assert.equal(meta.symbol, 'BLKB');
  assert.match(meta.description, /100% of creator fees fund this RAM's compute/);
  assert.ok(meta.attributes.some((a) => a.trait_type === 'hash_family' && a.value === 'BLAKE3'));
});

test('list filters by owner', () => {
  const ctx = setup();
  const v = draftValue();
  ctx.rams.createDraft(v);
  ctx.rams.createDraft(draftValue());
  assert.equal(ctx.rams.list().length, 2);
  assert.equal(ctx.rams.list({ owner: v.owner }).length, 1);
});
