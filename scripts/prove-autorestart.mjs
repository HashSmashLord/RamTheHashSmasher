#!/usr/bin/env node
// Live proof that a roster RAM's sandbox is automatically replaced after E2B's
// hard timeout kills it (RAMHERD_SANDBOX_AUTORESTART, see server/lib/slots.js).
//
// Costs real money: two E2B desktop sandboxes, back to back, about 3-4 minutes
// in total (~$0.03 at the stock 8 vCPU / 8 GiB). The first one is created with
// a 2-minute hard timeout and is left to DIE on E2B's side; nothing here kills
// it. The server's own reconcile timer (every 5 s here) notices, and the
// auto-restart starts the second one, which runs the workbench task and the
// context banner again. The script then screenshots the second desktop, checks
// over E2B's API that the first is really gone, switches auto-restart off and
// kills everything it started.
// Refuses to run unless RAMHERD_PROVE_AUTORESTART=yes and E2B_API_KEY are set.
//
// Production code path: createStore() with the env flags below, exactly as the
// server builds it (store.js -> sandbox.js manager -> slots.js), no fakes.
//
// Usage: set -a; . ./.env; set +a; RAMHERD_PROVE_AUTORESTART=yes node scripts/prove-autorestart.mjs [outDir]

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.js';
import { loadConfig } from '../server/config.js';
import { estimateCostUsd } from '../server/lib/sandbox.js';
import { BANNER_TITLE } from '../server/lib/sandbox-context.js';

const apiKey = process.env.E2B_API_KEY;
if (process.env.RAMHERD_PROVE_AUTORESTART !== 'yes' || !apiKey) {
  console.error('Refusing: set RAMHERD_PROVE_AUTORESTART=yes and E2B_API_KEY (this bills real E2B time).');
  process.exit(2);
}
const outDir = process.argv[2] ?? join(tmpdir(), 'ramherd-autorestart');
mkdirSync(outDir, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const redact = (s) => String(s).split(apiKey).join('[redacted]');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Only these flags: no live LLM, no pipeline, no launchpad. Short hard stop, fast reconcile.
const env = {
  RAMHERD_SANDBOX: 'e2b',
  E2B_API_KEY: apiKey,
  RAMHERD_SANDBOX_AUTORESTART: 'true',
  RAMHERD_SANDBOX_TIMEOUT_MIN: '2',
  RAMHERD_SANDBOX_RECONCILE_SEC: '5',
  RAMHERD_SANDBOX_MAX: '2',
};
const store = createStore({ budgetConfig: loadConfig({}).budget, env });
const slots = store.slotManager;
const { Sandbox } = await import('@e2b/desktop');

slots.setSlotCount(1);
const id = slots.getSlots()[0].id;
log(`auto-restart: ${JSON.stringify(slots.autoRestartStatus())}`);

const t0 = Date.now();
const sessions = [];
let pass = false;
try {
  const first = await slots.startSandbox(id);
  const a = first.sandbox.sessionId;
  sessions.push(a);
  log(`sandbox A ${a} up, hard stop at ${first.sandbox.expiresAt}; NOT stopping it, waiting for E2B to kill it`);
  await slots.waitForSandboxTask(id);
  log(`A workbench task finished: ${slots.getSlot(id).feed.filter((f) => f.type.startsWith('sandbox-task')).at(-1).message}`);

  // Wait (bounded) for: A expired by timeout, then a NEW running session.
  const deadline = Date.now() + 6 * 60_000;
  let b = null;
  while (Date.now() < deadline) {
    const sb = slots.getSlot(id).sandbox;
    if (sb?.status === 'running' && sb.sessionId !== a) { b = sb.sessionId; break; }
    await sleep(2000);
  }
  if (!b) throw new Error('no replacement sandbox appeared within 6 minutes');
  sessions.push(b);
  log(`sandbox B ${b} running (auto-restarted)`);

  await slots.waitForSandboxTask(id);
  await slots.waitForSandboxContext(id);
  const viewer = await Sandbox.connect(b, { apiKey });
  const png = await viewer.screenshot('bytes');
  const shotPath = join(outDir, `${b}-autorestarted.png`);
  writeFileSync(shotPath, Buffer.from(png));
  log(`screenshot ${shotPath}`);

  const sh = async (cmd) => (await viewer.commands.run(cmd)).stdout.trim();
  let aState;
  try { aState = (await Sandbox.getInfo(a, { apiKey })).state; } catch (err) { aState = `${err.name}: gone`; }
  const observed = {
    aOnE2B: aState,
    bOnE2B: (await Sandbox.getInfo(b, { apiKey })).state,
    bTerminal: await sh(`xdotool search --onlyvisible --name 'RAM workbench' getwindowname %@ 2>/dev/null || true`),
    bBanner: await sh(`xdotool search --onlyvisible --name '^${BANNER_TITLE}$' getwindowgeometry %@ 2>/dev/null || true`),
    bCloneHead: await sh('git -C ~/hash-smash log -1 --format="%H %s" 2>/dev/null || true'),
    bContext: await sh('cat /tmp/ramctx/context.json'),
  };
  log('observed:', JSON.stringify(observed, null, 1));

  const snap = slots.getSlot(id);
  log('feed:');
  for (const f of snap.feed) console.log(`   ${f.ts.slice(11, 19)} [${f.type}] ${f.message}`);
  const expired = snap.feed.find((f) => f.type === 'sandbox-expired' && f.message.includes(a));
  pass = Boolean(expired) && /hard stop/.test(expired.message)
    && snap.feed.some((f) => f.type === 'sandbox-autorestart-scheduled')
    && snap.feed.some((f) => f.type === 'sandbox-started' && f.message.includes(b))
    && snap.feed.some((f) => f.type === 'sandbox-task-done' && f.message.includes(b))
    && /gone|NotFound/i.test(observed.aOnE2B) && observed.bOnE2B === 'running'
    && observed.bTerminal.includes('RAM workbench') && /^[0-9a-f]{40} /.test(observed.bCloneHead);
  log(pass ? 'PASS' : 'FAIL');
} catch (err) {
  log('ERROR:', redact(err?.message || err));
} finally {
  slots.stopAutoRestart(); // nothing may restart after this point
  log('stopAll:', JSON.stringify(await store.sandboxManager.stopAll()));
  for (const s of sessions) {
    try { await Sandbox.kill(s, { apiKey }); } catch { /* already gone */ }
  }
  const ranSeconds = (Date.now() - t0) / 1000;
  log(`wall time ${ranSeconds.toFixed(1)} s with at most one sandbox up at a time, est. cost $${estimateCostUsd({ seconds: ranSeconds, cpuCount: 8, memoryMB: 8192 }).toFixed(4)}`);
  process.exitCode = pass ? 0 : 1;
}
