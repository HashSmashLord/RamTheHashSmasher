// The always-on research loop (server/lib/slots.js "Active loop") and its
// desktop side (server/lib/sandbox-activity.js). FAKE SDK, FAKE timers, FAKE
// LLM and a fake desktop: no real sandbox, no real model call, no real time.
// The real-E2B + real-model proof is scripts/prove-active-loop.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxManager, sandboxPolicy } from '../server/lib/sandbox.js';
import { createSlotManager, LOOP_THINKING_SYSTEM } from '../server/lib/slots.js';
import { createMockLlmProvider } from '../server/lib/llm.js';
import { createStore } from '../server/store.js';
import { loadConfig } from '../server/config.js';
import {
  parseThinking, asciiText, noteBlock, eprintSearchUrl, notesFile, ensureNotepad, typeIntoNotepad,
  MAX_IDLE_MS, MAX_TYPED_CHARS,
} from '../server/lib/sandbox-activity.js';
import { ACTIVE_TRACKS } from '../server/lib/targets.js';

const FAKE_KEY = 'e2b_fakekeyfortests0123456789';

function fakeSdk() {
  const gone = new Set();
  let seq = 0;
  class Sandbox {
    constructor(id) {
      this.sandboxId = id;
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
    async kill() { return true; }
    static async getInfo(id) {
      if (gone.has(id)) { const e = new Error(`Sandbox ${id} not found`); e.name = 'SandboxNotFoundError'; throw e; }
      return { sandboxId: id, state: 'running' };
    }
    static async create() { return new Sandbox(`sbx${++seq}`); }
    static async kill() { return true; }
  }
  return { loadSdk: async () => ({ Sandbox }), vanish: (id) => gone.add(id) };
}

function fakeTimers() {
  const pending = new Map();
  let n = 0;
  return {
    pending,
    setTimer: (fn, ms) => { const h = { id: ++n, fn, ms }; pending.set(h.id, h); return h; },
    clearTimer: (h) => { pending.delete(h.id); h.cleared = true; },
    fire() {
      assert.equal(pending.size, 1, `expected exactly one pending timer, found ${pending.size}`);
      const [h] = pending.values();
      pending.delete(h.id);
      h.fn();
      return h.ms;
    },
  };
}

/** A live-looking provider (mocked: false) whose answers the test controls. */
function fakeLiveLlm(answers = []) {
  const calls = [];
  return {
    calls,
    provider: {
      kind: 'openrouter',
      async complete(req) {
        calls.push(req);
        const text = answers.length ? answers.shift() : `Plan step ${calls.length}: try a tighter message-modification pass.`;
        if (text instanceof Error) throw text;
        return { text, mocked: false, model: req.model, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.001 } };
      },
    },
  };
}

/** Fake desktop activity: records what would be typed / browsed. */
function fakeActivity({ failType = 0, results = [{ id: '2026/1120', title: 'Pushing Collision Attacks on SHA-2 to 39 Steps' }] } = {}) {
  const typed = [];
  const browsed = [];
  const state = { failType };
  return {
    typed,
    browsed,
    state,
    activity: {
      ensureNotepad: async (sbx, { windowId }) => windowId ?? `win-${sbx.sandboxId}`,
      typeIntoNotepad: async (sbx, { block }) => {
        if (state.failType > 0) { state.failType -= 1; throw new Error('xdotool: cannot open display'); }
        typed.push({ sbx: sbx.sandboxId, block });
        return { verified: true };
      },
      browseLiterature: async (sbx, { query }) => { browsed.push({ sbx: sbx.sandboxId, query }); return { windowId: 'chrome1', url: eprintSearchUrl(query), pageTitle: 'Search results', results }; },
    },
  };
}

const HARD_STOP_MS = 60_000;

function rig({ live = true, answers, activeLoop = {}, activity = fakeActivity(), pipelineRunner = null, llm } = {}) {
  const sdk = fakeSdk();
  const clock = { t: 1_000_000 };
  const mgr = createSandboxManager({ apiKey: FAKE_KEY, loadSdk: sdk.loadSdk, timeoutMs: HARD_STOP_MS, reconcileMs: 0, now: () => clock.t });
  const timers = fakeTimers();
  const model = llm ?? fakeLiveLlm(answers);
  const m = createSlotManager({
    llmProvider: model.provider, sandboxManager: mgr, pipelineRunner,
    sandboxTask: async () => ({ ok: true, repo: null, claim: null, check: null }),
    sandboxContext: { start: async () => {}, update: async () => {} },
    sandboxActivity: activity.activity,
    activeLoop: { enabled: true, live, ...activeLoop },
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  /** Fires the loop's one pending timer and waits for that step to finish. */
  async function step(id = 'slot-0') {
    const ms = timers.fire();
    await m.waitForLoopStep(id);
    return ms;
  }
  async function boot(id = 'slot-0') {
    await m.startSandbox(id);
    await m.waitForSandboxTask(id);
  }
  return { sdk, mgr, m, timers, clock, llm: model, activity, step, boot };
}

const types = (snap) => snap.feed.map((f) => f.type);

// ---- pure helpers ----

test('parseThinking takes the model\'s last SEARCH line out of the note and sanitizes it', () => {
  assert.deepEqual(parseThinking('I will re-derive the 31-step characteristic.\nSEARCH: SHA-256 "31-step" collision; rm -rf /'), {
    note: 'I will re-derive the 31-step characteristic.', search: 'SHA-256 31-step collision rm -rf',
  });
  assert.deepEqual(parseThinking('Just a plan.'), { note: 'Just a plan.', search: null });
  assert.equal(parseThinking('x\n**SEARCH:** ab').search, null, 'too short after sanitizing');
  assert.equal(parseThinking(`x\nsearch: ${'a'.repeat(200)}`).search.length, 80);
});

test('asciiText, noteBlock and the ePrint URL produce plain, bounded, typeable text', () => {
  assert.equal(asciiText('time \u2248 2^86 \u2014 \u201cok\u201d \u{1F600}'), 'time ~ 2^86 - "ok"');
  const block = noteBlock({ ts: '2026-10-05T21:15:02.000Z', statusBefore: 'idle', statusAfter: 'thinking', entries: [{ message: 'a'.repeat(5000) }] });
  assert.match(block, /^\n\[21:15:02 UTC\] idle -> thinking\n/);
  assert.ok(block.length < MAX_TYPED_CHARS + 60);
  assert.equal(eprintSearchUrl('SHA-256 31 step'), 'https://eprint.iacr.org/search?q=SHA-256+31+step');
  assert.equal(notesFile(ACTIVE_TRACKS[0]), '/tmp/ramnotes/ram-notes-sha256-r31.txt');
});

test('typeIntoNotepad types the block into the editor window, saves, and verifies the saved file', async () => {
  const cmds = [];
  let file = 'header\n';
  const sbx = { commands: { run: async (cmd) => {
    cmds.push(cmd);
    if (cmd.startsWith('true')) {
      for (const part of cmd.split(' && ')) {
        if (part === 'xdotool key Return') file += '\n';
        const m = /^xdotool type --delay \d+ -- '(.*)'$/.exec(part);
        if (m) file += m[1].replace(/'\\''/g, "'");
      }
    }
    if (cmd.startsWith('tail -c')) return { stdout: file };
    return { stdout: '' };
  } } };
  const block = noteBlock({ ts: '2026-10-05T21:15:02Z', statusBefore: 'idle', statusAfter: 'thinking', entries: [{ message: "It's next: re-check the boomerang." }] });
  const r = await typeIntoNotepad(sbx, { assignment: ACTIVE_TRACKS[0], windowId: '42', block });
  assert.equal(r.verified, true);
  assert.match(cmds[0], /^xdotool windowactivate --sync 42/);
  assert.ok(cmds.some((c) => c.includes('ctrl+s')));
  file = 'header\n'; // the save did not land
  const sbx2 = { commands: { run: async (cmd) => (cmd.startsWith('tail -c') ? { stdout: 'header\n' } : { stdout: '' }) } };
  assert.equal((await typeIntoNotepad(sbx2, { assignment: ACTIVE_TRACKS[0], windowId: '42', block })).verified, false);
});

test('ensureNotepad launches Mousepad on the notes file and refuses when no window appears', async () => {
  const cmds = [];
  const sbx = (win) => ({ commands: { run: async (cmd) => { cmds.push(cmd); if (cmd.includes('xdotool search')) return { stdout: win }; if (cmd.startsWith('xprop')) return { stdout: '0,94,1280,676' }; return { stdout: '' }; } } });
  assert.equal(await ensureNotepad(sbx('777\n'), { assignment: ACTIVE_TRACKS[0] }), '777');
  assert.ok(cmds.some((c) => c === 'mousepad --disable-server /tmp/ramnotes/ram-notes-sha256-r31.txt'));
  assert.ok(cmds.some((c) => c.startsWith('xdotool windowmove 777 0 94 windowsize 777 1280')));
  await assert.rejects(ensureNotepad(sbx(''), { assignment: ACTIVE_TRACKS[0] }), /did not appear/);
});

// ---- policy / wiring ----

test('the loop is off by default and needs RAMHERD_SANDBOX=e2b plus exactly RAMHERD_SANDBOX_ACTIVE_LOOP=true; the pause is clamped', () => {
  assert.equal(sandboxPolicy({}).activeLoop, false);
  assert.equal(sandboxPolicy({ RAMHERD_SANDBOX: 'e2b', RAMHERD_SANDBOX_ACTIVE_LOOP: '1' }).activeLoop, false);
  assert.equal(sandboxPolicy({ RAMHERD_SANDBOX_ACTIVE_LOOP: 'true' }).activeLoop, false);
  const on = sandboxPolicy({ RAMHERD_SANDBOX: 'e2b', RAMHERD_SANDBOX_ACTIVE_LOOP: 'true' });
  assert.equal(on.activeLoop, true);
  assert.equal(on.activeLoopStepPauseMs, 5_000);
  assert.equal(on.activeLoopMaxThinking, 60);
  assert.equal(sandboxPolicy({ RAMHERD_SANDBOX: 'e2b', RAMHERD_SANDBOX_ACTIVE_LOOP_PAUSE_SEC: '1' }).activeLoopStepPauseMs, 5_000, 'below the floor falls back');
  assert.equal(sandboxPolicy({ RAMHERD_SANDBOX: 'e2b', RAMHERD_SANDBOX_ACTIVE_LOOP_PAUSE_SEC: '90' }).activeLoopStepPauseMs, 5_000, 'over the ceiling falls back');
  assert.equal(sandboxPolicy({ RAMHERD_SANDBOX: 'e2b', RAMHERD_SANDBOX_ACTIVE_LOOP_PAUSE_SEC: '12' }).activeLoopStepPauseMs, 12_000);
});

test('store: no loop without the flag; with the flag but mock LLM it is configured but not live', () => {
  const budgetConfig = loadConfig({}, {}).budget;
  const off = createStore({ budgetConfig, env: { RAMHERD_SANDBOX: 'e2b', E2B_API_KEY: FAKE_KEY }, loadSandboxSdk: fakeSdk().loadSdk });
  assert.equal(off.slotManager.activeLoopStatus().configured, false);
  const mock = createStore({ budgetConfig, env: { RAMHERD_SANDBOX: 'e2b', E2B_API_KEY: FAKE_KEY, RAMHERD_SANDBOX_ACTIVE_LOOP: 'true' }, loadSandboxSdk: fakeSdk().loadSdk });
  assert.deepEqual([mock.slotManager.activeLoopStatus().configured, mock.slotManager.activeLoopStatus().live], [true, false]);
  const live = createStore({ budgetConfig, env: { RAMHERD_SANDBOX: 'e2b', E2B_API_KEY: FAKE_KEY, RAMHERD_SANDBOX_ACTIVE_LOOP: 'true', RAMHERD_LIVE: 'true', OPENROUTER_API_KEY: 'sk-or-fake' }, loadSandboxSdk: fakeSdk().loadSdk });
  assert.equal(live.slotManager.activeLoopStatus().live, true);
});

// ---- the loop drives the REAL status, and the desktop types the same feed lines ----

test('after the workbench, the loop advances the real status back to back, forever, typing each step\'s own feed line', async () => {
  const r = rig();
  r.m.setSlotCount(1);
  await r.boot();
  assert.equal(r.m.getSlot('slot-0').feed.at(-1).type, 'sandbox-loop-started');
  const statuses = [];
  const delays = [];
  for (let i = 0; i < 9; i++) {
    delays.push(await r.step());
    statuses.push(r.m.getSlot('slot-0').status);
  }
  assert.deepEqual(statuses, ['thinking', 'running-experiment', 'failed', 'idle', 'thinking', 'running-experiment', 'failed', 'idle', 'thinking']);
  assert.equal(delays[0], 0, 'first step right after the workbench');
  assert.ok(delays.slice(1).every((d) => d === 5_000 && d < MAX_IDLE_MS));
  assert.equal(r.timers.pending.size, 1, 'and the next step is already scheduled');
  // What is typed is exactly the feed line each advance pushed.
  const feed = r.m.getSlot('slot-0').feed;
  assert.equal(r.activity.typed.length, 9);
  const thinking = feed.filter((f) => f.type === 'thinking');
  assert.ok(r.activity.typed[0].block.includes('idle -> thinking'));
  assert.ok(r.activity.typed[0].block.includes(thinking[0].message));
  assert.ok(r.activity.typed[1].block.includes('thinking -> running-experiment'));
  // Honest on a track with no runner: no "drafted", says nothing ran.
  const fail = feed.find((f) => f.type === 'failed');
  assert.match(fail.message, /No experiment ran .* no real runner/);
  assert.equal(feed.some((f) => /drafted for/.test(f.message)), false);
  // Thinking calls are grounded: loop system prompt + real recent history.
  assert.equal(r.llm.calls.length, 3);
  assert.equal(r.llm.calls[1].system, LOOP_THINKING_SYSTEM);
  assert.match(r.llm.calls[1].prompt, /Target: SHA-256 reduced to 31 rounds/);
  assert.match(r.llm.calls[1].prompt, /recent activity, newest last: .*\[thinking\] Plan step 1/);
  assert.equal(r.llm.calls[1].maxTokens, 800);
  assert.equal(r.llm.calls[1].model, 'anthropic/claude-opus-5.5');
  assert.equal(r.m.activeLoopStatus().loops[0].thinking, 3);
});

test('concurrent advance() calls on one slot are serialized: one model call, two distinct steps', async () => {
  const llm = fakeLiveLlm();
  const m = createSlotManager({ llmProvider: llm.provider });
  m.setSlotCount(1);
  const [a, b] = await Promise.all([m.advance('slot-0'), m.advance('slot-0')]);
  assert.equal(a.status, 'thinking');
  assert.equal(b.status, 'running-experiment');
  assert.equal(llm.calls.length, 1);
});

// ---- mock mode never fakes it ----

test('mock mode: the loop never starts, no timer, nothing typed, and the feed says why', async () => {
  const r = rig({ live: false });
  r.m.setSlotCount(1);
  await r.boot();
  assert.equal(r.m.getSlot('slot-0').feed.at(-1).type, 'sandbox-loop-skipped');
  assert.match(r.m.getSlot('slot-0').feed.at(-1).message, /mock \(dry-run\) mode/);
  assert.equal(r.timers.pending.size, 0);
  assert.equal(r.llm.calls.length, 0);
  assert.equal(r.activity.typed.length, 0);
});

test('a thinking call that comes back mocked stops the loop before anything is typed', async () => {
  const r = rig({ llm: { provider: createMockLlmProvider() } });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step();
  const snap = r.m.getSlot('slot-0');
  assert.equal(snap.feed.at(-1).type, 'sandbox-loop-stopped');
  assert.match(snap.feed.at(-2).message, /^\[mock\]/, 'the mock line itself is visibly mock');
  assert.equal(r.activity.typed.length, 0);
  assert.equal(r.timers.pending.size, 0);
});

test('the loop refuses to start while the paid judge gate is open; owned slots are never driven', async () => {
  const r = rig({ pipelineRunner: { judgeAllowed: true, supportsTrack: () => false } });
  r.m.setSlotCount(1);
  await r.boot();
  assert.match(r.m.getSlot('slot-0').feed.at(-1).message, /judge gate is open/);
  assert.equal(r.timers.pending.size, 0);
  const r2 = rig();
  const owned = r2.m.createOwnedSlot({ ramId: 'ram-1', owner: 'W1', track: 'sha256-r31-exploratory', approach: 'x', model: 'm', brief: 'b' });
  await r2.boot(owned.id);
  assert.equal(types(r2.m.getSlot(owned.id)).some((t) => t.startsWith('sandbox-loop')), false);
  assert.equal(r2.timers.pending.size, 0);
});

// ---- literature search ----

test('a SEARCH line opens a real-looking ePrint lookup (rate limited), logged honestly and fed into the next thinking step', async () => {
  const r = rig({ answers: ['Re-read the 31-step trail.\nSEARCH: SHA-256 31 step collision', 'Next idea.\nSEARCH: SHA-256 semi-free-start', 'Third.\nSEARCH: SHA-2 local collision'], activeLoop: { browseEvery: 2 } });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step(); // thinking #1 -> browse
  let snap = r.m.getSlot('slot-0');
  const thinking = snap.feed.filter((f) => f.type === 'thinking').at(-1);
  assert.equal(thinking.message, 'Re-read the 31-step trail.', 'the SEARCH line is not in the feed text');
  assert.deepEqual(r.activity.browsed.map((b) => b.query), ['SHA-256 31 step collision']);
  assert.equal(snap.feed.at(-1).type, 'sandbox-browse');
  assert.match(snap.feed.at(-1).message, /2026\/1120 "Pushing Collision Attacks on SHA-2 to 39 Steps".*Titles only: no paper has been read/);
  for (let i = 0; i < 4; i++) await r.step(); // -> thinking #2: asks again, but within browseEvery
  assert.equal(r.activity.browsed.length, 1);
  assert.match(r.llm.calls[1].prompt, /last literature search, "SHA-256 31 step collision".*2026\/1120/);
  for (let i = 0; i < 4; i++) await r.step(); // -> thinking #3: allowed again
  assert.equal(r.activity.browsed.length, 2);
});

// ---- guardrails ----

test('admin stop ends the loop at once: pending step cleared, nothing more runs', async () => {
  const r = rig();
  r.m.setSlotCount(1);
  await r.boot();
  await r.step();
  const [h] = r.timers.pending.values();
  await r.m.stopSandbox('slot-0');
  assert.equal(h.cleared, true);
  assert.equal(r.timers.pending.size, 0);
  h.fn(); // even if it fired anyway
  await r.m.waitForLoopStep('slot-0');
  assert.equal(r.llm.calls.length, 1);
  assert.equal(r.activity.typed.length, 1);
  assert.equal(r.m.activeLoopStatus().loops.length, 0);
});

test('E2B ending the sandbox stops the loop; a replacement session gets its own fresh loop', async () => {
  const r = rig();
  r.m.setSlotCount(1);
  await r.boot();
  await r.step();
  const [h] = r.timers.pending.values();
  r.sdk.vanish('sbx1');
  r.clock.t += HARD_STOP_MS + 10_000;
  await r.m.reconcileSandboxes();
  assert.equal(h.cleared, true);
  assert.equal(r.timers.pending.size, 0);
  await r.boot(); // what auto-restart does: startSandboxNow on the same slot
  assert.equal(r.m.activeLoopStatus().loops[0].sessionId, 'sbx2');
  await r.step();
  assert.equal(r.activity.typed.at(-1).sbx, 'sbx2');
});

test('a step that was mid-flight when the sandbox stopped does not type or reschedule', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const llm = fakeLiveLlm();
  const slow = { provider: { ...llm.provider, complete: async (req) => { await gate; return llm.provider.complete(req); } } };
  const r = rig({ llm: slow });
  r.m.setSlotCount(1);
  await r.boot();
  r.timers.fire();
  await r.m.stopSandbox('slot-0'); // while the model call is in flight
  release();
  await r.m.waitForLoopStep('slot-0');
  assert.equal(r.activity.typed.length, 0);
  assert.equal(r.timers.pending.size, 0);
});

test('retiring the slot and stopActiveLoops (shutdown) both stop it for good', async () => {
  const r = rig();
  r.m.setSlotCount(2);
  await r.boot('slot-1');
  r.m.setSlotCount(1);
  assert.equal(r.m.activeLoopStatus().loops.length, 0);
  const r2 = rig();
  r2.m.setSlotCount(1);
  await r2.boot();
  r2.m.stopActiveLoops();
  assert.equal(r2.timers.pending.size, 0);
  assert.equal(r2.m.activeLoopStatus().active, false);
});

test('per-session cap on model calls stops the loop with a feed line', async () => {
  const r = rig({ activeLoop: { maxThinkingPerSession: 1 } });
  r.m.setSlotCount(1);
  await r.boot();
  for (let i = 0; i < 4; i++) await r.step(); // thinking, experiment, failed, idle
  await r.step(); // would be thinking #2
  assert.equal(r.llm.calls.length, 1);
  assert.equal(r.m.getSlot('slot-0').feed.at(-1).type, 'sandbox-loop-stopped');
  assert.match(r.m.getSlot('slot-0').feed.at(-1).message, /cap of 1 model calls/);
  assert.equal(r.timers.pending.size, 0);
});

test('failed steps back off (always under the idle ceiling) and stop the loop after maxFailures', async () => {
  const r = rig({ activity: fakeActivity({ failType: 99 }), activeLoop: { maxFailures: 4 } });
  r.m.setSlotCount(1);
  await r.boot();
  const delays = [];
  for (let i = 0; i < 4; i++) delays.push(await r.step());
  assert.deepEqual(delays, [0, 10_000, 20_000, 40_000]);
  assert.ok(delays.every((d) => d < MAX_IDLE_MS));
  assert.equal(r.timers.pending.size, 0);
  const feed = r.m.getSlot('slot-0').feed;
  assert.equal(feed.at(-1).type, 'sandbox-loop-stopped');
  assert.equal(feed.filter((f) => f.type === 'sandbox-loop-error').length, 3);
});
