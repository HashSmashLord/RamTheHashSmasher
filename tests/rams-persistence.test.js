// Persistence for the launchpad's RAM registry (server/lib/rams.js's `rams`
// Map, written through server/lib/persist.js). See rams.js's module header
// for exactly what is and isn't persisted, and why.
//
// Four things this file proves:
//   1. A record written by one registry instance is read back correctly by
//      a fresh instance pointed at the same file ("restart").
//   2. A missing or corrupt file never throws; the registry just starts empty.
//   3. The write is atomic: no reader ever sees a partial file.
//   4. The full create -> confirm -> (simulated restart) -> still-visible
//      path works end to end through the real HTTP API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { randomBytes } from 'node:crypto';
import { readJsonFile, writeJsonFileAtomic } from '../server/lib/persist.js';
import { createRamRegistry } from '../server/lib/rams.js';
import { createSlotManager } from '../server/lib/slots.js';
import { createRamFunds } from '../server/lib/ramfunds.js';
import { createPayoutBook } from '../server/lib/payouts.js';
import { validateCreateRequest } from '../server/lib/launchpad.js';
import { imageIdFor } from '../server/lib/images.js';
import { makePng } from './helpers/png.js';
import { startApp } from './helpers/harness.js';
import { loadConfig } from '../server/config.js';
import { launchLookupTableAddresses, lookupTableAccount } from '../server/lib/launchtx.js';

function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ramherd-persist-test-'));
  return dir;
}

const wallet = () => Keypair.generate().publicKey.toBase58();
const sig = () => bs58.encode(randomBytes(64));
const TEST_PNG = makePng({ note: 'rams-persistence.test' });
const TEST_IMAGE_ID = imageIdFor(TEST_PNG);

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
    image: TEST_IMAGE_ID,
    ...over,
  });
  assert.equal(v.ok, true, JSON.stringify(v.fields));
  return v.value;
}

/** createRamRegistry + a fresh slotManager/funds/payouts, wired the same way store.js does. */
function freshRegistry({ persistPath, log = () => {} }) {
  const llmProvider = { complete: async () => ({ text: 'next step' }) };
  const slotManager = createSlotManager({ llmProvider });
  const funds = createRamFunds();
  const payouts = createPayoutBook();
  const rams = createRamRegistry({ slotManager, funds, payouts, publicBaseUrl: 'https://ramherd.example', persistPath, log });
  rams.imageReady = rams.uploadImage(TEST_PNG);
  return { slotManager, funds, payouts, rams };
}

async function launchedRam(reg) {
  await reg.rams.imageReady;
  const draft = reg.rams.createDraft(draftValue());
  reg.rams.prepareLaunch(draft.id, wallet());
  return reg.rams.confirmLaunch(draft.id, { signature: sig(), briefApproved: true });
}

// --- 1. write, "restart" (fresh instance, same file), read back correctly ---

test('a confirmed RAM survives a simulated restart: a fresh registry on the same file sees it, active, with its launch signature', async () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'rams.json');
    const first = freshRegistry({ persistPath: path });
    const active = await launchedRam(first);
    assert.equal(active.status, 'active');
    assert.ok(existsSync(path), 'the file was written on confirmLaunch');

    const second = freshRegistry({ persistPath: path });
    const rehydrated = second.rams.get(active.id);
    assert.ok(rehydrated, 'the record is there after "restart"');
    assert.equal(rehydrated.status, 'active');
    assert.equal(rehydrated.launchSignature, active.launchSignature);
    assert.equal(rehydrated.owner, active.owner);
    assert.equal(rehydrated.token.name, active.token.name);
    assert.deepEqual(rehydrated.history, active.history);

    // Honest about what did NOT survive (see rams.js header): slots are pure
    // runtime state, so a FRESH owned slot was created on this second,
    // separate slotManager instance -- not the retired one from `first`
    // (which no longer exists at all; `first.slotManager` is a different
    // object with its own empty slots Map, proven below by its fresh feed).
    const slot = second.slotManager.getSlot(rehydrated.slotId);
    assert.ok(slot, 'the rehydrated RAM has a real, live slot again');
    assert.equal(slot.kind, 'owned');
    assert.equal(slot.status, 'idle');
    assert.equal(slot.sandbox, null, 'no sandbox is running until the operator starts one');
    assert.equal(slot.feed.length, 1, 'fresh slot, only its own "activated" line');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a draft and a cancelled RAM also survive a restart, with no slot to recreate (never had one)', async () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'rams.json');
    const first = freshRegistry({ persistPath: path });
    await first.rams.imageReady;
    const draft = first.rams.createDraft(draftValue());
    const cancelled = first.rams.cancel(first.rams.createDraft(draftValue()).id);

    const second = freshRegistry({ persistPath: path });
    assert.equal(second.rams.get(draft.id).status, 'draft');
    assert.equal(second.rams.get(cancelled.id).status, 'cancelled');
    assert.equal(second.rams.get(draft.id).slotId, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mint reservations and the id counter also survive a restart: no id collision, no mint reuse', async () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'rams.json');
    const first = freshRegistry({ persistPath: path });
    await first.rams.imageReady;
    const draft = first.rams.createDraft(draftValue());
    const mint = wallet();
    const prepared = first.rams.prepareLaunch(draft.id, mint);
    assert.equal(prepared.token.mint, mint);

    const second = freshRegistry({ persistPath: path });
    // The same mint is still reserved: preparing a different RAM with it is refused.
    const otherDraft = second.rams.createDraft(draftValue());
    assert.throws(() => second.rams.prepareLaunch(otherDraft.id, mint), /already used/);
    // The id sequence continued rather than restarting at ram-0001 (which would collide).
    assert.notEqual(otherDraft.id, draft.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 2. missing / corrupt file handling -------------------------------------

test('no file yet (first boot, or local dev with no data dir): the registry starts empty, never throws', () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'rams.json'); // deliberately never written
    assert.doesNotThrow(() => {
      const reg = freshRegistry({ persistPath: path });
      assert.equal(reg.rams.list().length, 0);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt file logs loudly and the registry starts empty rather than crashing', () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'rams.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, '{not valid json!!');
    const logs = [];
    let reg;
    assert.doesNotThrow(() => { reg = freshRegistry({ persistPath: path, log: (l) => logs.push(l) }); });
    assert.equal(reg.rams.list().length, 0);
    assert.ok(logs.some((l) => /could not be read as JSON/.test(l)), 'the corruption was logged loudly');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a well-formed JSON file with the wrong shape also starts empty, logged, never thrown', () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'rams.json');
    writeJsonFileAtomic(path, { not: 'the expected shape' });
    const logs = [];
    const reg = freshRegistry({ persistPath: path, log: (l) => logs.push(l) });
    assert.equal(reg.rams.list().length, 0);
    assert.ok(logs.some((l) => /did not have the expected shape/.test(l)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readJsonFile: undefined for a missing file (not an error), undefined + logged for unreadable JSON', () => {
  const dir = tmpDir();
  try {
    const missing = join(dir, 'nope.json');
    assert.equal(readJsonFile(missing), undefined);

    const corrupt = join(dir, 'bad.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(corrupt, '{{{');
    const logs = [];
    assert.equal(readJsonFile(corrupt, { log: (l) => logs.push(l) }), undefined);
    assert.equal(logs.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 3. atomic write: no partial file is ever visible ----------------------

test('writeJsonFileAtomic: the file always round-trips exactly, and never leaves a .tmp file behind', () => {
  const dir = tmpDir();
  try {
    const path = join(dir, 'rams.json');
    const big = { version: 1, seq: 42, rams: Array.from({ length: 200 }, (_, i) => ({ id: `ram-${i}`, note: 'x'.repeat(500) })), mintsInUse: [] };
    writeJsonFileAtomic(path, big);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), big);
    // Several writes in a row: each is a fresh temp file renamed into place,
    // so the directory settles back to exactly one file every time -- a
    // concurrent reader between any two writes would see one complete file
    // (the previous or the new one), never a half-written one, because
    // rename() is atomic and nothing here ever writes `path` directly.
    for (let i = 0; i < 5; i++) writeJsonFileAtomic(path, { version: 1, seq: i, rams: [], mintsInUse: [] });
    const entries = readdirSync(dir);
    assert.deepEqual(entries, ['rams.json'], 'no leftover .tmp file');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1, seq: 4, rams: [], mintsInUse: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeJsonFileAtomic creates the data directory itself if it does not exist yet', () => {
  const dir = tmpDir();
  try {
    const nested = join(dir, 'does', 'not', 'exist', 'yet');
    const path = join(nested, 'rams.json');
    assert.equal(existsSync(nested), false);
    writeJsonFileAtomic(path, { ok: true });
    assert.equal(existsSync(path), true);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeJsonFileAtomic never throws even when the path is unwritable, and the caller keeps running', () => {
  const logs = [];
  // A path through a file (not a directory) as if it were a directory can never be created.
  const dir = tmpDir();
  try {
    const blocker = join(dir, 'blocker');
    writeJsonFileAtomic(blocker, { x: 1 });
    const impossible = join(blocker, 'nested', 'rams.json'); // blocker is a file, not a dir
    assert.doesNotThrow(() => writeJsonFileAtomic(impossible, { x: 2 }, { log: (l) => logs.push(l) }));
    assert.ok(logs.some((l) => /failed to write/.test(l)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 4. the full real path: create -> confirm -> restart -> still visible via the API ---

test('create -> confirm -> simulated restart -> still visible on GET /api/launchpad/rams (Discover\'s data source)', async (t) => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, RAMHERD_DATA_DIR: dir };

  const addrs = await launchLookupTableAddresses();
  const TABLE = wallet();
  const solana = {
    async getLatestBlockhash() { return wallet(); },
    async getLookupTable(address) { return lookupTableAccount(address, addrs); },
    async getTransaction() { return null; },
  };
  const base = loadConfig({});

  const first = await startApp({ env, launchpad: { ...base.launchpad, lookupTable: TABLE, liveRequested: false, publicBaseUrl: 'https://ramherd.example' }, solanaClient: solana, launchpadRateLimit: { max: 1000, windowMs: 60_000 } });
  await first.store.rams.uploadImage(TEST_PNG);
  const createRes = await first.postJson('/api/launchpad/rams', {
    owner: wallet(), hashFamily: 'SHA3-256', track: 'sha3-256-r6-exploratory', approach: 'literature-replication',
    approachDetail: 'Adapt the known 6-round Keccak collision attack to the exploratory cost model.',
    model: 'z-ai/glm-5.3-prime', tokenName: 'Keccak Knocker', tokenSymbol: 'KECK', image: TEST_IMAGE_ID,
  });
  assert.equal(createRes.status, 201);
  const ram = (await createRes.json()).ram;
  await first.postJson(`/api/launchpad/rams/${ram.id}/transaction`, { mint: wallet() });
  const confirmRes = await first.postJson(`/api/admin/launchpad/rams/${ram.id}/confirm`, { signature: sig(), briefApproved: true }, { headers: first.adminHeaders() });
  assert.equal(confirmRes.status, 200);
  const active = (await confirmRes.json()).ram;
  assert.equal(active.status, 'active');
  await first.stop();

  // "Restart": a brand new app instance, same RAMHERD_DATA_DIR, nothing carried over in memory.
  const second = await startApp({ env, launchpad: { ...base.launchpad, publicBaseUrl: 'https://ramherd.example' } });
  t.after(() => second.stop());
  const list = await (await second.get('/api/launchpad/rams')).json();
  const found = list.rams.find((r) => r.id === ram.id);
  assert.ok(found, 'the launched RAM is still in the Discover listing after a restart');
  assert.equal(found.status, 'active');
  assert.equal(found.launchSignature, active.launchSignature);
  assert.ok(found.slotId, 'it has a real (freshly recreated) slot id');

  const slotRes = await second.get(`/api/slots/${encodeURIComponent(found.slotId)}`);
  assert.equal(slotRes.status, 200, 'that slot really exists, not a stale 404 id');
  const { slot } = await slotRes.json();
  assert.equal(slot.kind, 'owned');
  assert.equal(slot.sandbox, null, 'honest: no desk is running yet, this process never started one');
});
