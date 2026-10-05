// E2B sandbox plumbing. Every test here uses a FAKE SDK: no real sandbox is
// ever created by the suite (each one would bill real money per run).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxManager, sandboxPolicy, estimateCostUsd } from '../server/lib/sandbox.js';
import { createSlotManager } from '../server/lib/slots.js';
import { createMockLlmProvider } from '../server/lib/llm.js';
import { createStore } from '../server/store.js';
import { loadConfig } from '../server/config.js';
import { startApp } from './helpers/harness.js';

const FAKE_KEY = 'e2b_fakekeyfortests0123456789';

/** Minimal stand-in for @e2b/desktop's Sandbox, recording every call. */
function fakeSdk({ failCreate = false, failStream = false, failKill = false } = {}) {
  const calls = { create: [], kill: [], staticKill: [], streamStart: [] };
  let seq = 0;
  class Sandbox {
    constructor(id) {
      this.sandboxId = id;
      this.killed = false;
      this.stream = {
        start: async (opts) => {
          calls.streamStart.push(opts);
          if (failStream) throw new Error('noVNC did not come up');
        },
        getAuthKey: () => 'vncpass123',
        getUrl: ({ viewOnly, authKey }) =>
          `https://6080-${id}.e2b.app/vnc.html?autoconnect=true${viewOnly ? '&view_only=true' : ''}&password=${authKey}`,
      };
    }
    async kill() {
      calls.kill.push(this.sandboxId);
      if (failKill) throw new Error('network down');
      this.killed = true;
      return true;
    }
    static async create(template, opts) {
      calls.create.push({ template, opts });
      if (failCreate) throw new Error(`401 unauthorized for key ${opts.apiKey}`);
      return new Sandbox(`sbx${++seq}`);
    }
    static async kill(id, opts) {
      calls.staticKill.push({ id, hasKey: Boolean(opts?.apiKey) });
      return true;
    }
  }
  return { Sandbox, calls, loadSdk: async () => ({ Sandbox }) };
}

function manager(sdk, extra = {}) {
  let t = 1_000_000;
  return createSandboxManager({ apiKey: FAKE_KEY, loadSdk: sdk.loadSdk, now: () => (t += 1000), ...extra });
}

// ---- policy / opt-in gate ----

test('sandboxPolicy is off by default, even with an E2B key present', () => {
  const p = sandboxPolicy({ E2B_API_KEY: FAKE_KEY });
  assert.equal(p.enabled, false);
  assert.equal(p.ready, false);
  assert.equal(p.provider, null);
  assert.equal(JSON.stringify(p).includes(FAKE_KEY), false, 'policy must not carry the key');
});

test('sandboxPolicy needs exactly RAMHERD_SANDBOX=e2b plus a key to be ready', () => {
  assert.equal(sandboxPolicy({ RAMHERD_SANDBOX: 'true', E2B_API_KEY: FAKE_KEY }).ready, false);
  assert.equal(sandboxPolicy({ RAMHERD_SANDBOX: 'e2b' }).ready, false);
  assert.equal(sandboxPolicy({ RAMHERD_SANDBOX: 'e2b', E2B_API_KEY: '  ' }).ready, false);
  const p = sandboxPolicy({ RAMHERD_SANDBOX: 'e2b', E2B_API_KEY: FAKE_KEY });
  assert.equal(p.ready, true);
  assert.equal(p.template, 'desktop');
  assert.equal(p.timeoutMs, 15 * 60_000);
  assert.equal(p.maxConcurrent, 6);
});

test('sandboxPolicy clamps timeout and concurrency to the plan limits', () => {
  const base = { RAMHERD_SANDBOX: 'e2b', E2B_API_KEY: FAKE_KEY };
  assert.equal(sandboxPolicy({ ...base, RAMHERD_SANDBOX_TIMEOUT_MIN: '5' }).timeoutMs, 5 * 60_000);
  assert.equal(sandboxPolicy({ ...base, RAMHERD_SANDBOX_TIMEOUT_MIN: '99999' }).timeoutMs, 15 * 60_000);
  assert.equal(sandboxPolicy({ ...base, RAMHERD_SANDBOX_MAX: '101' }).maxConcurrent, 6);
  assert.equal(sandboxPolicy({ ...base, RAMHERD_SANDBOX_MAX: '100' }).maxConcurrent, 100);
});

test('store without the flag builds no sandbox manager and never loads the SDK, key or not', () => {
  let loaded = 0;
  const store = createStore({
    budgetConfig: loadConfig({}).budget,
    env: { E2B_API_KEY: FAKE_KEY },
    loadSandboxSdk: async () => { loaded++; return {}; },
  });
  assert.equal(store.sandboxManager, null);
  assert.equal(store.slotManager.sandboxesEnabled, false);
  store.slotManager.setSlotCount(2);
  assert.equal(store.slotManager.getSlots()[0].sandbox, null);
  assert.equal(loaded, 0);
});

// ---- manager lifecycle ----

test('start creates one desktop sandbox with a hard kill timeout and returns public info only', async () => {
  const sdk = fakeSdk();
  const m = manager(sdk, { timeoutMs: 10 * 60_000 });
  const info = await m.start('slot-0');
  assert.equal(sdk.calls.create.length, 1);
  const { template, opts } = sdk.calls.create[0];
  assert.equal(template, 'desktop');
  assert.equal(opts.timeoutMs, 10 * 60_000);
  assert.deepEqual(opts.lifecycle, { onTimeout: 'kill', autoResume: false });
  assert.deepEqual(opts.metadata, { app: 'ramherd', slotId: 'slot-0' });
  assert.deepEqual(sdk.calls.streamStart, [{ requireAuth: true }]);
  assert.equal(info.sessionId, 'sbx1');
  assert.equal(info.provider, 'e2b');
  assert.equal(Date.parse(info.expiresAt) - Date.parse(info.startedAt), 10 * 60_000);
  const text = JSON.stringify(info);
  assert.equal(text.includes('password'), false);
  assert.equal(text.includes(FAKE_KEY), false);
  assert.equal(m.count(), 1);
});

test('getStream returns the view-only URL with its password; it says view-only is client-side', async () => {
  const m = manager(fakeSdk());
  assert.equal(m.getStream('slot-0'), null);
  await m.start('slot-0');
  const s = m.getStream('slot-0');
  assert.match(s.streamUrl, /^https:\/\/6080-sbx1\.e2b\.app\/vnc\.html\?.*view_only=true.*password=vncpass123/);
  assert.equal(s.viewOnly, 'client-side');
});

test('start is idempotent per slot, including concurrent calls', async () => {
  const sdk = fakeSdk();
  const m = manager(sdk);
  const [a, b] = await Promise.all([m.start('slot-0'), m.start('slot-0')]);
  assert.equal(a.sessionId, b.sessionId);
  assert.equal((await m.start('slot-0')).sessionId, a.sessionId);
  assert.equal(sdk.calls.create.length, 1);
});

test('the concurrency cap refuses extra sandboxes before calling E2B', async () => {
  const sdk = fakeSdk();
  const m = manager(sdk, { maxConcurrent: 2 });
  await m.start('a');
  await m.start('b');
  await assert.rejects(m.start('c'), /sandbox limit reached \(2/);
  assert.equal(sdk.calls.create.length, 2);
  await m.stop('a');
  await m.start('c');
  assert.equal(sdk.calls.create.length, 3);
});

test('stop kills the sandbox and reports how long it ran', async () => {
  const sdk = fakeSdk();
  const m = manager(sdk);
  await m.start('slot-0');
  const r = await m.stop('slot-0');
  assert.deepEqual(sdk.calls.kill, ['sbx1']);
  assert.equal(r.sessionId, 'sbx1');
  assert.ok(r.ranSeconds > 0);
  assert.equal(m.count(), 0);
  assert.equal(m.get('slot-0'), null);
  assert.equal(await m.stop('slot-0'), null, 'second stop is a no-op');
});

test('a failed stream start kills the sandbox instead of leaving it billing', async () => {
  const sdk = fakeSdk({ failStream: true });
  const m = manager(sdk);
  await assert.rejects(m.start('slot-0'), /stream start failed \(sandbox killed\)/);
  assert.deepEqual(sdk.calls.kill, ['sbx1']);
  assert.equal(m.count(), 0);
});

test('create errors never surface the API key', async () => {
  const m = manager(fakeSdk({ failCreate: true }));
  await assert.rejects(m.start('slot-0'), (err) => {
    assert.match(err.message, /create failed/);
    assert.equal(err.message.includes(FAKE_KEY), false);
    assert.match(err.message, /\[redacted\]/);
    return true;
  });
  assert.equal(m.count(), 0);
});

test('if instance kill fails, stop falls back to the static kill by id', async () => {
  const sdk = fakeSdk({ failKill: true });
  const m = manager(sdk);
  await m.start('slot-0');
  await m.stop('slot-0');
  assert.deepEqual(sdk.calls.staticKill, [{ id: 'sbx1', hasKey: true }]);
});

test('stopAll kills every running sandbox, including one still starting', async () => {
  const sdk = fakeSdk();
  const m = manager(sdk);
  await m.start('a');
  const pending = m.start('b');
  const results = await m.stopAll();
  await pending;
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.ok));
  assert.deepEqual(sdk.calls.kill.sort(), ['sbx1', 'sbx2']);
  assert.equal(m.count(), 0);
});

test('estimateCostUsd uses E2B per-second rates', () => {
  // 2 vCPU + 4 GiB for one hour
  const usd = estimateCostUsd({ seconds: 3600, cpuCount: 2, memoryMB: 4096 });
  assert.ok(Math.abs(usd - (3600 * (2 * 0.000014 + 4 * 0.0000045))) < 1e-12);
});

// ---- slot manager association ----

function slotsWith(sdk) {
  return createSlotManager({ llmProvider: createMockLlmProvider(), sandboxManager: manager(sdk) });
}

test('slots have no sandbox by default and sandbox calls refuse when disabled', async () => {
  const m = createSlotManager({ llmProvider: createMockLlmProvider() });
  m.setSlotCount(1);
  const [slot] = m.getSlots();
  assert.equal(slot.sandbox, null);
  assert.equal(m.sandboxesEnabled, false);
  await assert.rejects(m.startSandbox(slot.id), /sandboxes are disabled/);
});

test('activation and advance never start a sandbox on their own', async () => {
  const sdk = fakeSdk();
  const m = slotsWith(sdk);
  m.setSlotCount(3);
  for (const s of m.getSlots()) await m.advance(s.id);
  assert.equal(sdk.calls.create.length, 0);
});

test('startSandbox associates a session id with the slot; snapshot has no stream URL', async () => {
  const sdk = fakeSdk();
  const m = slotsWith(sdk);
  m.setSlotCount(1);
  const id = m.getSlots()[0].id;
  const snap = await m.startSandbox(id);
  assert.equal(snap.sandbox.status, 'running');
  assert.equal(snap.sandbox.sessionId, 'sbx1');
  assert.equal(JSON.stringify(snap).includes('vncpass123'), false);
  assert.deepEqual(snap.feed.slice(-2).map((f) => f.type), ['sandbox-starting', 'sandbox-started']);
  assert.match(m.getSandboxStream(id).streamUrl, /password=vncpass123/);
});

test('stopSandbox marks the session stopped and keeps the record', async () => {
  const sdk = fakeSdk();
  const m = slotsWith(sdk);
  m.setSlotCount(1);
  const id = m.getSlots()[0].id;
  await m.startSandbox(id);
  const snap = await m.stopSandbox(id);
  assert.equal(snap.sandbox.status, 'stopped');
  assert.equal(snap.sandbox.sessionId, 'sbx1');
  assert.ok(snap.sandbox.ranSeconds > 0);
  assert.equal(snap.feed.at(-1).type, 'sandbox-stopped');
  assert.equal(m.getSandboxStream(id), null);
});

test('a failed start is recorded on the slot and in its feed', async () => {
  const m = slotsWith(fakeSdk({ failCreate: true }));
  m.setSlotCount(1);
  const id = m.getSlots()[0].id;
  await assert.rejects(m.startSandbox(id));
  const snap = m.getSlot(id);
  assert.equal(snap.sandbox.status, 'failed');
  assert.equal(snap.feed.at(-1).type, 'sandbox-error');
  assert.equal(JSON.stringify(snap).includes(FAKE_KEY), false);
});

test('retiring a slot kills its sandbox', async () => {
  const sdk = fakeSdk();
  const m = slotsWith(sdk);
  m.setSlotCount(2);
  const id = m.getSlots()[1].id;
  await m.startSandbox(id);
  m.setSlotCount(1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sdk.calls.kill, ['sbx1']);
  assert.equal(m.getSlot(id).sandbox.status, 'stopped');
  await assert.rejects(m.startSandbox(id), /retired/);
});

// ---- HTTP API ----

function sandboxApp(sdk, env = { RAMHERD_SANDBOX: 'e2b', E2B_API_KEY: FAKE_KEY }) {
  return startApp({ env, loadSandboxSdk: sdk.loadSdk });
}

test('API: sandbox routes 409 when the flag is off; /api/slots says disabled', async (t) => {
  const sdk = fakeSdk();
  const s = await sandboxApp(sdk, { E2B_API_KEY: FAKE_KEY });
  t.after(() => s.stop());
  s.store.slotManager.setSlotCount(1);
  const list = await (await s.get('/api/slots')).json();
  assert.deepEqual(list.sandboxes, { enabled: false, provider: null });
  const res = await s.postJson('/api/admin/slots/slot-0/sandbox/start', {}, { headers: s.adminHeaders() });
  assert.equal(res.status, 409);
  assert.equal(sdk.calls.create.length, 0);
});

test('API: start/stop are admin-only; public slot shows session id, admin route shows stream URL', async (t) => {
  const sdk = fakeSdk();
  const s = await sandboxApp(sdk);
  t.after(() => s.stop());
  s.store.slotManager.setSlotCount(1);

  assert.equal((await s.postJson('/api/admin/slots/slot-0/sandbox/start', {})).status, 401);
  assert.equal(sdk.calls.create.length, 0);

  const started = await s.postJson('/api/admin/slots/slot-0/sandbox/start', {}, { headers: s.adminHeaders() });
  assert.equal(started.status, 201);
  assert.equal((await started.json()).slot.sandbox.sessionId, 'sbx1');

  const pub = await (await s.get('/api/slots/slot-0')).text();
  assert.match(pub, /"sessionId":"sbx1"/);
  assert.equal(pub.includes('vncpass123'), false, 'public route must not leak the VNC password');
  assert.equal(pub.includes(FAKE_KEY), false);

  assert.equal((await s.get('/api/admin/slots/slot-0/sandbox')).status, 401);
  const stream = await (await s.get('/api/admin/slots/slot-0/sandbox', { headers: s.adminHeaders() })).json();
  assert.match(stream.sandbox.streamUrl, /^https:\/\/6080-sbx1\.e2b\.app\/vnc\.html/);

  const stopped = await s.postJson('/api/admin/slots/slot-0/sandbox/stop', {}, { headers: s.adminHeaders() });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).slot.sandbox.status, 'stopped');
  assert.equal((await s.get('/api/admin/slots/slot-0/sandbox', { headers: s.adminHeaders() })).status, 404);
});

test('API: unknown slot 404s; closing the app kills running sandboxes', async () => {
  const sdk = fakeSdk();
  const s = await sandboxApp(sdk);
  const res = await s.postJson('/api/admin/slots/nope/sandbox/start', {}, { headers: s.adminHeaders() });
  assert.equal(res.status, 404);
  s.store.slotManager.setSlotCount(1);
  await s.postJson('/api/admin/slots/slot-0/sandbox/start', {}, { headers: s.adminHeaders() });
  await s.stop();
  assert.deepEqual(sdk.calls.kill, ['sbx1']);
});
