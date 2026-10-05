#!/usr/bin/env node
// Live proof of the always-on research loop (slots.js "Active loop",
// sandbox-activity.js): ONE real E2B desktop sandbox and REAL model calls.
//
// Costs real money: one E2B desktop sandbox for a few minutes (~$0.02-0.05)
// plus the slot's real roster model for at most RAMHERD_PROVE_LOOP_CALLS
// thinking calls (default 3). Refuses to run unless RAMHERD_PROVE_ACTIVE_LOOP=yes,
// E2B_API_KEY and OPENROUTER_API_KEY are set. Always kills the sandbox at the end.
//
// Production code path, wired as store.js wires it: createSandboxManager ->
// createSlotManager({ sandboxTask: runWorkbenchTask, sandboxContext:
// contextBanner, sandboxActivity: desktopActivity, activeLoop }) with the real
// OpenRouter provider (llm.js), the real HashSmash pipeline runner when the
// vendored repo is present (its workspaces go to a temp dir), and the
// production default pause between steps (nothing shortened). It waits for
// RAMHERD_PROVE_LOOP_STEPS loop steps (default 9: two full research cycles plus
// a third thinking step), screenshots the desktop after each step's typing,
// and reads back the saved notes file and the browser's window title.
//
// Usage: set -a; . ./.env; set +a; RAMHERD_PROVE_ACTIVE_LOOP=yes node scripts/prove-active-loop.mjs [slotIndex] [outDir]

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandboxManager, estimateCostUsd, sandboxPolicy } from '../server/lib/sandbox.js';
import { runWorkbenchTask } from '../server/lib/sandbox-task.js';
import { contextBanner } from '../server/lib/sandbox-context.js';
import { desktopActivity, notesFile, MAX_IDLE_MS } from '../server/lib/sandbox-activity.js';
import { createSlotManager } from '../server/lib/slots.js';
import { createLlmProvider, isLiveMode } from '../server/lib/llm.js';
import { createCostLedger } from '../server/lib/cost.js';
import { createHashSmashRunner } from '../server/lib/hashsmash.js';

const apiKey = process.env.E2B_API_KEY;
if (process.env.RAMHERD_PROVE_ACTIVE_LOOP !== 'yes' || !apiKey || !process.env.OPENROUTER_API_KEY) {
  console.error('Refusing: set RAMHERD_PROVE_ACTIVE_LOOP=yes, E2B_API_KEY and OPENROUTER_API_KEY (this bills real E2B time and real model calls).');
  process.exit(2);
}
const slotIndex = Number(process.argv[2] ?? 0);
const outDir = process.argv[3] ?? join(tmpdir(), 'ramherd-active-loop');
const wantSteps = Number(process.env.RAMHERD_PROVE_LOOP_STEPS ?? 9);
const maxCalls = Number(process.env.RAMHERD_PROVE_LOOP_CALLS ?? 3);
mkdirSync(outDir, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const redact = (s) => [apiKey, process.env.OPENROUTER_API_KEY].reduce((t, k) => t.split(k).join('[redacted]'), String(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = { ...process.env, RAMHERD_LIVE: 'true' }; // the proof is explicitly live
if (!isLiveMode(env)) throw new Error('not live');
const llmProvider = createLlmProvider(env);
const costLedger = createCostLedger();
let pipelineRunner = createHashSmashRunner({ judgeAllowed: false, env, workspacesDir: join(outDir, 'workspaces') });
const pf = await pipelineRunner.preflight();
if (!pf.ok) { log('pipeline not available here, slot uses the no-runner path:', pf.problems.join('; ')); pipelineRunner = null; }

const policy = sandboxPolicy({ ...process.env, RAMHERD_SANDBOX: 'e2b', RAMHERD_SANDBOX_ACTIVE_LOOP: 'true' });
const manager = createSandboxManager({ apiKey, template: policy.template, timeoutMs: 15 * 60_000, maxConcurrent: 1 });
const slots = createSlotManager({
  llmProvider, pipelineRunner, costLedger, sandboxManager: manager,
  sandboxTask: runWorkbenchTask, sandboxContext: contextBanner, sandboxActivity: desktopActivity,
  activeLoop: { enabled: true, live: true, stepPauseMs: policy.activeLoopStepPauseMs, browseEvery: policy.activeLoopBrowseEvery, maxThinkingPerSession: maxCalls },
});
slots.setSlotCount(slotIndex + 1);
const slot = slots.getSlots()[slotIndex];
log(`slot ${slot.id}: ${slot.assignment.track}, model ${slot.assignment.model}, pause ${policy.activeLoopStepPauseMs} ms, browse every ${policy.activeLoopBrowseEvery} thinking steps, cap ${maxCalls} calls`);

const t0 = Date.now();
let sessionId = null;
let resources = null;
let pass = false;
const statusTimeline = [];
try {
  const snap = await slots.startSandbox(slot.id);
  sessionId = snap.sandbox.sessionId;
  log(`sandbox ${sessionId} up in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const { Sandbox } = await import('@e2b/desktop');
  const viewer = await Sandbox.connect(sessionId, { apiKey });
  try { const inf = await Sandbox.getInfo(sessionId, { apiKey }); resources = { cpuCount: inf.cpuCount, memoryMB: inf.memoryMB }; } catch { /* stock size below */ }
  const shot = async (name) => {
    const path = join(outDir, `${sessionId}-${name}.png`);
    writeFileSync(path, Buffer.from(await viewer.screenshot('bytes')));
    log(`screenshot ${path}`);
  };

  await slots.waitForSandboxTask(slot.id);
  log('workbench done; loop status:', JSON.stringify(slots.activeLoopStatus().loops.map((l) => l.slotId)));
  let seen = 0;
  const deadline = Date.now() + 10 * 60_000;
  while (seen < wantSteps && Date.now() < deadline) {
    const loop = slots.activeLoopStatus().loops[0];
    if (!loop) { log('loop is no longer running'); break; }
    if (loop.steps > seen) {
      await slots.waitForLoopStep(slot.id); // its typing (and any browse) has finished
      const s = slots.getSlot(slot.id);
      const h = slots.activeLoopStatus().loops[0]?.history ?? loop.history;
      for (const step of h.slice(seen)) statusTimeline.push({ ...step, observedStatus: s.status });
      seen = h.length;
      const last = h.at(-1);
      log(`step ${seen}: ${last.statusBefore} -> ${last.statusAfter} (advance took ${last.advanceMs} ms); slot.status now ${s.status}`);
      const browsed = s.feed.at(-1).type === 'sandbox-browse';
      await shot(`step${String(seen).padStart(2, '0')}-${last.statusAfter}${browsed ? '-browse' : ''}`);
      if (browsed) {
        // The browse leaves Chrome in front; also show the notes editor itself.
        await viewer.commands.run('xdotool search --onlyvisible --name ram-notes windowactivate 2>/dev/null || true');
        await sleep(800);
        await shot(`step${String(seen).padStart(2, '0')}-notes`);
      }
    }
    await sleep(250);
  }

  const sh = async (cmd) => (await viewer.commands.run(cmd)).stdout.trim();
  const notes = await sh(`cat ${notesFile(slot.assignment)} 2>/dev/null || true`);
  writeFileSync(join(outDir, `${sessionId}-notes.txt`), notes);
  const observed = {
    editorWindows: await sh("xdotool search --onlyvisible --name 'ram-notes' getwindowname %@ 2>/dev/null || true"),
    chromeWindows: await sh('xdotool search --onlyvisible --class google-chrome getwindowname %@ 2>/dev/null || true'),
    banner: await sh('cat /tmp/ramctx/context.json'),
  };
  log('observed:', JSON.stringify(observed, null, 1));
  log('notes file, as saved by the editor:\n' + notes);

  const final = slots.getSlot(slot.id);
  log('feed:');
  for (const f of final.feed) console.log(`   ${f.ts.slice(11, 19)} [${f.type}] ${f.message}`);
  const st = slots.activeLoopStatus().loops[0];
  const thinking = final.feed.filter((f) => f.type === 'thinking');
  const typedAll = thinking.every((f) => notes.replace(/\s+/g, ' ').includes(f.message.replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)));
  const statuses = statusTimeline.map((s) => s.statusAfter);
  log('status timeline:', statuses.join(' -> '));
  log(`max gap between steps: ${st?.maxGapMs ?? 'n/a'} ms (ceiling ${MAX_IDLE_MS} ms); unverified typings: ${st?.unverifiedTyping ?? 'n/a'}; browses: ${st?.browses ?? 0}`);
  const totals = costLedger.totals();
  log(`model cost: ${totals.calls} calls, ${totals.totalTokens} tokens, $${totals.costUsd.toFixed(6)} (${totals.costUnknownCalls} calls without a reported cost)`);
  pass = thinking.length >= 2 && typedAll && new Set(statuses).size >= 3 && (st?.maxGapMs ?? Infinity) < MAX_IDLE_MS;
  log(pass ? 'PASS' : 'FAIL');
} catch (err) {
  log('ERROR:', redact(err?.stack || err?.message || err));
} finally {
  slots.stopActiveLoops();
  const stopped = await manager.stopAll();
  log('stopAll:', JSON.stringify(stopped));
  if (sessionId) {
    try { const { Sandbox } = await import('@e2b/desktop'); await Sandbox.kill(sessionId, { apiKey }); } catch { /* already gone */ }
  }
  const ranSeconds = (Date.now() - t0) / 1000;
  const r = resources ?? { cpuCount: 8, memoryMB: 8192 };
  log(`ran ${ranSeconds.toFixed(1)} s at ${r.cpuCount} vCPU / ${r.memoryMB} MiB, est. E2B cost $${estimateCostUsd({ seconds: ranSeconds, ...r }).toFixed(4)}`);
  process.exitCode = pass ? 0 : 1;
}
