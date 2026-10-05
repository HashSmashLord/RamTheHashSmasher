// E2B desktop sandbox per RAM slot: lifecycle plumbing only.
//
// What this module does: create ONE E2B Desktop sandbox (template `desktop`:
// Ubuntu + Xfce, VNC via x11vnc, browser view via noVNC on port 6080) for a
// given RAM slot, start its VNC stream with a per-sandbox password, hand back
// what a frontend needs to embed it, and kill it. Nothing runs inside the
// sandbox yet; see "What will run inside" below.
//
// API shape (from @e2b/desktop 2.4.0's own source, not guessed):
//   const sbx = await Sandbox.create({ apiKey, timeoutMs, metadata, lifecycle, resolution })
//   await sbx.stream.start({ requireAuth: true })   // x11vnc + noVNC, random password
//   sbx.stream.getUrl({ viewOnly: true, authKey: sbx.stream.getAuthKey() })
//     -> https://6080-<sandboxId>.e2b.app/vnc.html?autoconnect=true&view_only=true&resize=scale&password=...
//   await sbx.kill()                                 // or Sandbox.kill(sandboxId, { apiKey })
//   If anything in create's own setup fails, the SDK kills the sandbox itself.
//
// Cost rails (E2B bills per second while a sandbox is running):
//   - Off unless RAMHERD_SANDBOX=e2b. Without it no manager is built, the SDK is
//     never imported and no network call is made, even with E2B_API_KEY set.
//   - Sandboxes are only created by an explicit start(slotId) call (an admin
//     route); nothing auto-starts one on slot activation.
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
// Secrets: the API key is read from the env object passed in and handed to the
// SDK. It is never logged, never stored on a returned object, and scrubbed out
// of any error message before that message is surfaced.
//
// The stream URL carries the VNC password. noVNC's `view_only=true` is a
// CLIENT-side setting: anyone holding that URL can drop the parameter and get
// mouse/keyboard control. The PRD says viewers watch and never interact, so the
// URL is NOT part of the public slot snapshot; it is only returned by an
// admin-gated route. Before this is shown to the public, start x11vnc with its
// server-side `-viewonly` flag (the SDK's stream.start() has no option for it)
// or proxy the stream, so view-only is enforced by the server, not the page.
//
// What will run inside (target for the next piece of work, NOT built here):
// the sandbox becomes the RAM's actual workbench. Its slot's research cycle
// (today in slots.js / hashsmash.js on the host) would run in a visible
// terminal on the sandbox desktop: clone the HashSmash repo, write/iterate a
// candidate, run `local_tracks.py check` and `hashsmash_pipeline.py intake`
// (and Docker-backed experiments, which this Mac can't run), with a browser
// window opened when the RAM researches (papers, the HashSmash rules/tracks).
// The host keeps the append-only feed and the HashSmash verdicts; the desktop
// is the watchable picture of the same work. Keys stay on the host: the LLM
// calls are made by the host, never from inside the sandbox.

const DEFAULT_TEMPLATE = 'desktop';
const DEFAULT_TIMEOUT_MIN = 15;
const MAX_TIMEOUT_MIN = 24 * 60; // Pro plan session cap
const DEFAULT_MAX_CONCURRENT = 6;
const PLAN_MAX_CONCURRENT = 100;

// E2B published usage rates (e2b.dev/pricing, checked 2026-10-05).
export const E2B_RATES = Object.freeze({ usdPerVcpuSecond: 0.000014, usdPerGibSecond: 0.0000045 });

/** Rough cost of a sandbox that ran `seconds` with the given resources. */
export function estimateCostUsd({ seconds, cpuCount, memoryMB }) {
  const gib = memoryMB / 1024;
  return seconds * (cpuCount * E2B_RATES.usdPerVcpuSecond + gib * E2B_RATES.usdPerGibSecond);
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
  loadSdk = () => import('@e2b/desktop'),
  now = () => Date.now(),
}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new TypeError('createSandboxManager requires an E2B api key');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MIN * 60_000) {
    throw new RangeError('timeoutMs must be a positive integer of at most 24h');
  }

  /** slotId -> { sbx, info, streamUrl } */
  const live = new Map();
  /** slotId -> in-flight start promise (prevents double creates for one slot) */
  const starting = new Map();
  let sdkPromise = null;

  const sdk = () => (sdkPromise ??= loadSdk());
  const iso = (ms) => new Date(ms).toISOString();

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
      await sbx.stream.start({ requireAuth: true });
      const streamUrl = sbx.stream.getUrl({ viewOnly: true, authKey: sbx.stream.getAuthKey() });
      const info = Object.freeze({
        provider: 'e2b',
        sessionId: sbx.sandboxId,
        template,
        startedAt: iso(startedMs),
        expiresAt: iso(startedMs + timeoutMs),
      });
      live.set(slotId, { sbx, info, streamUrl });
      return info;
    } catch (err) {
      // Never leave a half-started sandbox billing.
      await sbx.kill().catch(() => {});
      throw new Error(`E2B stream start failed (sandbox killed): ${scrub(err?.message, apiKey)}`);
    }
  }

  /**
   * Creates a desktop sandbox for `slotId` and starts its VNC stream. Returns
   * public session info (no URL, no password). Idempotent per slot: a second
   * call while one is live or starting returns the same session.
   *
   * @param {string} slotId
   */
  async function start(slotId) {
    if (typeof slotId !== 'string' || !slotId) throw new TypeError('slotId is required');
    if (live.has(slotId)) return live.get(slotId).info;
    if (starting.has(slotId)) return starting.get(slotId);
    if (live.size + starting.size >= maxConcurrent) {
      throw new Error(`sandbox limit reached (${maxConcurrent} running); stop one first`);
    }
    const p = createFor(slotId).finally(() => starting.delete(slotId));
    starting.set(slotId, p);
    return p;
  }

  /**
   * Kills the slot's sandbox. Returns stop details, or null if it had none.
   * @param {string} slotId
   */
  async function stop(slotId) {
    const pending = starting.get(slotId);
    if (pending) await pending.catch(() => {});
    const entry = live.get(slotId);
    if (!entry) return null;
    live.delete(slotId);
    const stoppedMs = now();
    try {
      await entry.sbx.kill();
    } catch (err) {
      // Fall back to the static API kill by id before giving up.
      try {
        const { Sandbox } = await sdk();
        await Sandbox.kill(entry.info.sessionId, { apiKey });
      } catch {
        throw new Error(`E2B sandbox kill failed for ${entry.info.sessionId}: ${scrub(err?.message, apiKey)}`);
      }
    }
    return {
      sessionId: entry.info.sessionId,
      stoppedAt: iso(stoppedMs),
      ranSeconds: Math.max(0, (stoppedMs - Date.parse(entry.info.startedAt)) / 1000),
    };
  }

  async function stopAll() {
    const ids = [...new Set([...live.keys(), ...starting.keys()])];
    const results = await Promise.allSettled(ids.map((id) => stop(id)));
    return results.map((r, i) => ({ slotId: ids[i], ok: r.status === 'fulfilled', ...(r.status === 'rejected' ? { error: r.reason.message } : r.value) }));
  }

  /** Public session info for a slot, or null. */
  function get(slotId) {
    return live.get(slotId)?.info ?? null;
  }

  /**
   * The embeddable stream URL (contains the VNC password). Admin use only:
   * see the view-only note at the top of this file.
   */
  function getStream(slotId) {
    const entry = live.get(slotId);
    return entry ? { ...entry.info, streamUrl: entry.streamUrl, viewOnly: 'client-side' } : null;
  }

  function count() {
    return live.size;
  }

  return Object.freeze({ provider: 'e2b', start, stop, stopAll, get, getStream, count });
}
