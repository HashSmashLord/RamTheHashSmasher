// Auto-seed on boot (server/lib/autoseed.js). FAKE E2B SDK only: no real
// sandbox is created by the suite. The real-E2B proof was run by hand with
// `RAMHERD_AUTO_SEED=true RAMHERD_SANDBOX=e2b npm start`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { autoSeedPolicy, feeForSlots, seedRosterFunding, startRosterSandboxes } from '../server/lib/autoseed.js';
import { computeAllocation } from '../server/lib/budget.js';
import { ACTIVE_TRACKS } from '../server/lib/targets.js';
import { createStore } from '../server/store.js';
import { loadConfig } from '../server/config.js';

const FAKE_KEY = 'e2b_fakekeyfortests0123456789';
const SANDBOX_ENV = { RAMHERD_SANDBOX: 'e2b', E2B_API_KEY: FAKE_KEY, RAMHERD_SANDBOX_RECONCILE_SEC: '0' };

/** Minimal @e2b/desktop stand-in. `failFor` = slot ids whose create fails. */
function fakeSdk({ failFor = [] } = {}) {
  const calls = { create: [], kill: [] };
  let seq = 0;
  class Sandbox {
    constructor(id) {
      this.sandboxId = id;
      this.display = ':0';
      this.x11vnc = [];
      this.commands = {
        run: async (cmd) => {
          if (cmd.startsWith('x11vnc -bg')) this.x11vnc.push(cmd);
          if (cmd.startsWith('ps -C x11vnc')) return { exitCode: 0, stdout: this.x11vnc.join('\n') + '\n', stderr: '' };
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      };
    }
    getHost(port) { return `${port}-${this.sandboxId}.e2b.app`; }
    async kill() { calls.kill.push(this.sandboxId); return true; }
    static async getInfo(id) { return { sandboxId: id, state: 'running' }; }
    static async create(template, opts) {
      calls.create.push(opts.metadata.slotId);
      if (failFor.includes(opts.metadata.slotId)) throw new Error('429 rate limited');
      return new Sandbox(`sbx${++seq}`);
    }
    static async kill() { return true; }
  }
  return { calls, loadSdk: async () => ({ Sandbox }) };
}

function storeWith({ env = {}, sdk = null, budget = {} } = {}) {
  const budgetConfig = { ...loadConfig({}).budget, ...budget };
  const store = createStore({ budgetConfig, env, ...(sdk ? { loadSandboxSdk: sdk.loadSdk } : {}) });
  return { store, budgetConfig };
}

async function cleanup(store) {
  if (!store.sandboxManager) return;
  for (const s of store.slotManager.getSlots()) {
    await store.slotManager.waitForSandboxTask(s.id);
    await store.slotManager.waitForSandboxContext(s.id);
  }
  await store.sandboxManager.stopAll();
}

// ---- opt-in gate ----

test('autoSeedPolicy is off unless RAMHERD_AUTO_SEED is exactly "true"', () => {
  assert.equal(autoSeedPolicy({}).enabled, false);
  assert.equal(autoSeedPolicy({ RAMHERD_AUTO_SEED: '1' }).enabled, false);
  assert.equal(autoSeedPolicy({ RAMHERD_AUTO_SEED: 'TRUE' }).enabled, false);
  assert.equal(autoSeedPolicy({ RAMHERD_AUTO_SEED: 'true' }).enabled, true);
});

// ---- budget math ----

test('feeForSlots: the smallest whole-cent fee that funds the roster, for default and odd configs', () => {
  const def = loadConfig({}).budget; // $5/slot, fraction 1, max 12
  assert.deepEqual(feeForSlots(6, def), { feeUsd: 30, targetSlots: 6 });
  for (const cfg of [
    { ...def, usdPerSlot: 5, allocationFraction: 0.3 },
    { ...def, usdPerSlot: 0.7, allocationFraction: 0.7 },
    { ...def, usdPerSlot: 3.33, allocationFraction: 0.9 },
    { ...def, usdPerSlot: 0.01, allocationFraction: 1 },
  ]) {
    const { feeUsd, targetSlots } = feeForSlots(6, cfg);
    assert.equal(targetSlots, 6);
    assert.equal(computeAllocation(feeUsd, cfg).slotCount, 6, `fee ${feeUsd} funds 6 under ${JSON.stringify(cfg)}`);
    assert.ok(computeAllocation(feeUsd - 0.01, cfg).slotCount < 6, `fee ${feeUsd} is the minimum`);
  }
});

test('feeForSlots: capped by maxSlots, free when minSlots already covers it, null when fraction is 0', () => {
  const def = loadConfig({}).budget;
  assert.deepEqual(feeForSlots(6, { ...def, maxSlots: 4 }), { feeUsd: 20, targetSlots: 4 });
  assert.deepEqual(feeForSlots(6, { ...def, minSlots: 6 }), { feeUsd: 0, targetSlots: 6 });
  assert.equal(feeForSlots(6, { ...def, allocationFraction: 0 }), null);
});

// ---- funding + slot count ----

test('seedRosterFunding funds exactly ACTIVE_TRACKS.length roster slots via the same feeSource.set + reallocate', async () => {
  const { store, budgetConfig } = storeWith();
  const logs = [];
  const r = await seedRosterFunding(store, { budgetConfig, log: (l) => logs.push(l) });
  assert.equal(r.ok, true);
  assert.equal(r.allocation.slotCount, ACTIVE_TRACKS.length);
  assert.equal(store.ledger.getSnapshot().totalUsd, ACTIVE_TRACKS.length * budgetConfig.usdPerSlot);
  assert.equal(store.getAllocation().slotCount, ACTIVE_TRACKS.length);
  const roster = store.slotManager.getSlots().filter((s) => s.kind === 'roster' && s.active);
  assert.equal(roster.length, ACTIVE_TRACKS.length);
  assert.deepEqual(roster.map((s) => s.assignment.track), ACTIVE_TRACKS.map((t) => t.track), 'RAM 1..n = the n tracks');
  assert.match(store.feeSource.getHistory().at(-1).note, /auto-seed on boot/);
  assert.ok(logs.some((l) => /6 roster slot\(s\) active/.test(l)));
});

test('seedRosterFunding never lowers a fee total that is already higher, and is idempotent', async () => {
  const { store, budgetConfig } = storeWith();
  store.feeSource.set(100);
  await seedRosterFunding(store, { budgetConfig });
  assert.equal(store.ledger.getSnapshot().totalUsd, 100);
  assert.equal(store.slotManager.getActiveCount(), Math.min(20, budgetConfig.maxSlots));
  const again = await seedRosterFunding(store, { budgetConfig });
  assert.equal(again.ok, true);
  assert.equal(store.feeSource.getHistory().length, 1, 'no second set');
});

test('seedRosterFunding leaves owned (launchpad) slots alone', async () => {
  const { store, budgetConfig } = storeWith();
  const owned = store.slotManager.createOwnedSlot({ ramId: 'ram-x', owner: 'Wallet1111', track: 'blake3-r1-exploratory', approach: 'mine', model: 'm', brief: 'b' });
  await seedRosterFunding(store, { budgetConfig });
  const slots = store.slotManager.getSlots();
  assert.equal(slots.filter((s) => s.kind === 'roster' && s.active).length, ACTIVE_TRACKS.length);
  const after = slots.find((s) => s.id === owned.id);
  assert.equal(after.active, true);
  assert.equal(after.assignment.approach, 'mine');
});

test('seedRosterFunding never throws: a non-mock fee source or zero fraction is logged and skipped', async () => {
  const { store, budgetConfig } = storeWith();
  const logs = [];
  const zero = await seedRosterFunding(store, { budgetConfig: { ...budgetConfig, allocationFraction: 0 }, log: (l) => logs.push(l) });
  assert.equal(zero.ok, false);
  assert.equal(store.slotManager.getActiveCount(), 0);
  const realish = { ...store, feeSource: { ...store.feeSource, kind: 'onchain' } };
  const skipped = await seedRosterFunding(realish, { budgetConfig, log: (l) => logs.push(l) });
  assert.equal(skipped.ok, false);
  const broken = { ...store, ledger: { refresh: async () => { throw new Error('boom'); } } };
  const failed = await seedRosterFunding(broken, { budgetConfig, log: (l) => logs.push(l) });
  assert.equal(failed.ok, false);
  assert.equal(logs.length, 3);
});

// ---- sandboxes ----

test('startRosterSandboxes does nothing (and loads no SDK) when sandboxes are off', async () => {
  const { store, budgetConfig } = storeWith({ env: { E2B_API_KEY: FAKE_KEY } });
  await seedRosterFunding(store, { budgetConfig });
  const r = await startRosterSandboxes(store);
  assert.deepEqual(r.results, []);
  assert.match(r.skipped, /off/);
  assert.ok(store.slotManager.getSlots().every((s) => s.sandbox === null));
});

test('startRosterSandboxes starts one sandbox per active roster AND active owned slot, never for retired ones', async () => {
  const sdk = fakeSdk();
  const { store, budgetConfig } = storeWith({ env: SANDBOX_ENV, sdk });
  store.slotManager.setSlotCount(8);
  store.slotManager.setSlotCount(0); // 8 retired roster slots stay in the list
  const owned = store.slotManager.createOwnedSlot({ ramId: 'ram-x', owner: 'Wallet1111', track: 'blake3-r1-exploratory', approach: 'mine', model: 'm', brief: 'b' });
  const seeded = await seedRosterFunding(store, { budgetConfig });
  const r = await startRosterSandboxes(store);
  assert.equal(r.results.length, ACTIVE_TRACKS.length + 1); // roster + the one owned slot
  assert.ok(r.results.every((x) => x.ok));
  const expectedIds = [...seeded.rosterSlotIds, owned.id].sort();
  assert.deepEqual(sdk.calls.create.sort(), expectedIds);
  for (const id of seeded.rosterSlotIds) assert.equal(store.slotManager.getSlot(id).sandbox.status, 'running');
  assert.equal(store.slotManager.getSlot(owned.id).sandbox.status, 'running');
  assert.ok(r.results.find((x) => x.slotId === owned.id).kind === 'owned');
  // a second run starts nothing new (all already running)
  const again = await startRosterSandboxes(store);
  assert.equal(again.results.length, 0);
  assert.equal(sdk.calls.create.length, ACTIVE_TRACKS.length + 1);
  await cleanup(store);
});

test('startRosterSandboxes starts an owned slot even when roster funding was never on (index.js no longer gates it on seeded.ok)', async () => {
  const sdk = fakeSdk();
  const { store } = storeWith({ env: SANDBOX_ENV, sdk });
  // No seedRosterFunding call at all -- the roster is unfunded/empty.
  const owned = store.slotManager.createOwnedSlot({ ramId: 'ram-y', owner: 'Wallet2222', track: 'sha256-r32-exploratory', approach: 'mine', model: 'm', brief: 'b' });
  const r = await startRosterSandboxes(store);
  assert.deepEqual(r.results, [{ slotId: owned.id, kind: 'owned', ok: true, sessionId: sdk.calls.create.includes(owned.id) ? store.slotManager.getSlot(owned.id).sandbox.sessionId : undefined }]);
  assert.equal(store.slotManager.getSlot(owned.id).sandbox.status, 'running');
  await cleanup(store);
});

test('startRosterSandboxes: one failed start is logged + on that slot\'s feed; the rest still start; never rejects', async () => {
  const sdk = fakeSdk({ failFor: ['slot-2'] });
  const { store, budgetConfig } = storeWith({ env: SANDBOX_ENV, sdk });
  await seedRosterFunding(store, { budgetConfig });
  const logs = [];
  const r = await startRosterSandboxes(store, { log: (l) => logs.push(l) });
  const bad = r.results.filter((x) => !x.ok);
  assert.deepEqual(bad.map((x) => x.slotId), ['slot-2']);
  assert.match(bad[0].error, /429/);
  assert.equal(r.results.filter((x) => x.ok).length, ACTIVE_TRACKS.length - 1);
  assert.ok(logs.some((l) => /slot-2 \(roster\) sandbox failed to start, continuing/.test(l)));
  assert.ok(logs.some((l) => l.includes(`${ACTIVE_TRACKS.length - 1}/${ACTIVE_TRACKS.length}`)));
  const s2 = store.slotManager.getSlot('slot-2');
  assert.equal(s2.sandbox.status, 'failed');
  assert.ok(s2.feed.some((f) => f.type === 'sandbox-error' && /429/.test(f.message)));
  // recoverable: the same admin call (or a re-run) starts it once E2B allows
  await cleanup(store);
});

test('startRosterSandboxes: over RAMHERD_SANDBOX_MAX, extra starts fail cleanly instead of overspending', async () => {
  const sdk = fakeSdk();
  const { store, budgetConfig } = storeWith({ env: { ...SANDBOX_ENV, RAMHERD_SANDBOX_MAX: '2' }, sdk });
  await seedRosterFunding(store, { budgetConfig });
  const r = await startRosterSandboxes(store);
  assert.equal(r.results.filter((x) => x.ok).length, 2);
  assert.equal(sdk.calls.create.length, 2);
  assert.ok(r.results.filter((x) => !x.ok).every((x) => /sandbox limit reached/.test(x.error)));
  await cleanup(store);
});

// ---- real boot ordering (spawns server/index.js; sandboxes forced off) ----

async function boot(extraEnv) {
  const entry = fileURLToPath(new URL('../server/index.js', import.meta.url));
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', RAMHERD_SANDBOX: 'off', RAMHERD_LIVE: '', ADMIN_TOKEN: 'test-token', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 10_000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/listening on (http:\/\/[^\s]+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => reject(new Error(`server exited ${code}:\n${out}`)));
  });
  const stop = () => new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); });
  return { base, stop, output: () => out };
}

test('boot: RAMHERD_AUTO_SEED=true -> the very first request already sees a funded ledger and the full roster', async (t) => {
  const s = await boot({ RAMHERD_AUTO_SEED: 'true' });
  t.after(s.stop);
  const slots = await (await fetch(`${s.base}/api/slots`)).json();
  const ledger = await (await fetch(`${s.base}/api/ledger`)).json();
  assert.equal(JSON.stringify(ledger).includes('"totalUsd":30'), true, JSON.stringify(ledger));
  const list = slots.slots ?? slots;
  assert.equal(list.filter((x) => x.kind === 'roster' && x.active).length, ACTIVE_TRACKS.length);
  assert.match(s.output(), /auto-seed: fee ledger \$30 -> 6 roster slot\(s\) active/);
});

test('boot: without the flag nothing is seeded (default behavior unchanged)', async (t) => {
  const s = await boot({ RAMHERD_AUTO_SEED: '' });
  t.after(s.stop);
  const slots = await (await fetch(`${s.base}/api/slots`)).json();
  assert.equal((slots.slots ?? slots).length, 0);
  assert.doesNotMatch(s.output(), /auto-seed/);
});
