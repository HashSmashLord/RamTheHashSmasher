// Auto-restart of a roster RAM's sandbox after E2B's hard timeout ended it
// (server/lib/slots.js "Auto-restart"). FAKE SDK and FAKE timers only: no real
// sandbox is created and no real time passes. The real-E2B proof is
// scripts/prove-autorestart.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxManager, sandboxPolicy } from '../server/lib/sandbox.js';
import { createSlotManager, restartDelayMs } from '../server/lib/slots.js';
import { createMockLlmProvider } from '../server/lib/llm.js';
import { createStore } from '../server/store.js';
import { loadConfig } from '../server/config.js';
import { startApp } from './helpers/harness.js';

const FAKE_KEY = 'e2b_fakekeyfortests0123456789';

/** Minimal @e2b/desktop stand-in: creates, kills, getInfo, and a switch to make creates fail. */
function fakeSdk() {
  const calls = { create: [], kill: [] };
  const gone = new Set();
  const state = { failCreate: 0, createError: '429 rate limited' }; // failCreate: how many next creates fail (Infinity = all)
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
    async kill() { calls.kill.push(this.sandboxId); return !gone.has(this.sandboxId); }
    static async getInfo(id) {
      if (gone.has(id)) { const e = new Error(`Sandbox ${id} not found`); e.name = 'SandboxNotFoundError'; throw e; }
      return { sandboxId: id, state: 'running' };
    }
    static async create(template, opts) {
      calls.create.push({ template, slotId: opts.metadata.slotId });
      if (state.failCreate > 0) { state.failCreate -= 1; throw new Error(state.createError); }
      return new Sandbox(`sbx${++seq}`);
    }
    static async kill() { return true; }
  }
  return { calls, state, loadSdk: async () => ({ Sandbox }), vanish: (id) => gone.add(id) };
}

/** Captures timers instead of running them; tests fire them by hand. */
function fakeTimers() {
  const pending = new Map();
  const log = [];
  let n = 0;
  return {
    pending,
    log,
    setTimer: (fn, ms) => { const h = { id: ++n, fn, ms }; pending.set(h.id, h); log.push(ms); return h; },
    clearTimer: (h) => { pending.delete(h.id); h.cleared = true; },
    /** Fires the only pending timer; returns its delay. */
    fire() {
      assert.equal(pending.size, 1, `expected exactly one pending timer, found ${pending.size}`);
      const [h] = pending.values();
      pending.delete(h.id);
      h.fn();
      return h.ms;
    },
  };
}

const HARD_STOP_MS = 60_000;

/**
 * Slot manager + real sandbox manager over the fake SDK, with a controllable
 * clock, fake restart timers and fake workbench task/banner (recording which
 * sandbox they ran on).
 */
function rig({ autoRestart = { enabled: true, baseDelayMs: 30_000, maxDelayMs: 600_000, maxFailures: 4 } } = {}) {
  const sdk = fakeSdk();
  const clock = { t: 1_000_000 };
  const mgr = createSandboxManager({ apiKey: FAKE_KEY, loadSdk: sdk.loadSdk, timeoutMs: HARD_STOP_MS, reconcileMs: 0, now: () => clock.t });
  const timers = fakeTimers();
  const taskRuns = [];
  const bannerRuns = [];
  const sandboxTask = async (sbx) => { taskRuns.push(sbx.sandboxId); return { ok: true, repo: null, claim: null, check: null }; };
  const sandboxContext = { start: async (sbx) => { bannerRuns.push(sbx.sandboxId); }, update: async () => {} };
  const m = createSlotManager({
    llmProvider: createMockLlmProvider(), sandboxManager: mgr, sandboxTask, sandboxContext,
    autoRestart, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  /** E2B ends the slot's current sandbox at its hard stop, and the reconcile check notices. */
  async function expire(id, { early = false } = {}) {
    sdk.vanish(m.getSlot(id).sandbox.sessionId);
    clock.t += early ? 5_000 : HARD_STOP_MS + 10_000;
    return m.reconcileSandboxes();
  }
  return { sdk, mgr, m, timers, clock, taskRuns, bannerRuns, expire };
}

const types = (snap) => snap.feed.map((f) => f.type);

// ---- policy (the on/off switch) ----

test('auto-restart is off by default, needs RAMHERD_SANDBOX=e2b plus exactly RAMHERD_SANDBOX_AUTORESTART=true', () => {
  assert.equal(sandboxPolicy({}).autoRestart, false);
  assert.equal(sandboxPolicy({ RAMHERD_SANDBOX: 'e2b', E2B_API_KEY: FAKE_KEY }).autoRestart, false);
  assert.equal(sandboxPolicy({ RAMHERD_SANDBOX: 'e2b', E2B_API_KEY: FAKE_KEY, RAMHERD_SANDBOX_AUTORESTART: '1' }).autoRestart, false);
  assert.equal(sandboxPolicy({ RAMHERD_SANDBOX: 'e2b', E2B_API_KEY: FAKE_KEY, RAMHERD_SANDBOX_AUTORESTART: 'TRUE' }).autoRestart, false);
  assert.equal(sandboxPolicy({ RAMHERD_SANDBOX_AUTORESTART: 'true' }).autoRestart, false, 'no sandboxes, no auto-restart');
  const on = sandboxPolicy({ RAMHERD_SANDBOX: 'e2b', E2B_API_KEY: FAKE_KEY, RAMHERD_SANDBOX_AUTORESTART: 'true' });
  assert.equal(on.autoRestart, true);
  assert.equal(on.autoRestartBaseDelayMs, 30_000);
  assert.equal(on.autoRestartMaxDelayMs, 600_000);
  assert.equal(on.autoRestartMaxFailures, 5);
  const tuned = sandboxPolicy({ RAMHERD_SANDBOX: 'e2b', RAMHERD_SANDBOX_AUTORESTART_BACKOFF_SEC: '5', RAMHERD_SANDBOX_AUTORESTART_MAX_FAILURES: '3' });
  assert.equal(tuned.autoRestartBaseDelayMs, 5_000);
  assert.equal(tuned.autoRestartMaxFailures, 3);
  const bad = sandboxPolicy({ RAMHERD_SANDBOX: 'e2b', RAMHERD_SANDBOX_AUTORESTART_BACKOFF_SEC: '0', RAMHERD_SANDBOX_AUTORESTART_MAX_FAILURES: '999' });
  assert.equal(bad.autoRestartBaseDelayMs, 30_000);
  assert.equal(bad.autoRestartMaxFailures, 5);
});

test('store wires auto-restart only when the flag is on', () => {
  const budgetConfig = loadConfig({}, {}).budget;
  const off = createStore({ budgetConfig, env: { RAMHERD_SANDBOX: 'e2b', E2B_API_KEY: FAKE_KEY }, loadSandboxSdk: fakeSdk().loadSdk });
  assert.deepEqual([off.slotManager.autoRestartStatus().configured, off.slotManager.autoRestartStatus().active], [false, false]);
  assert.throws(() => off.slotManager.setAutoRestart(true), /not configured/);
  const on = createStore({ budgetConfig, env: { RAMHERD_SANDBOX: 'e2b', E2B_API_KEY: FAKE_KEY, RAMHERD_SANDBOX_AUTORESTART: 'true' }, loadSandboxSdk: fakeSdk().loadSdk });
  assert.equal(on.slotManager.autoRestartStatus().active, true);
  assert.equal(on.slotManager.autoRestartStatus().maxFailures, 5);
  const noSandboxes = createStore({ budgetConfig, env: { RAMHERD_SANDBOX_AUTORESTART: 'true' } });
  assert.equal(noSandboxes.slotManager.autoRestartStatus().configured, false);
});

test('without auto-restart configured, an expired sandbox stays expired (the old behaviour)', async () => {
  const r = rig({ autoRestart: null });
  r.m.setSlotCount(1);
  await r.m.startSandbox('slot-0');
  await r.expire('slot-0');
  assert.equal(r.m.getSlot('slot-0').sandbox.status, 'expired');
  assert.equal(r.timers.pending.size, 0);
  assert.equal(r.sdk.calls.create.length, 1);
});

// ---- the restart itself ----

test('a roster sandbox ended by its hard timeout gets a fresh one at once, which reruns the workbench task and banner', async () => {
  const r = rig();
  r.m.setSlotCount(1);
  await r.m.startSandbox('slot-0');
  await r.m.waitForSandboxTask('slot-0');
  await r.expire('slot-0');
  assert.equal(r.m.getSlot('slot-0').sandbox.status, 'expired');
  assert.equal(r.m.autoRestartStatus().pending.length, 1);
  assert.equal(r.timers.fire(), 0, 'the first restart goes out without delay');
  await r.m.waitForSandboxRestart('slot-0');
  const snap = r.m.getSlot('slot-0');
  assert.equal(snap.sandbox.status, 'running');
  assert.equal(snap.sandbox.sessionId, 'sbx2');
  await r.m.waitForSandboxTask('slot-0');
  await r.m.waitForSandboxContext('slot-0');
  assert.deepEqual(r.taskRuns, ['sbx1', 'sbx2']);
  assert.deepEqual(r.bannerRuns, ['sbx1', 'sbx2']);
  const t = types(r.m.getSlot('slot-0'));
  const i = t.indexOf('sandbox-expired');
  assert.deepEqual(t.slice(i, i + 4), ['sandbox-expired', 'sandbox-autorestart-scheduled', 'sandbox-starting', 'sandbox-started']);
  assert.equal(r.m.autoRestartStatus().pending.length, 0);
  // and it keeps doing it on the next timeout
  await r.expire('slot-0');
  assert.equal(r.timers.fire(), 0);
  await r.m.waitForSandboxRestart('slot-0');
  assert.equal(r.m.getSlot('slot-0').sandbox.sessionId, 'sbx3');
});

test('a sandbox gone BEFORE its hard stop (endedBy provider) is not restarted, and the feed says why', async () => {
  const r = rig();
  r.m.setSlotCount(1);
  await r.m.startSandbox('slot-0');
  await r.expire('slot-0', { early: true });
  const snap = r.m.getSlot('slot-0');
  assert.equal(snap.sandbox.endedBy, 'provider');
  assert.equal(r.timers.pending.size, 0);
  assert.equal(snap.feed.at(-1).type, 'sandbox-autorestart-skipped');
  assert.equal(r.sdk.calls.create.length, 1);
});

test('owned (launchpad) slots are left entirely alone: no restart, no restart feed lines', async () => {
  const r = rig();
  const owned = r.m.createOwnedSlot({ ramId: 'ram-1', owner: 'Wallet1111', track: 'sha256-r31-exploratory', approach: 'differential', model: 'm', brief: 'b' });
  await r.m.startSandbox(owned.id);
  await r.expire(owned.id);
  const snap = r.m.getSlot(owned.id);
  assert.equal(snap.sandbox.status, 'expired');
  assert.equal(r.timers.pending.size, 0);
  assert.equal(types(snap).some((x) => x.startsWith('sandbox-autorestart')), false);
  assert.equal(r.sdk.calls.create.length, 1);
});

test('retired roster slots are not restarted, and retiring cancels a pending restart', async () => {
  const r = rig();
  r.m.setSlotCount(2);
  await r.m.startSandbox('slot-1');
  r.sdk.state.failCreate = 1;
  await r.expire('slot-1');
  r.timers.fire();
  await r.m.waitForSandboxRestart('slot-1'); // failed -> backoff timer pending
  assert.equal(r.timers.pending.size, 1);
  const [h] = r.timers.pending.values();
  r.m.setSlotCount(1);
  assert.equal(h.cleared, true);
  assert.equal(r.timers.pending.size, 0);
  h.fn(); // even if the timer fired anyway, nothing happens
  await r.m.waitForSandboxRestart('slot-1');
  assert.equal(r.sdk.calls.create.length, 2);
  assert.equal(r.m.getSlot('slot-1').feed.at(-1).type, 'sandbox-autorestart-cancelled');
});

// ---- an admin's deliberate stop wins ----

test('an admin stop is never undone: no restart afterwards, even when reconcile runs later', async () => {
  const r = rig();
  r.m.setSlotCount(1);
  await r.m.startSandbox('slot-0');
  await r.m.stopSandbox('slot-0');
  r.clock.t += HARD_STOP_MS * 2;
  await r.m.reconcileSandboxes();
  assert.equal(r.m.getSlot('slot-0').sandbox.status, 'stopped');
  assert.equal(r.timers.pending.size, 0);
  assert.equal(r.sdk.calls.create.length, 1);
});

test('an admin stop that finds the sandbox already timed out records it expired but does not restart it', async () => {
  const r = rig();
  r.m.setSlotCount(1);
  await r.m.startSandbox('slot-0');
  r.sdk.vanish('sbx1');
  r.clock.t += HARD_STOP_MS + 10_000;
  const snap = await r.m.stopSandbox('slot-0');
  assert.equal(snap.sandbox.status, 'expired');
  assert.equal(snap.sandbox.endedBy, 'timeout');
  assert.equal(r.timers.pending.size, 0);
  assert.equal(r.sdk.calls.create.length, 1);
});

test('an admin stop during a pending restart (backoff wait) cancels it', async () => {
  const r = rig();
  r.m.setSlotCount(1);
  await r.m.startSandbox('slot-0');
  r.sdk.state.failCreate = 1;
  await r.expire('slot-0');
  r.timers.fire();
  await r.m.waitForSandboxRestart('slot-0');
  const [h] = r.timers.pending.values();
  assert.equal(h.ms, 30_000);
  await r.m.stopSandbox('slot-0');
  assert.equal(h.cleared, true);
  h.fn();
  await r.m.waitForSandboxRestart('slot-0');
  assert.equal(r.sdk.calls.create.length, 2, 'the cancelled retry never reached E2B');
  assert.equal(r.m.autoRestartStatus().pending.length, 0);
  assert.ok(types(r.m.getSlot('slot-0')).includes('sandbox-autorestart-cancelled'));
});

test('an admin stop while a restart is being created kills the new sandbox and nothing retries', async () => {
  const r = rig();
  r.m.setSlotCount(1);
  await r.m.startSandbox('slot-0');
  await r.expire('slot-0');
  r.timers.fire(); // restart in flight
  await r.m.stopSandbox('slot-0');
  await r.m.waitForSandboxRestart('slot-0');
  assert.equal(r.m.getSlot('slot-0').sandbox.status, 'stopped');
  assert.deepEqual(r.sdk.calls.kill, ['sbx2']);
  assert.equal(r.timers.pending.size, 0);
  assert.equal(r.mgr.count(), 0);
});

test('an admin start during a pending restart takes over (one sandbox, no double create)', async () => {
  const r = rig();
  r.m.setSlotCount(1);
  await r.m.startSandbox('slot-0');
  r.sdk.state.failCreate = 1;
  await r.expire('slot-0');
  r.timers.fire();
  await r.m.waitForSandboxRestart('slot-0');
  const [h] = r.timers.pending.values();
  await r.m.startSandbox('slot-0');
  assert.equal(h.cleared, true);
  assert.equal(r.m.getSlot('slot-0').sandbox.status, 'running');
  assert.equal(r.sdk.calls.create.length, 3);
  assert.equal(r.timers.pending.size, 0);
});

// ---- backoff and give-up ----

test('restartDelayMs: at once, then exponential from the base, capped', () => {
  const d = [0, 1, 2, 3, 4, 5, 6, 10].map((f) => restartDelayMs(f, 30_000, 600_000));
  assert.deepEqual(d, [0, 30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
});

test('repeated restart failures back off exponentially, then give up with a feed line; nothing loops', async () => {
  const r = rig({ autoRestart: { enabled: true, baseDelayMs: 30_000, maxDelayMs: 600_000, maxFailures: 4 } });
  r.m.setSlotCount(1);
  await r.m.startSandbox('slot-0');
  r.sdk.state.failCreate = Infinity;
  r.sdk.state.createError = `401 unauthorized for key ${FAKE_KEY}`;
  await r.expire('slot-0');
  const delays = [];
  while (r.timers.pending.size) {
    delays.push(r.timers.fire());
    await r.m.waitForSandboxRestart('slot-0');
  }
  assert.deepEqual(delays, [0, 30_000, 60_000, 120_000]);
  assert.equal(r.sdk.calls.create.length, 1 + 4, 'exactly maxFailures restart attempts reached E2B');
  const snap = r.m.getSlot('slot-0');
  assert.equal(snap.sandbox.status, 'failed');
  assert.equal(snap.feed.at(-1).type, 'sandbox-autorestart-gave-up');
  assert.match(snap.feed.at(-1).message, /gave up after 4 failed attempts in a row; last error: E2B sandbox create failed: 401/);
  assert.equal(JSON.stringify(snap).includes(FAKE_KEY), false, 'the key never reaches the feed');
  assert.equal(r.m.autoRestartStatus().pending.length, 0);
  // the feed shows each retry with its wait
  assert.deepEqual(snap.feed.filter((f) => f.type === 'sandbox-autorestart-scheduled').map((f) => (f.message.match(/retrying in (\d+)s/) || [, 'now'])[1]), ['now', '30', '60', '120']);
});

test('a failure followed by a success resets the count: the next timeout restarts at once again', async () => {
  const r = rig();
  r.m.setSlotCount(1);
  await r.m.startSandbox('slot-0');
  r.sdk.state.failCreate = 2;
  await r.expire('slot-0');
  assert.equal(r.timers.fire(), 0);
  await r.m.waitForSandboxRestart('slot-0');
  assert.equal(r.timers.fire(), 30_000);
  await r.m.waitForSandboxRestart('slot-0');
  assert.equal(r.timers.fire(), 60_000);
  await r.m.waitForSandboxRestart('slot-0');
  assert.equal(r.m.getSlot('slot-0').sandbox.status, 'running');
  assert.equal(r.timers.pending.size, 0);
  await r.expire('slot-0');
  assert.equal(r.timers.fire(), 0);
  await r.m.waitForSandboxRestart('slot-0');
  assert.equal(r.m.getSlot('slot-0').sandbox.status, 'running');
});

test('the concurrency cap counts as a failure and backs off like any other', async () => {
  const sdk = fakeSdk();
  const clock = { t: 1_000_000 };
  const mgr = createSandboxManager({ apiKey: FAKE_KEY, loadSdk: sdk.loadSdk, timeoutMs: HARD_STOP_MS, reconcileMs: 0, maxConcurrent: 1, now: () => clock.t });
  const timers = fakeTimers();
  const m = createSlotManager({ llmProvider: createMockLlmProvider(), sandboxManager: mgr, autoRestart: { enabled: true, baseDelayMs: 1000, maxFailures: 2 }, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  m.setSlotCount(2);
  await m.startSandbox('slot-0');
  sdk.vanish('sbx1');
  clock.t += HARD_STOP_MS + 10_000;
  await m.reconcileSandboxes();
  await m.startSandbox('slot-1'); // takes the only seat before the restart fires
  timers.fire();
  await m.waitForSandboxRestart('slot-0');
  assert.equal(timers.fire(), 1000);
  await m.waitForSandboxRestart('slot-0');
  assert.equal(m.getSlot('slot-0').feed.at(-1).type, 'sandbox-autorestart-gave-up');
  assert.match(m.getSlot('slot-0').feed.at(-1).message, /sandbox limit reached/);
  assert.equal(sdk.calls.create.length, 2);
});

// ---- off switches ----

test('setAutoRestart(false) cancels every pending restart and schedules nothing more; true turns it back on', async () => {
  const r = rig();
  r.m.setSlotCount(2);
  await r.m.startSandbox('slot-0');
  await r.m.startSandbox('slot-1');
  r.sdk.state.failCreate = 1;
  await r.expire('slot-0');
  r.timers.fire();
  await r.m.waitForSandboxRestart('slot-0');
  const [h] = r.timers.pending.values();
  assert.equal(r.m.setAutoRestart(false).active, false);
  assert.equal(h.cleared, true);
  h.fn();
  await r.m.waitForSandboxRestart('slot-0');
  await r.expire('slot-1');
  assert.equal(r.timers.pending.size, 0, 'a timeout while off schedules nothing');
  assert.equal(r.sdk.calls.create.length, 3);
  assert.equal(r.m.getSlot('slot-0').feed.at(-1).type, 'sandbox-autorestart-cancelled');
  assert.equal(r.m.setAutoRestart(true).active, true);
  await r.m.startSandbox('slot-1');
  await r.expire('slot-1');
  assert.equal(r.timers.pending.size, 1);
});

test('stopAutoRestart (shutdown) is permanent: pending restarts cancelled, none scheduled, cannot be switched back on', async () => {
  const r = rig();
  r.m.setSlotCount(2);
  await r.m.startSandbox('slot-0');
  await r.m.startSandbox('slot-1');
  r.sdk.state.failCreate = 1;
  await r.expire('slot-0');
  r.timers.fire();
  await r.m.waitForSandboxRestart('slot-0');
  const [h] = r.timers.pending.values();
  r.m.stopAutoRestart();
  assert.equal(h.cleared, true);
  assert.throws(() => r.m.setAutoRestart(true), /shutdown/);
  await r.expire('slot-1');
  assert.equal(r.timers.pending.size, 0);
  assert.equal(r.m.autoRestartStatus().active, false);
});

test('a restart already in flight when auto-restart is switched off does not retry after it fails', async () => {
  const r = rig();
  r.m.setSlotCount(1);
  await r.m.startSandbox('slot-0');
  r.sdk.state.failCreate = 1;
  await r.expire('slot-0');
  r.timers.fire();
  r.m.stopAutoRestart();
  await new Promise((res) => setImmediate(res));
  await r.m.waitForSandboxRestart('slot-0');
  assert.equal(r.timers.pending.size, 0);
  assert.equal(r.sdk.calls.create.length, 2);
});

// ---- HTTP: switch route and app.close ----

function autoApp(sdk, extraEnv = {}) {
  return startApp({ env: { RAMHERD_SANDBOX: 'e2b', E2B_API_KEY: FAKE_KEY, RAMHERD_SANDBOX_AUTORESTART: 'true', ...extraEnv }, loadSandboxSdk: sdk.loadSdk });
}

test('API: the auto-restart switch is admin-only and turns it off and on', async (t) => {
  const s = await autoApp(fakeSdk());
  t.after(() => s.stop());
  assert.equal((await s.get('/api/admin/sandboxes/autorestart')).status, 401);
  assert.equal((await s.postJson('/api/admin/sandboxes/autorestart', { enabled: false })).status, 401);
  const got = await (await s.get('/api/admin/sandboxes/autorestart', { headers: s.adminHeaders() })).json();
  assert.equal(got.autoRestart.active, true);
  const off = await s.postJson('/api/admin/sandboxes/autorestart', { enabled: false }, { headers: s.adminHeaders() });
  assert.equal(off.status, 200);
  assert.equal((await off.json()).autoRestart.active, false);
  assert.equal(s.store.slotManager.autoRestartStatus().active, false);
  assert.equal((await s.postJson('/api/admin/sandboxes/autorestart', { enabled: 'yes' }, { headers: s.adminHeaders() })).status, 400);
  const on = await s.postJson('/api/admin/sandboxes/autorestart', { enabled: true }, { headers: s.adminHeaders() });
  assert.equal((await on.json()).autoRestart.active, true);
});

test('API: it cannot be switched on when RAMHERD_SANDBOX_AUTORESTART is not set', async (t) => {
  const s = await startApp({ env: { RAMHERD_SANDBOX: 'e2b', E2B_API_KEY: FAKE_KEY }, loadSandboxSdk: fakeSdk().loadSdk });
  t.after(() => s.stop());
  const res = await s.postJson('/api/admin/sandboxes/autorestart', { enabled: true }, { headers: s.adminHeaders() });
  assert.equal(res.status, 409);
  assert.match((await res.json()).message, /not configured/);
});

test('API: app.close switches auto-restart off BEFORE killing sandboxes', async () => {
  const sdk = fakeSdk();
  const s = await autoApp(sdk);
  s.store.slotManager.setSlotCount(1);
  await s.postJson('/api/admin/slots/slot-0/sandbox/start', {}, { headers: s.adminHeaders() });
  const sm = s.store.slotManager;
  const original = sm.stopAutoRestart;
  let liveAtSwitchOff = null;
  sm.stopAutoRestart = () => { liveAtSwitchOff = s.store.sandboxManager.count(); original(); };
  await s.stop();
  assert.equal(liveAtSwitchOff, 1, 'auto-restart was switched off while the sandbox was still live');
  assert.deepEqual(sdk.calls.kill, ['sbx1']);
  assert.equal(sm.autoRestartStatus().active, false);
  assert.throws(() => sm.setAutoRestart(true), /shutdown/);
});
