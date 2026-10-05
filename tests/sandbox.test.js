// E2B sandbox plumbing. Every test here uses a FAKE SDK: no real sandbox is
// ever created by the suite (each one would bill real money per run).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSandboxManager, sandboxPolicy, estimateCostUsd,
  viewOnlyX11vncCommand, checkX11vncProcesses, REQUIRED_X11VNC_FLAGS, vncPassword,
} from '../server/lib/sandbox.js';
import { createSlotManager } from '../server/lib/slots.js';
import { createMockLlmProvider } from '../server/lib/llm.js';
import { createStore } from '../server/store.js';
import { loadConfig } from '../server/config.js';
import { startApp } from './helpers/harness.js';

const FAKE_KEY = 'e2b_fakekeyfortests0123456789';

/**
 * Minimal stand-in for @e2b/desktop's Sandbox, recording every call. Commands
 * are recorded per sandbox; `ps -C x11vnc` answers with whatever x11vnc lines
 * were "launched" (or `psOverride`), so the view-only check runs for real.
 */
function fakeSdk({ failCreate = false, failStream = false, failKill = false, psOverride = null } = {}) {
  const calls = { create: [], kill: [], staticKill: [], streamStart: [], commands: [] };
  let seq = 0;
  class Sandbox {
    constructor(id) {
      this.sandboxId = id;
      this.display = ':0';
      this.killed = false;
      this.x11vnc = [];
      // The SDK's own stream helper must never be used: it starts x11vnc without -viewonly.
      this.stream = {
        start: async (opts) => { calls.streamStart.push(opts); },
        getAuthKey: () => 'sdkpass',
        getUrl: () => `https://6080-${id}.e2b.app/vnc.html?password=sdkpass`,
      };
      this.commands = {
        run: async (cmd, opts) => {
          calls.commands.push({ id, cmd, opts });
          if (cmd.startsWith('x11vnc -bg')) this.x11vnc.push(cmd);
          if (cmd.startsWith('pkill -x x11vnc')) this.x11vnc = [];
          if (cmd.startsWith('ps -C x11vnc')) return { exitCode: 0, stdout: psOverride ?? this.x11vnc.join('\n') + '\n', stderr: '' };
          if (failStream && cmd.includes('seq 1 75')) throw new Error('noVNC did not come up');
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      };
    }
    getHost(port) {
      return `${port}-${this.sandboxId}.e2b.app`;
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

const pwFrom = (url) => new URL(url).searchParams.get('password');

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
  assert.deepEqual(sdk.calls.streamStart, [], 'the SDK stream helper (no -viewonly) is never used');
  assert.equal(info.sessionId, 'sbx1');
  assert.equal(info.provider, 'e2b');
  assert.equal(Date.parse(info.expiresAt) - Date.parse(info.startedAt), 10 * 60_000);
  const text = JSON.stringify(info);
  assert.equal(text.includes('password'), false);
  assert.equal(text.includes(FAKE_KEY), false);
  assert.equal(m.count(), 1);
});

test('getStream returns the stream URL with its password and says view-only is enforced by the server', async () => {
  const m = manager(fakeSdk());
  assert.equal(m.getStream('slot-0'), null);
  await m.start('slot-0');
  const s = m.getStream('slot-0');
  assert.match(s.streamUrl, /^https:\/\/6080-sbx1\.e2b\.app\/vnc\.html\?.*view_only=true.*password=[A-Za-z0-9]{8}$/);
  assert.equal(s.viewOnly, 'server');
  assert.equal(s.enforcedBy, 'x11vnc -viewonly');
});

// ---- server-side view-only ----

test('the x11vnc command carries -viewonly and the other lock-down flags', () => {
  const cmd = viewOnlyX11vncCommand(':0');
  const args = cmd.split(/\s+/);
  for (const flag of ['-viewonly', '-localhost', '-nosel', '-noremote', '-usepw']) assert.ok(args.includes(flag), flag);
  assert.ok(args.includes('-rfbport') && args[args.indexOf('-rfbport') + 1] === '5900');
  assert.equal(args.includes('-nopw'), false);
  assert.deepEqual([...REQUIRED_X11VNC_FLAGS].sort(), ['-localhost', '-noremote', '-nosel', '-usepw', '-viewonly']);
});

test('checkX11vncProcesses accepts exactly one fully locked-down x11vnc and nothing else', () => {
  const good = viewOnlyX11vncCommand();
  assert.equal(checkX11vncProcesses(`${good}\n`), null);
  assert.match(checkX11vncProcesses(''), /found 0/);
  assert.match(checkX11vncProcesses(`${good}\n${good}\n`), /found 2/);
  assert.match(checkX11vncProcesses(good.replace(' -viewonly', '')), /missing -viewonly/);
  // a flag that merely contains the text is not the flag
  assert.match(checkX11vncProcesses(good.replace(' -viewonly', ' -viewonlyX')), /missing -viewonly/);
});

test('start launches x11vnc -viewonly through the command channel, then noVNC in the background', async () => {
  const sdk = fakeSdk();
  const m = manager(sdk);
  await m.start('slot-0');
  const cmds = sdk.calls.commands.map((c) => c.cmd);
  const vnc = cmds.findIndex((c) => c.startsWith('x11vnc -bg'));
  const check = cmds.findIndex((c) => c.startsWith('ps -C x11vnc'));
  const novnc = sdk.calls.commands.findIndex((c) => c.cmd.includes('novnc_proxy'));
  assert.ok(cmds[0].startsWith('pkill -x x11vnc'), 'clears any other VNC server first');
  assert.ok(vnc > 0 && check > vnc && novnc > check, 'x11vnc, then verify, then noVNC');
  assert.match(cmds[vnc], / -viewonly /);
  assert.deepEqual(sdk.calls.commands[novnc].opts, { background: true, timeoutMs: 0 });
  assert.match(sdk.calls.commands[novnc].cmd, /--vnc localhost:5900 --listen 6080/);
  // the password stored for x11vnc is the one in the URL
  const pw = pwFrom(m.getStream('slot-0').streamUrl);
  assert.ok(cmds.some((c) => c.includes(`x11vnc -storepasswd ${pw} `)));
});

test('if the running x11vnc is not provably view-only, the sandbox is killed and no stream exists', async () => {
  for (const ps of ['x11vnc -bg -display :0 -rfbport 5900 -usepw\n', `${viewOnlyX11vncCommand()}\nx11vnc -rfbport 5901 -usepw\n`, '']) {
    const sdk = fakeSdk({ psOverride: ps });
    const m = manager(sdk);
    await assert.rejects(m.start('slot-0'), /view-only not enforced.*sandbox killed|sandbox killed.*view-only not enforced/s);
    assert.deepEqual(sdk.calls.kill, ['sbx1']);
    assert.equal(sdk.calls.commands.some((c) => c.cmd.includes('novnc_proxy')), false, 'noVNC never started');
    assert.equal(m.getStream('slot-0'), null);
    assert.equal(m.getPublicStream('slot-0'), null);
  }
});

test('getPublicStream exposes only the server-enforced view-only stream, nothing internal', async () => {
  const m = manager(fakeSdk());
  assert.equal(m.getPublicStream('slot-0'), null);
  await m.start('slot-0');
  const p = m.getPublicStream('slot-0');
  assert.deepEqual(Object.keys(p).sort(), ['expiresAt', 'sessionId', 'streamUrl', 'viewOnly']);
  assert.equal(p.viewOnly, 'server');
  assert.equal(p.streamUrl, m.getStream('slot-0').streamUrl, 'the one and only stream is the -viewonly one');
  assert.equal(JSON.stringify(p).includes(FAKE_KEY), false);
});

test('vncPassword is 8 unambiguous characters and varies', () => {
  const seen = new Set(Array.from({ length: 50 }, vncPassword));
  for (const pw of seen) assert.match(pw, /^[A-Za-z0-9]{8}$/);
  assert.ok(seen.size > 45);
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
  const pw = pwFrom(m.getSandboxStream(id).streamUrl);
  assert.equal(JSON.stringify(snap).includes(pw), false);
  assert.deepEqual(snap.feed.slice(-2).map((f) => f.type), ['sandbox-starting', 'sandbox-started']);
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

  const pw = pwFrom(s.store.sandboxManager.getStream('slot-0').streamUrl);
  const pub = await (await s.get('/api/slots/slot-0')).text();
  assert.match(pub, /"sessionId":"sbx1"/);
  assert.equal(pub.includes(pw), false, 'the slot snapshot does not carry the stream URL');
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

test('API: public /api/slots/:id/stream gives the view-only stream when one runs, null otherwise', async (t) => {
  const sdk = fakeSdk();
  const s = await sandboxApp(sdk);
  t.after(() => s.stop());
  s.store.slotManager.setSlotCount(1);

  assert.equal((await s.get('/api/slots/nope/stream')).status, 404);
  let body = await (await s.get('/api/slots/slot-0/stream')).json();
  assert.deepEqual(body, { ok: true, enabled: true, stream: null });

  await s.postJson('/api/admin/slots/slot-0/sandbox/start', {}, { headers: s.adminHeaders() });
  const res = await s.get('/api/slots/slot-0/stream');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  body = await res.json();
  assert.equal(body.stream.viewOnly, 'server');
  assert.equal(body.stream.sessionId, 'sbx1');
  assert.match(body.stream.streamUrl, /^https:\/\/6080-sbx1\.e2b\.app\/vnc\.html\?/);
  assert.equal(JSON.stringify(body).includes(FAKE_KEY), false);
  // there is exactly one x11vnc and it is -viewonly: that is what this URL reaches
  const vnc = sdk.calls.commands.filter((c) => c.cmd.startsWith('x11vnc -bg'));
  assert.equal(vnc.length, 1);
  assert.match(vnc[0].cmd, / -viewonly /);

  await s.postJson('/api/admin/slots/slot-0/sandbox/stop', {}, { headers: s.adminHeaders() });
  body = await (await s.get('/api/slots/slot-0/stream')).json();
  assert.equal(body.stream, null);
});

test('API: stream route with sandboxes off says disabled and never loads the SDK', async (t) => {
  let loaded = 0;
  const s = await startApp({ env: { E2B_API_KEY: FAKE_KEY }, loadSandboxSdk: async () => { loaded++; return {}; } });
  t.after(() => s.stop());
  s.store.slotManager.setSlotCount(1);
  const body = await (await s.get('/api/slots/slot-0/stream')).json();
  assert.deepEqual(body, { ok: true, enabled: false, stream: null });
  assert.equal(loaded, 0);
});
