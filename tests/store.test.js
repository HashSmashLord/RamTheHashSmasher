import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { loadConfig } from '../server/config.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { randomBytes } from 'node:crypto';
import { validateCreateRequest } from '../server/lib/launchpad.js';
import { imageIdFor } from '../server/lib/images.js';
import { makePng } from './helpers/png.js';

const budgetConfig = loadConfig({}).budget;

test('store with no RAMHERD_LLM_MODEL: six slots get the six roster models, in order, still mocked', async () => {
  const store = createStore({ budgetConfig, env: {} });
  assert.equal(store.llmProvider.kind, 'mock');
  store.slotManager.setSlotCount(6);
  const slots = store.slotManager.getSlots();
  assert.deepEqual(slots.map((s) => s.assignment.model), [
    'anthropic/claude-opus-5.5',
    'anthropic/claude-fable-5.1',
    'openai/gpt-6.1-sol-pro',
    'openai/gpt-6.1-sol-pro',
    'deepseek/deepseek-v4-pro',
    'qwen/qwen3.8-max-prime',
  ]);
  const after = await store.slotManager.advance(slots[3].id);
  assert.match(after.feed.at(-1).message, /\[mock\].*openai\/gpt-6\.1-sol-pro/);
});

test('store with RAMHERD_LLM_MODEL set: every slot uses the override, and it stays mock without the live gate', async () => {
  const store = createStore({ budgetConfig, env: { RAMHERD_LLM_MODEL: 'openrouter/forced', OPENROUTER_API_KEY: 'sk-fake' } });
  assert.equal(store.llmProvider.kind, 'mock');
  store.slotManager.setSlotCount(6);
  for (const s of store.slotManager.getSlots()) {
    assert.equal(s.assignment.model, 'openrouter/forced');
    assert.equal(s.assignment.modelSource, 'override');
  }
  const [first] = store.slotManager.getSlots();
  const after = await store.slotManager.advance(first.id);
  assert.match(after.feed.at(-1).message, /openrouter\/forced/);
});

test('a real LLM call\'s usage reaches costLedger, backend-only (never on the public slot)', async () => {
  const store = createStore({ budgetConfig, env: {} });
  store.slotManager.setSlotCount(1);
  const [slot] = store.slotManager.getSlots();
  const after = await store.slotManager.advance(slot.id); // idle -> thinking
  assert.equal(after.costUsd, undefined);
  assert.equal(store.costLedger.forSlot(slot.id).entries.length, 1);
});

test('an owned RAM\'s known compute cost also charges its own funding account', async () => {
  const store = createStore({ budgetConfig, env: {} });
  store.ramFunds.open('ram-9999', 'some-wallet');
  const owned = store.slotManager.createOwnedSlot({
    ramId: 'ram-9999', owner: 'some-wallet', track: 'sha256-r31-exploratory', approach: 'owner-pick', model: 'anthropic/claude-opus-5.5', brief: 'try something',
  });
  await store.slotManager.advance(owned.id); // mock mode: usage is zero/null, so nothing is charged
  assert.equal(store.ramFunds.get('ram-9999').totals.computeSpentUsd, 0);
  // Simulate a live call reporting a real known cost, same path a real OpenRouter response takes.
  store.costLedger.record({ slotId: owned.id, ramId: 'ram-9999', model: 'anthropic/claude-opus-5.5', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.015 } });
  assert.equal(store.ramFunds.get('ram-9999').totals.computeSpentUsd, 0.015);
});

test('a cost recorded against a RAM with no open funding account never throws', async () => {
  const store = createStore({ budgetConfig, env: {} });
  assert.doesNotThrow(() => {
    store.costLedger.record({ slotId: 'slot-x', ramId: 'ram-never-opened', model: 'm', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.01 } });
  });
});

// --- Roster ceiling growth from confirmed launchpad RAMs -----------------------------

const lpWallet = () => Keypair.generate().publicKey.toBase58();
const lpSig = () => bs58.encode(randomBytes(64));
// Every draft needs a token image the registry holds; uploaded per store by lpImage().
const LP_PNG = makePng({ note: 'store.test' });
function lpImage(store) {
  store.rams.uploadImage(LP_PNG); // no Pinata in tests: held synchronously
  return imageIdFor(LP_PNG);
}
function lpDraft(over = {}) {
  const v = validateCreateRequest({
    owner: lpWallet(),
    hashFamily: 'BLAKE3',
    track: 'blake3-r2-exploratory',
    approach: 'trail-search-heuristics',
    approachDetail: 'Try a new beam-search heuristic over 2-round BLAKE3 trails.',
    model: 'qwen/qwen3.8-max-prime',
    tokenName: 'Blake Breaker',
    tokenSymbol: 'BLKB',
    image: imageIdFor(LP_PNG),
    ...over,
  });
  assert.equal(v.ok, true);
  return v.value;
}
function launch(store) {
  const ram = store.rams.createDraft(lpDraft());
  store.rams.prepareLaunch(ram.id, lpWallet());
  return store.rams.confirmLaunch(ram.id, { signature: lpSig(), briefApproved: true });
}

test('each confirmed launchpad RAM raises the roster ceiling by one; drafts and cancels do not', () => {
  const store = createStore({ budgetConfig, env: {} });
  lpImage(store);
  assert.equal(budgetConfig.maxSlots, 12);
  assert.deepEqual(
    (({ maxSlots, maxSlotsBase, launchesConfirmed }) => ({ maxSlots, maxSlotsBase, launchesConfirmed }))(store.getAllocation()),
    { maxSlots: 12, maxSlotsBase: 12, launchesConfirmed: 0 },
  );
  const draft = store.rams.createDraft(lpDraft());
  store.rams.prepareLaunch(draft.id, lpWallet());
  assert.equal(store.getAllocation().maxSlots, 12); // awaiting signature raises nothing
  store.rams.cancel(draft.id);
  launch(store);
  launch(store);
  launch(store);
  const a = store.getAllocation();
  assert.equal(a.maxSlots, 15);
  assert.equal(a.maxSlotsBase, 12);
  assert.equal(a.launchesConfirmed, 3);
  assert.equal(budgetConfig.maxSlots, 12); // the shared config object is never mutated
  // Confirming an already-active RAM is refused, so it can't count twice.
  const one = store.rams.list().find((r) => r.status === 'active');
  assert.throws(() => store.rams.confirmLaunch(one.id, { signature: lpSig(), briefApproved: true }));
  assert.equal(store.getAllocation().maxSlots, 15);
});

test('ceiling growth is permanent: later cancels of other RAMs never lower it', () => {
  const store = createStore({ budgetConfig, env: {} });
  lpImage(store);
  launch(store);
  const pending = store.rams.createDraft(lpDraft());
  store.rams.prepareLaunch(pending.id, lpWallet());
  store.rams.cancel(pending.id);
  assert.equal(store.getAllocation().maxSlots, 13);
});

test('a grown ceiling raises only the roster\'s own cap: owned RAMs neither count toward nor consume it', async () => {
  const store = createStore({ budgetConfig, env: {} });
  lpImage(store);
  const owned = [launch(store), launch(store), launch(store)];
  // Fees for 6 roster seats: the roster reads 6 of 15, and the 3 owned slots sit outside it.
  store.feeSource.set(30);
  await store.ledger.refresh();
  const allocation = store.reallocateSlotsFromBudget();
  assert.equal(allocation.slotCount, 6);
  assert.equal(allocation.maxSlots, 15);
  const slots = store.slotManager.getSlots().filter((s) => s.active);
  assert.equal(slots.filter((s) => s.kind === 'roster').length, 6);
  assert.equal(slots.filter((s) => s.kind === 'owned').length, 3);
  for (const r of owned) assert.equal(store.slotManager.getSlot(r.slotId).active, true);

  // Plenty of fees: the roster fills to the grown ceiling (15), still not counting owned slots.
  store.feeSource.set(10_000);
  await store.ledger.refresh();
  store.reallocateSlotsFromBudget();
  const full = store.slotManager.getSlots().filter((s) => s.active);
  assert.equal(full.filter((s) => s.kind === 'roster').length, 15);
  assert.equal(full.filter((s) => s.kind === 'owned').length, 3);

  // Fees fall to zero: every roster seat retires, no owned slot does.
  store.feeSource.set(0);
  await store.ledger.refresh();
  store.reallocateSlotsFromBudget();
  const after = store.slotManager.getSlots().filter((s) => s.active);
  assert.equal(after.filter((s) => s.kind === 'roster').length, 0);
  assert.equal(after.filter((s) => s.kind === 'owned').length, 3);
  assert.equal(store.getAllocation().maxSlots, 15); // and the ceiling is still 15
});

test('getAllocation().computeSpentEpochUsd is real, off costLedger\'s own real entries -- $0 for a fresh store, never null or a guess', async () => {
  const store = createStore({ budgetConfig, env: {} });
  assert.equal(store.getAllocation().computeSpentEpochUsd, 0);
  store.costLedger.record({ slotId: 'slot-0', model: 'm', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.05 } });
  store.costLedger.record({ slotId: 'slot-1', model: 'm', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.07 } });
  assert.equal(store.getAllocation().computeSpentEpochUsd, 0.12);
});

test('totalZec() is null until a real ZEC price has actually been fetched -- never a guessed conversion, and absent entirely (no zecPriceSource) when the fee source is the default mock', async () => {
  const store = createStore({ budgetConfig, env: {} }); // RAMHERD_FEE_SOURCE unset -> mock fee source
  assert.equal(store.feeSource.kind, 'mock');
  assert.equal(store.totalZec(), null, 'no real price fetched yet (and never will be, for a mock source)');
  await store.refreshZecPrice(); // a no-op: pumpFee is off, so there is no zecPriceSource to call
  assert.equal(store.totalZec(), null);
});
