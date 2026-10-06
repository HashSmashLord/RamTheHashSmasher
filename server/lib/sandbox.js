// E2B desktop sandbox per RAM slot: lifecycle plumbing only.
//
// What this module does: create ONE E2B Desktop sandbox (template `desktop`:
// Ubuntu + Xfce, VNC via x11vnc, browser view via noVNC on port 6080) for a
// given RAM slot, start its VNC stream with a per-sandbox password, hand back
// what a frontend needs to embed it, and kill it. What runs inside is
// server/lib/sandbox-task.js; see "What runs inside today" below.
//
// API shape (from @e2b/desktop 2.4.0's own source, not guessed):
//   const sbx = await Sandbox.create(template, { apiKey, timeoutMs, metadata, lifecycle, resolution })
//     (the SDK itself starts Xvfb + Xfce on display :0 inside create)
//   await sbx.commands.run(cmd[, { background, timeoutMs }])
//   sbx.getHost(6080) -> "6080-<sandboxId>.e2b.app"
//   await sbx.kill()                                 // or Sandbox.kill(sandboxId, { apiKey })
//   If anything in create's own setup fails, the SDK kills the sandbox itself.
//
// SERVER-SIDE VIEW-ONLY (why this module does NOT call sbx.stream.start()):
//   The stock `desktop` template only INSTALLS x11vnc / noVNC / websockify; it
//   starts none of them at boot (checked against e2b-dev/desktop's template
//   definition). They are launched at runtime by the SDK's stream.start(), which
//   runs `x11vnc -bg ... -shared -usepw` with NO -viewonly. Its getUrl({viewOnly})
//   only adds noVNC's `view_only=true` page parameter: the RFB connection behind
//   it still accepts pointer/key events, so anyone holding the URL could drop
//   that parameter and drive the desktop.
//   So this module launches x11vnc itself, through the same authenticated
//   command channel, with `-viewonly`: x11vnc then discards every pointer, key
//   and clipboard message from every client, whatever the client sends. Plus
//   `-localhost` (RFB port 5900 reachable only from inside the sandbox, i.e. by
//   noVNC's websockify), `-nosel` (no clipboard exchange at all) and `-noremote`
//   (no x11vnc remote-control commands). After launching it reads back the real
//   x11vnc command line (`ps`) and refuses (kills the sandbox) unless exactly
//   one x11vnc is running and it carries those flags. No full-control VNC
//   listener exists at all; if an admin ever needs to drive the desktop, that
//   goes through the SDK's own authenticated xdotool calls from the server,
//   never through a URL. A custom E2B template is NOT needed for this (the
//   template has no VNC autostart to override); one is still the right next
//   step for COST (smaller vCPU/RAM), see below.
//   Proven against a real sandbox with raw RFB input events: see
//   scripts/prove-viewonly.mjs and README "E2B desktop sandboxes".
//
// Cost rails (E2B bills per second while a sandbox is running):
//   - Off unless RAMHERD_SANDBOX=e2b. Without it no manager is built, the SDK is
//     never imported and no network call is made, even with E2B_API_KEY set.
//   - Sandboxes are only created by an explicit start(slotId) call (an admin
//     route); nothing auto-starts one on slot activation. The one exception is
//     opt-in auto-restart (RAMHERD_SANDBOX_AUTORESTART=true, off by default):
//     when E2B ends an active ROSTER slot's sandbox at its hard timeout,
//     slots.js starts a fresh one for it, with backoff and a give-up limit on
//     repeated failures. See "Auto-restart" in slots.js.
//   - Every sandbox is created with a hard E2B-side timeout (default 15 min,
//     RAMHERD_SANDBOX_TIMEOUT_MIN) and lifecycle onTimeout 'kill', so it dies
//     even if this process crashes and never calls stop().
//   - A concurrency cap (RAMHERD_SANDBOX_MAX, default 6) well under the plan's 100.
//   - Retiring a slot stops its sandbox; app shutdown calls stopAll().
//   - Measured 2026-10-05 (one real run): the public `desktop` template comes up
//     at 8 vCPU / 8 GiB, the plan's per-sandbox max, so ~$0.53/hour each at the
//     rates below (~$12.8/day per always-on RAM). A smaller custom template built
//     from `desktop` (E2B Template builder, e.g. 2 vCPU / 4 GiB, ~$0.17/hour) is
//     the obvious next step before running sandboxes for real; set its name via
//     RAMHERD_SANDBOX_TEMPLATE.
//
// Knowing when E2B ended a sandbox on its own (its hard timeout, or anything
// else on E2B's side): nothing tells this process when that happens, so while
// any sandbox is live the manager asks E2B every `reconcileMs` (default 15 s)
// whether each one still exists. `Sandbox.getInfo(id)` (e2b SDK, GET
// /sandboxes/{id}) answers with the sandbox's state, or throws
// SandboxNotFoundError (HTTP 404) once it is gone. A sandbox that is gone, or
// no longer `running`, is dropped from `live` and reported through
// `onEnded(listener)` with `endedBy: 'timeout'` when its hard stop had been
// reached, else `'provider'`. stop() does the same when it finds the sandbox
// already gone (the SDK's kill returns false on 404): its result then carries
// `alreadyGone: true` and the same `endedBy`. Before this (2026-10-05) a
// timeout-killed sandbox stayed "running" here forever and the public stream
// route kept handing out its dead URL. A transient getInfo error (network,
// 5xx) changes nothing; the next tick asks again. The timer only runs while
// something is live and never keeps the process alive (unref).
//
// Secrets: the API key is read from the env object passed in and handed to the
// SDK. It is never logged, never stored on a returned object, and scrubbed out
// of any error message before that message is surfaced.
//
// The stream URL carries the VNC password. With server-side -viewonly that
// password only ever grants WATCHING (there is no password, URL or port that
// grants control), so the view-only URL may be handed to the public frontend via
// getPublicStream(). It is still kept out of the slot snapshot itself.
//
// What runs inside today: on start, slots.js runs server/lib/sandbox-task.js
// through runTask(): a visible terminal that clones the real HashSmash repo,
// opens this slot's track and candidate, and runs the organizer's mechanical
// check, typed live. What will run inside next (NOT built here):
// the sandbox becomes the RAM's actual workbench. Its slot's research cycle
// (today in slots.js / hashsmash.js on the host) would run in a visible
// terminal on the sandbox desktop: clone the HashSmash repo, write/iterate a
// candidate, run `local_tracks.py check` and `hashsmash_pipeline.py intake`
// (and Docker-backed experiments, which this Mac can't run), with a browser
// window opened when the RAM researches (papers, the HashSmash rules/tracks).
// The host keeps the append-only feed and the HashSmash verdicts; the desktop
// is the watchable picture of the same work. Keys stay on the host: the LLM
// calls are made by the host, never from inside the sandbox.

import { randomInt } from 'node:crypto';
import { DEFAULT_STEP_PAUSE_SEC, MIN_STEP_PAUSE_SEC, MAX_STEP_PAUSE_SEC, DEFAULT_BROWSE_EVERY, DEFAULT_MAX_THINKING_PER_SESSION, DEFAULT_MAX_DRAFT_ATTEMPTS_PER_SESSION } from './sandbox-activity.js';

const DEFAULT_TEMPLATE = 'desktop';
const DEFAULT_TIMEOUT_MIN = 15;
const MAX_TIMEOUT_MIN = 24 * 60; // Pro plan session cap
const DEFAULT_MAX_CONCURRENT = 6;
const PLAN_MAX_CONCURRENT = 100;
const DEFAULT_RECONCILE_MS = 15_000;
// Auto-restart backoff (slots.js): first retry after a failed restart waits the
// base delay, each further one doubles it up to the cap; after maxFailures
// consecutive failed restarts for one slot it stops trying.
const DEFAULT_RESTART_BASE_DELAY_SEC = 30;
const RESTART_MAX_DELAY_MS = 10 * 60_000;
const DEFAULT_RESTART_MAX_FAILURES = 5;
// A sandbox found gone this close to (or after) its hard stop ended by that timeout.
const TIMEOUT_SLACK_MS = 30_000;

// E2B published usage rates (e2b.dev/pricing, checked 2026-10-05).
export const E2B_RATES = Object.freeze({ usdPerVcpuSecond: 0.000014, usdPerGibSecond: 0.0000045 });

/** Rough cost of a sandbox that ran `seconds` with the given resources. */
export function estimateCostUsd({ seconds, cpuCount, memoryMB }) {
  const gib = memoryMB / 1024;
  return seconds * (cpuCount * E2B_RATES.usdPerVcpuSecond + gib * E2B_RATES.usdPerGibSecond);
}

export const VNC_PORT = 5900;
export const NOVNC_PORT = 6080;

/** Flags that must be on the running x11vnc, or the sandbox is killed. */
export const REQUIRED_X11VNC_FLAGS = Object.freeze(['-viewonly', '-localhost', '-nosel', '-noremote', '-usepw']);

const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** 8 chars: the classic VNC (DES) auth only ever uses the first 8. */
export function vncPassword() {
  let out = '';
  for (let i = 0; i < 8; i++) out += PW_ALPHABET[randomInt(PW_ALPHABET.length)];
  return out;
}

/** The x11vnc command this module runs: server-side view-only, local RFB only. */
export function viewOnlyX11vncCommand(display = ':0') {
  return [
    'x11vnc -bg -forever -shared -wait 50',
    `-display ${display}`,
    `-rfbport ${VNC_PORT}`,
    ...REQUIRED_X11VNC_FLAGS,
    '-o /tmp/x11vnc.log',
  ].join(' ');
}

const NOVNC_COMMAND = `cd /opt/noVNC/utils && ./novnc_proxy --vnc localhost:${VNC_PORT} --listen ${NOVNC_PORT} --web /opt/noVNC > /tmp/novnc.log 2>&1`;
const WAIT_NOVNC = `for i in $(seq 1 75); do (ss -ltn 2>/dev/null || netstat -tln 2>/dev/null) | grep -q ":${NOVNC_PORT} " && exit 0; sleep 0.2; done; exit 1`;

/**
 * Checks `ps` output listing every running x11vnc command line. Returns null if
 * it is exactly one process carrying every required flag, else the reason.
 * @param {string} psOut
 */
export function checkX11vncProcesses(psOut) {
  const lines = String(psOut).split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length !== 1) return `expected exactly one x11vnc, found ${lines.length}`;
  const args = lines[0].split(/\s+/);
  const missing = REQUIRED_X11VNC_FLAGS.filter((f) => !args.includes(f));
  return missing.length ? `x11vnc is missing ${missing.join(' ')}` : null;
}

function intInRange(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/**
 * Reads the env once. `enabled` is true only for RAMHERD_SANDBOX=e2b exactly.
 * `ready` additionally needs a key. The key itself is not part of the result.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function sandboxPolicy(env = process.env) {
  const enabled = env.RAMHERD_SANDBOX === 'e2b';
  const hasKey = typeof env.E2B_API_KEY === 'string' && env.E2B_API_KEY.trim() !== '';
  return Object.freeze({
    provider: enabled ? 'e2b' : null,
    enabled,
    hasKey,
    ready: enabled && hasKey,
    template: env.RAMHERD_SANDBOX_TEMPLATE?.trim() || DEFAULT_TEMPLATE,
    timeoutMs: intInRange(env.RAMHERD_SANDBOX_TIMEOUT_MIN, DEFAULT_TIMEOUT_MIN, 1, MAX_TIMEOUT_MIN) * 60_000,
    maxConcurrent: intInRange(env.RAMHERD_SANDBOX_MAX, DEFAULT_MAX_CONCURRENT, 1, PLAN_MAX_CONCURRENT),
    // How often (seconds) to ask E2B whether live sandboxes still run; 0 turns the check off.
    reconcileMs: intInRange(env.RAMHERD_SANDBOX_RECONCILE_SEC, DEFAULT_RECONCILE_MS / 1000, 0, 3600) * 1000,
    // Auto-restart of a roster RAM's sandbox after E2B's hard timeout ended it.
    // Off unless RAMHERD_SANDBOX_AUTORESTART=true exactly (each restart bills).
    autoRestart: enabled && env.RAMHERD_SANDBOX_AUTORESTART === 'true',
    autoRestartBaseDelayMs: intInRange(env.RAMHERD_SANDBOX_AUTORESTART_BACKOFF_SEC, DEFAULT_RESTART_BASE_DELAY_SEC, 1, 3600) * 1000,
    autoRestartMaxDelayMs: RESTART_MAX_DELAY_MS,
    autoRestartMaxFailures: intInRange(env.RAMHERD_SANDBOX_AUTORESTART_MAX_FAILURES, DEFAULT_RESTART_MAX_FAILURES, 1, 20),
    // Always-on research loop (slots.js "Active loop"): drives a roster RAM's
    // real advance() back to back while its sandbox runs and types each step on
    // the desktop. Off unless RAMHERD_SANDBOX_ACTIVE_LOOP=true exactly (each
    // thinking step is a real, billed model call when live). The pause between
    // steps is clamped to 2..30 s so the RAM never idles a minute; an
    // out-of-range value falls back to the default 5 s.
    activeLoop: enabled && env.RAMHERD_SANDBOX_ACTIVE_LOOP === 'true',
    activeLoopStepPauseMs: intInRange(env.RAMHERD_SANDBOX_ACTIVE_LOOP_PAUSE_SEC, DEFAULT_STEP_PAUSE_SEC, MIN_STEP_PAUSE_SEC, MAX_STEP_PAUSE_SEC) * 1000,
    activeLoopBrowseEvery: intInRange(env.RAMHERD_SANDBOX_ACTIVE_LOOP_BROWSE_EVERY, DEFAULT_BROWSE_EVERY, 1, 100),
    activeLoopMaxThinking: intInRange(env.RAMHERD_SANDBOX_ACTIVE_LOOP_MAX_CALLS, DEFAULT_MAX_THINKING_PER_SESSION, 1, 1000),
    // Bounded, separate cap on the loop's rarer "do you really have
    // something to draft" call (slots.js's runLoopDraftAttempt). Kept small
    // and apart from activeLoopMaxThinking on purpose.
    activeLoopMaxDraftAttempts: intInRange(env.RAMHERD_SANDBOX_ACTIVE_LOOP_MAX_DRAFT_ATTEMPTS, DEFAULT_MAX_DRAFT_ATTEMPTS_PER_SESSION, 1, 50),
  });
}

function scrub(message, apiKey) {
  let text = String(message ?? 'unknown error');
  if (apiKey) text = text.split(apiKey).join('[redacted]');
  return text.replace(/e2b_[A-Za-z0-9]{8,}/g, '[redacted]').slice(0, 500);
}

/**
 * @param {{
 *   apiKey: string,
 *   template?: string,
 *   timeoutMs?: number,
 *   maxConcurrent?: number,
 *   resolution?: [number, number],
 *   reconcileMs?: number,
 *   loadSdk?: () => Promise<{ Sandbox: any }>,
 *   now?: () => number,
 * }} opts
 */
export function createSandboxManager({
  apiKey,
  template = DEFAULT_TEMPLATE,
  timeoutMs = DEFAULT_TIMEOUT_MIN * 60_000,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  resolution = [1280, 800],
  reconcileMs = DEFAULT_RECONCILE_MS,
  loadSdk = () => import('@e2b/desktop'),
  now = () => Date.now(),
}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new TypeError('createSandboxManager requires an E2B api key');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MIN * 60_000) {
    throw new RangeError('timeoutMs must be a positive integer of at most 24h');
  }
  if (!Number.isInteger(reconcileMs) || reconcileMs < 0) {
    throw new RangeError('reconcileMs must be a non-negative integer (0 disables the periodic check)');
  }

  /** slotId -> { sbx, info, streamUrl } */
  const live = new Map();
  /** slotId -> in-flight start promise (prevents double creates for one slot) */
  const starting = new Map();
  /** slotIds exempt from maxConcurrent: a real launched RAM's own sandbox,
   * never competing with the roster for the same small cap. Still a real
   * sandbox billing real money either way -- this exempts it from the COUNT,
   * not from existing. See slots.js's startSandboxNow, which passes this for
   * any slot.kind === 'owned'. */
  const exempt = new Set();
  function nonExemptCount() {
    let n = 0;
    for (const id of live.keys()) if (!exempt.has(id)) n++;
    for (const id of starting.keys()) if (!exempt.has(id)) n++;
    return n;
  }
  /** listeners told when E2B ended a sandbox that this manager did not stop */
  const endedListeners = new Set();
  let sdkPromise = null;
  let watch = null;
  let reconciling = null;

  const sdk = () => (sdkPromise ??= loadSdk());
  const iso = (ms) => new Date(ms).toISOString();

  /** The periodic E2B check runs only while a sandbox is live. */
  function syncWatch() {
    if (live.size > 0 && !watch && reconcileMs > 0) {
      watch = setInterval(() => { reconcile().catch(() => {}); }, reconcileMs);
      watch.unref?.();
    } else if (live.size === 0 && watch) {
      clearInterval(watch);
      watch = null;
    }
  }

  /** How a sandbox that E2B ended on its own went, given when it was found gone. */
  function endedDetails(entry, noticedMs) {
    const startedMs = Date.parse(entry.info.startedAt);
    const expiresMs = Date.parse(entry.info.expiresAt);
    const byTimeout = noticedMs >= expiresMs - TIMEOUT_SLACK_MS;
    const endedMs = byTimeout ? Math.min(expiresMs, noticedMs) : noticedMs;
    return {
      sessionId: entry.info.sessionId,
      endedBy: byTimeout ? 'timeout' : 'provider',
      endedAt: iso(endedMs),
      noticedAt: iso(noticedMs),
      ranSeconds: Math.max(0, (endedMs - startedMs) / 1000),
    };
  }

  /** Asks E2B about one sandbox: 'running', 'gone', or 'unknown' (could not tell this time). */
  async function checkOne(entry) {
    const { Sandbox } = await sdk();
    if (typeof Sandbox.getInfo !== 'function') return 'unknown';
    try {
      const info = await Sandbox.getInfo(entry.info.sessionId, { apiKey });
      return info?.state === 'running' ? 'running' : 'gone';
    } catch (err) {
      return err?.name === 'SandboxNotFoundError' || /not found/i.test(String(err?.message)) ? 'gone' : 'unknown';
    }
  }

  function dropEnded(slotId, entry, details) {
    live.delete(slotId);
    syncWatch();
    for (const listener of endedListeners) {
      try { listener(slotId, details); } catch { /* a listener's error is its own */ }
    }
  }

  async function createFor(slotId) {
    const { Sandbox } = await sdk();
    const startedMs = now();
    let sbx;
    try {
      sbx = await Sandbox.create(template, {
        apiKey,
        timeoutMs,
        resolution,
        metadata: { app: 'ramherd', slotId },
        lifecycle: { onTimeout: 'kill', autoResume: false },
      });
    } catch (err) {
      throw new Error(`E2B sandbox create failed: ${scrub(err?.message, apiKey)}`);
    }
    try {
      const streamUrl = await startViewOnlyStream(sbx);
      const info = Object.freeze({
        provider: 'e2b',
        sessionId: sbx.sandboxId,
        template,
        startedAt: iso(startedMs),
        expiresAt: iso(startedMs + timeoutMs),
      });
      live.set(slotId, { sbx, info, streamUrl });
      syncWatch();
      return info;
    } catch (err) {
      // Never leave a half-started (or not-provably-view-only) sandbox billing.
      await sbx.kill().catch(() => {});
      throw new Error(`E2B stream start failed (sandbox killed): ${scrub(err?.message, apiKey)}`);
    }
  }

  /** Launches x11vnc -viewonly + noVNC inside `sbx`, verifies it, returns the page URL. */
  async function startViewOnlyStream(sbx) {
    const run = (cmd, opts) => sbx.commands.run(cmd, opts);
    const password = vncPassword();
    // Nothing else may be serving VNC on this desktop (the template autostarts
    // none today; this makes sure of it if that ever changes).
    await run('pkill -x x11vnc || true');
    await run(`mkdir -p ~/.vnc && x11vnc -storepasswd ${password} ~/.vnc/passwd >/dev/null 2>&1`);
    await run(viewOnlyX11vncCommand(sbx.display || ':0'));
    const ps = await run('ps -C x11vnc -o args= || true');
    const problem = checkX11vncProcesses(ps?.stdout ?? '');
    if (problem) throw new Error(`refusing stream, view-only not enforced: ${problem}`);
    await run(NOVNC_COMMAND, { background: true, timeoutMs: 0 });
    await run(WAIT_NOVNC);
    const url = new URL(`https://${sbx.getHost(NOVNC_PORT)}/vnc.html`);
    url.searchParams.set('autoconnect', 'true');
    url.searchParams.set('view_only', 'true'); // hides noVNC's input UI; the server enforces it regardless
    url.searchParams.set('resize', 'scale');
    url.searchParams.set('password', password);
    return url.toString();
  }

  /**
   * Creates a desktop sandbox for `slotId` and starts its view-only VNC stream. Returns
   * public session info (no URL, no password). Idempotent per slot: a second
   * call while one is live or starting returns the same session.
   *
   * @param {string} slotId
   * @param {{ exempt?: boolean }} [opts] exempt: true keeps this slot's sandbox
   *   out of the maxConcurrent count entirely (a real launched RAM's own
   *   sandbox; see the `exempt` Set above). Each call's own exempt flag is
   *   remembered for stop()/counts even though start() itself is the only
   *   place a caller passes it.
   */
  async function start(slotId, { exempt: isExempt = false } = {}) {
    if (typeof slotId !== 'string' || !slotId) throw new TypeError('slotId is required');
    if (isExempt) exempt.add(slotId);
    if (live.has(slotId)) return live.get(slotId).info;
    if (starting.has(slotId)) return starting.get(slotId);
    if (!isExempt && nonExemptCount() >= maxConcurrent) {
      throw new Error(`sandbox limit reached (${maxConcurrent} running); stop one first`);
    }
    const p = createFor(slotId).finally(() => starting.delete(slotId));
    starting.set(slotId, p);
    return p;
  }

  /**
   * Kills the slot's sandbox. Returns stop details, or null if it had none.
   * If E2B had already ended it (hard timeout), the result says so:
   * `alreadyGone: true` plus the same `endedBy`/`endedAt`/`ranSeconds` the
   * reconcile check reports, instead of counting the dead time as a run.
   * @param {string} slotId
   */
  async function stop(slotId) {
    const pending = starting.get(slotId);
    if (pending) await pending.catch(() => {});
    const entry = live.get(slotId);
    if (!entry) return null;
    live.delete(slotId);
    exempt.delete(slotId);
    syncWatch();
    const stoppedMs = now();
    // The SDK's kill answers false (no throw) when E2B no longer has the sandbox.
    let found;
    try {
      found = await entry.sbx.kill();
    } catch (err) {
      // Fall back to the static API kill by id before giving up.
      try {
        const { Sandbox } = await sdk();
        found = await Sandbox.kill(entry.info.sessionId, { apiKey });
      } catch {
        throw new Error(`E2B sandbox kill failed for ${entry.info.sessionId}: ${scrub(err?.message, apiKey)}`);
      }
    }
    if (found === false) return { ...endedDetails(entry, stoppedMs), stoppedAt: iso(stoppedMs), alreadyGone: true };
    return {
      sessionId: entry.info.sessionId,
      stoppedAt: iso(stoppedMs),
      ranSeconds: Math.max(0, (stoppedMs - Date.parse(entry.info.startedAt)) / 1000),
      alreadyGone: false,
    };
  }

  async function stopAll() {
    const ids = [...new Set([...live.keys(), ...starting.keys()])];
    const results = await Promise.allSettled(ids.map((id) => stop(id)));
    return results.map((r, i) => ({ slotId: ids[i], ok: r.status === 'fulfilled', ...(r.status === 'rejected' ? { error: r.reason.message } : r.value) }));
  }

  /**
   * Asks E2B whether every live sandbox still runs; drops the ones that do
   * not and tells the `onEnded` listeners. Runs on the timer while anything is
   * live; callable directly (tests, operators). Concurrent calls share one run.
   * Resolves with what ended this time: `[{ slotId, ...details }]`.
   */
  function reconcile() {
    if (reconciling) return reconciling;
    reconciling = (async () => {
      const ended = [];
      for (const [slotId, entry] of [...live]) {
        const verdict = await checkOne(entry);
        if (verdict !== 'gone' || live.get(slotId) !== entry) continue; // still there, unknown, or stopped meanwhile
        const details = endedDetails(entry, now());
        dropEnded(slotId, entry, details);
        ended.push({ slotId, ...details });
      }
      return ended;
    })().finally(() => { reconciling = null; });
    return reconciling;
  }

  /**
   * Subscribes to sandboxes that E2B ended without a stop() from here.
   * `listener(slotId, { sessionId, endedBy: 'timeout'|'provider', endedAt, noticedAt, ranSeconds })`.
   * Returns the unsubscribe function.
   */
  function onEnded(listener) {
    if (typeof listener !== 'function') throw new TypeError('onEnded needs a function');
    endedListeners.add(listener);
    return () => endedListeners.delete(listener);
  }

  /** Public session info for a slot, or null. */
  function get(slotId) {
    return live.get(slotId)?.info ?? null;
  }

  /**
   * The embeddable stream URL (contains the VNC password, which only grants
   * watching) plus session details, for the admin route.
   */
  function getStream(slotId) {
    const entry = live.get(slotId);
    return entry ? { ...entry.info, streamUrl: entry.streamUrl, viewOnly: 'server', enforcedBy: 'x11vnc -viewonly' } : null;
  }

  /**
   * What the public viewer gets: the server-side view-only stream and nothing
   * else (no template, no internal timings). Only ever the -viewonly URL.
   */
  function getPublicStream(slotId) {
    const entry = live.get(slotId);
    if (!entry) return null;
    return { sessionId: entry.info.sessionId, streamUrl: entry.streamUrl, viewOnly: 'server', expiresAt: entry.info.expiresAt };
  }

  function count() {
    return live.size;
  }

  /**
   * Runs `task(sbx, { isLive })` against the slot's live sandbox. The SDK
   * instance never leaves this module otherwise; `isLive()` turns false once
   * the slot's sandbox is stopped, so a long task can bail out. Errors are
   * scrubbed of the API key like every other surfaced message.
   *
   * @template T
   * @param {string} slotId
   * @param {(sbx: any, ctx: { isLive: () => boolean }) => Promise<T>} task
   * @returns {Promise<T>}
   */
  async function runTask(slotId, task) {
    const entry = live.get(slotId);
    if (!entry) throw new Error(`no running sandbox for slot ${slotId}`);
    try {
      return await task(entry.sbx, { isLive: () => live.get(slotId) === entry });
    } catch (err) {
      throw new Error(scrub(err?.message, apiKey));
    }
  }

  return Object.freeze({ provider: 'e2b', start, stop, stopAll, get, getStream, getPublicStream, count, runTask, reconcile, onEnded, get watching() { return watch !== null; } });
}
