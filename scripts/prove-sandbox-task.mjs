#!/usr/bin/env node
// Live proof that a RAM's desktop sandbox visibly does its workbench task.
//
// Costs real money: ONE E2B desktop sandbox for about a minute (~$0.01), unless
// RAMHERD_KEEP_SANDBOX=yes, which leaves it running (until its E2B hard timeout,
// RAMHERD_SANDBOX_TIMEOUT_MIN, default 15 min) so someone can watch it live.
// Refuses to run unless RAMHERD_PROVE_SANDBOX_TASK=yes and E2B_API_KEY are set.
//
// Production code path: createSandboxManager().start() (x11vnc -viewonly + noVNC)
// via createSlotManager().startSandbox(), with sandbox-task.js's runWorkbenchTask
// and sandbox-context.js's contextBanner wired exactly as store.js wires them.
// A third screenshot ('later') is taken 20 s after the task ends, to show the
// context banner is still up once the typed commands are done. While the task runs it takes real desktop
// screenshots (scrot, through the SDK) and saves them as PNGs, and afterwards
// reads the terminal window's title and the clone's state back over the command
// channel, so the result is observed, not assumed.
//
// Usage: set -a; . ./.env; set +a; RAMHERD_PROVE_SANDBOX_TASK=yes node scripts/prove-sandbox-task.mjs [slotIndex] [outDir]

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandboxManager, estimateCostUsd, sandboxPolicy } from '../server/lib/sandbox.js';
import { runWorkbenchTask } from '../server/lib/sandbox-task.js';
import { contextBanner, BANNER_TITLE } from '../server/lib/sandbox-context.js';
import { createSlotManager } from '../server/lib/slots.js';
import { createMockLlmProvider } from '../server/lib/llm.js';

const apiKey = process.env.E2B_API_KEY;
if (process.env.RAMHERD_PROVE_SANDBOX_TASK !== 'yes' || !apiKey) {
  console.error('Refusing: set RAMHERD_PROVE_SANDBOX_TASK=yes and E2B_API_KEY (this bills real E2B time).');
  process.exit(2);
}
const keep = process.env.RAMHERD_KEEP_SANDBOX === 'yes';
const slotIndex = Number(process.argv[2] ?? 0);
const outDir = process.argv[3] ?? join(tmpdir(), 'ramherd-sandbox-task');
mkdirSync(outDir, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const redact = (s) => String(s).split(apiKey).join('[redacted]');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const policy = sandboxPolicy({ ...process.env, RAMHERD_SANDBOX: 'e2b' });
const manager = createSandboxManager({ apiKey, template: policy.template, timeoutMs: policy.timeoutMs, maxConcurrent: 1 });
const slots = createSlotManager({ llmProvider: createMockLlmProvider(), sandboxManager: manager, sandboxTask: runWorkbenchTask, sandboxContext: contextBanner });
slots.setSlotCount(slotIndex + 1);
const slot = slots.getSlots()[slotIndex];
log(`slot ${slot.id}: ${slot.assignment.track} (${slot.assignment.editablePath})`);

const t0 = Date.now();
let sessionId = null;
let resources = null;
let pass = false;
try {
  const snap = await slots.startSandbox(slot.id);
  sessionId = snap.sandbox.sessionId;
  log(`sandbox ${sessionId} up in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const { Sandbox } = await import('@e2b/desktop');
  const viewer = await Sandbox.connect(sessionId, { apiKey });
  try {
    const inf = await Sandbox.getInfo(sessionId, { apiKey });
    resources = { cpuCount: inf.cpuCount, memoryMB: inf.memoryMB };
  } catch { /* falls back to stock size below */ }

  const shot = async (name) => {
    const png = await viewer.screenshot('bytes');
    const path = join(outDir, `${sessionId}-${name}.png`);
    writeFileSync(path, Buffer.from(png));
    log(`screenshot ${path}`);
    return path;
  };

  // Screenshot mid-task (after the clone finished, while it is still typing) and at the end.
  const task = slots.waitForSandboxTask(slot.id);
  let midTaken = false;
  let finished = false;
  task.then(() => { finished = true; });
  while (!finished) {
    const steps = slots.getSlot(slot.id).feed.filter((f) => f.type === 'sandbox-task-step').length;
    if (!midTaken && steps >= 2) { await shot('mid'); midTaken = true; }
    await sleep(500);
  }
  await shot('end');
  // The context banner must outlive the workbench task: wait, then look again.
  await slots.waitForSandboxContext(slot.id);
  // One real research step after the workbench (mock LLM here): the banner's status line must follow it.
  await slots.advance(slot.id);
  await slots.waitForSandboxContext(slot.id);
  await sleep(20_000);
  await shot('later');

  const sh = async (cmd) => (await viewer.commands.run(cmd)).stdout.trim();
  const observed = {
    terminalWindows: await sh(`xdotool search --onlyvisible --name 'RAM workbench' getwindowname %@ 2>/dev/null || true`),
    focusedWindow: await sh('xdotool getwindowfocus getwindowname 2>/dev/null || true'),
    cloneHead: await sh('git -C ~/hash-smash log -1 --format="%H %s" 2>/dev/null || true'),
    exitsFile: await sh('tr "\\n" " " < /tmp/ramtask/exits 2>/dev/null || true'),
    contextBanner: await sh(`xdotool search --onlyvisible --name '^${BANNER_TITLE}$' getwindowgeometry %@ 2>/dev/null || true`),
    terminalGeometry: await sh(`xdotool search --onlyvisible --name 'RAM workbench' getwindowgeometry %@ 2>/dev/null || true`),
    workarea: await sh('xprop -root _NET_WORKAREA'),
    contextFile: await sh('cat /tmp/ramctx/context.json'),
    bashUnderTerminal: await sh('ps -o args= -C bash | grep -c "rcfile /tmp/ramtask/bashrc" || true'),
  };
  log('observed:', JSON.stringify(observed, null, 1));

  const feed = slots.getSlot(slot.id).feed;
  log('feed:');
  for (const f of feed) console.log(`   [${f.type}] ${f.message}`);
  pass = feed.some((f) => f.type === 'sandbox-task-done') && feed.some((f) => f.type === 'sandbox-context-started') && /Geometry: \d+x64/.test(observed.contextBanner) && observed.terminalWindows.includes('RAM workbench') && /^[0-9a-f]{40} /.test(observed.cloneHead);
  log(pass ? 'PASS' : 'FAIL');
  if (keep && pass) {
    const s = manager.getPublicStream(slot.id);
    log(`LEFT RUNNING for viewing: sandbox ${sessionId}, hard stop at ${s.expiresAt}`);
    log(`view-only stream: ${s.streamUrl}`);
  }
} catch (err) {
  log('ERROR:', redact(err?.message || err));
} finally {
  if (!(keep && pass)) {
    const stopped = await manager.stopAll();
    log('stopAll:', JSON.stringify(stopped));
    if (sessionId) {
      try {
        const { Sandbox } = await import('@e2b/desktop');
        await Sandbox.kill(sessionId, { apiKey });
      } catch { /* already gone */ }
    }
  }
  const ranSeconds = (Date.now() - t0) / 1000;
  const r = resources ?? { cpuCount: 8, memoryMB: 8192 };
  log(`ran ${ranSeconds.toFixed(1)} s at ${r.cpuCount} vCPU / ${r.memoryMB} MiB, est. cost $${estimateCostUsd({ seconds: ranSeconds, ...r }).toFixed(4)}${keep && pass ? ' so far (still running)' : ''}`);
  process.exitCode = pass ? 0 : 1;
  if (keep && pass) process.exit(); // leave the sandbox; E2B's hard timeout kills it
}
