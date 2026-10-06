// Solver agent slots.
//
// Each slot is one agent instance assigned to a HashSmash lane/target/
// approach. Its feed is append-only — matching HashSmash's own transparency
// norm ("nothing hidden, no editing after the fact") — there is no method
// anywhere in this module that mutates or removes a past feed entry, only
// ones that push a new one. Resizing the pool (`setSlotCount`) is a
// deliberate operation a caller takes explicitly; nothing in here reacts to
// budget or fee changes on its own.
//
// Optional `pipelineRunner` (server/lib/hashsmash.js): when given, a slot whose
// track the runner supports (today: sha256-r31 and sha256-r32 exploratory)
// stops simulating its experiment step and instead drives HashSmash's REAL
// local pipeline. On sha256-r31 it writes an honestly-labeled harness DRAFT
// into its own clone of the vendored repo; on sha256-r32 it writes the
// committed research package (research/sha256-r32/package/). Either way it
// then runs the real `local_tracks.py check` and `hashsmash_pipeline.py
// intake`, and the slot's outcome is whatever that real pipeline returns.
// Passing intake is a mechanical verdict, never reported as an accepted
// cryptanalysis result. Other tracks keep the mock lifecycle.
//
// Per-RAM models: each slot's assignment carries `model` (its track's roster
// model from targets.js) and `modelSource` ('roster' | 'override'). When the
// caller passes `modelOverride` (store.js passes `RAMHERD_LLM_MODEL`), every
// slot gets that one model instead. Every LLM call a slot makes sends its own
// `model`; whether that call is live or mock is still decided only by
// llm.js's `isLiveMode`, never here.
//
// Optional `sandboxManager` (server/lib/sandbox.js, only built when
// RAMHERD_SANDBOX=e2b): a slot CAN be associated with one E2B desktop sandbox
// session. Starting one is always an explicit call (`startSandbox`), never a
// side effect of activation or advance(). The public snapshot carries only the
// session's id/status/times; the VNC stream URL (which holds its password) is
// only available through `getSandboxStream`, used by an admin route. Retiring a
// slot stops its sandbox so nothing is left billing.
//
// A slot's `sandbox` field tells its desk's real, current state apart:
//   null                 never had a sandbox (the usual case)
//   status 'starting'    one is being created right now
//   status 'running'     live; the public stream route hands out its view
//   status 'stopped'     this server stopped it (admin stop, retire, shutdown)
//   status 'expired'     E2B ended it without a stop from here; `endedBy` is
//                        'timeout' (its hard stop was reached: the normal end
//                        of a visible session) or 'provider' (gone before that)
//   status 'failed'      creating or starting it failed; `error` says why
// 'expired' comes from the sandbox manager's reconcile check (sandbox.js asks
// E2B while anything is live) through `onEnded`, or from a stop that finds the
// sandbox already gone. Each change is a new feed line; nothing is rewritten.
//
// Optional `sandboxTask` (server/lib/sandbox-task.js's runWorkbenchTask, passed
// by store.js whenever sandboxes are on): right after a sandbox starts, it runs
// fire-and-forget (startSandbox still returns as soon as the desktop is up) and
// types the slot's real workbench intro into a visible terminal: clone the real
// HashSmash repo, open this slot's track and candidate, run the organizer's
// mechanical check. Each finished command and the outcome land in the feed.
// `waitForSandboxTask(id)` awaits it deterministically (tests, operators). The
// slot's research cycle itself still runs on the host as before.
//
// Optional `sandboxContext` (server/lib/sandbox-context.js's contextBanner,
// passed by store.js whenever sandboxes are on): right after a sandbox starts
// (alongside the workbench task, also fire-and-forget) it puts an always-on
// banner across the top of the desktop: which RAM this is (track, rounds,
// approach, model, from the slot's real assignment) and its real status plus
// latest feed entry. Every later feed entry on a slot with a running sandbox
// rewrites the banner's text (coalesced: at most one write in flight per slot).
// `waitForSandboxContext(id)` awaits the start and any pending update.
//
// Auto-restart (optional `autoRestart`, store.js passes it only when
// RAMHERD_SANDBOX_AUTORESTART=true and sandboxes are on): when E2B ends an
// active ROSTER slot's sandbox at its hard timeout (`endedBy: 'timeout'`,
// reported through the sandbox manager's onEnded), the slot gets a fresh
// sandbox through the same path as an admin start, so the workbench task and
// context banner run again on it. The new sandbox starts fresh: nothing from
// the old one (clone, terminal history) carries over. What does NOT restart:
//   - owned (launchpad) slots, ever: they are left entirely alone;
//   - retired slots;
//   - a sandbox this server stopped (admin stop, retire, shutdown): status
//     'stopped' never comes through onEnded, and an admin stop also cancels a
//     pending restart (and an admin stop that finds the sandbox already gone
//     is recorded as expired but does not schedule one);
//   - `endedBy: 'provider'` (gone BEFORE its hard stop): E2B gives no reason,
//     and it can be a person killing it from E2B's dashboard/CLI, so this is
//     treated like a deliberate stop; a feed line says it was not restarted.
// The first restart goes out at once. If it fails, the slot retries after
// `baseDelayMs`, then doubling each time up to `maxDelayMs` (exponential: E2B
// rate limits and account errors tend to clear in minutes, not seconds); after
// `maxFailures` consecutive failures it gives up for that slot and says so in
// the feed. A success resets the count. `setAutoRestart(false)` and
// `stopAutoRestart()` (app shutdown; permanent) cancel every pending restart
// timer, and nothing new is scheduled after that; an admin start or stop on a
// slot cancels that slot's pending restart.
//
// Active loop (optional `activeLoop` + `sandboxActivity`, store.js passes them
// only when RAMHERD_SANDBOX_ACTIVE_LOOP=true and sandboxes are on): once a
// roster slot's workbench task has finished on a running sandbox, the slot's
// REAL research cycle is driven continuously: `advance()` is called back to
// back (idle -> thinking -> running-experiment -> validated|submitted|failed
// -> idle -> ...), with only a short pause (`stepPauseMs`, default 5 s, floor
// 2 s, ceiling 30 s) between one step finishing and the next starting, so the
// slot's status never sits still for more than MAX_IDLE_MS (60 s) unless a
// step is mid-call (a model call or the real HashSmash pipeline). The desktop
// is the visible side of the SAME event, not a second timer: the feed line(s)
// each advance() just pushed are what get typed into the notes editor
// (sandbox-activity.js), and the banner (which shows the latest feed entry)
// says the same thing. A running-experiment step also opens (or reuses) a
// terminal that looks at this RAM's own real cloned candidate files (`git
// log`, `ls`, `cat claim.json`/`proof.md`/`TASK.md`, cycled), so the desktop
// is not only the notes editor and an occasional browser tab. On a thinking
// step the model may end with a "SEARCH: <query>" line; on at most one in
// `browseEvery` thinking steps that opens a real IACR ePrint search in the
// desktop's Chrome, reads the real result titles, logs them in the feed and
// hands them to the next thinking step. Loop-driven steps never fabricate: on
// a track with no real experiment runner the experiment step says nothing
// ran instead of "drafted", and a thinking step is grounded in the slot's
// best REAL measured result so far this session (`slot.bestResult`,
// `updateBestResult`) with an explicit standing goal of beating it, honestly,
// rather than just cycling through statuses (LOOP_THINKING_SYSTEM).
// Guardrails:
//   - never starts in mock mode (`activeLoop.live`, from llm.js isLiveMode),
//     and stops itself if a thinking call ever comes back mocked;
//   - never starts while the paid HashSmash judge gate is open (every cycle
//     would buy a judge call);
//   - at most `maxThinkingPerSession` real thinking calls per sandbox session;
//   - consecutive step failures back off (doubling, capped under the idle
//     ceiling) and stop the loop after `maxFailures`;
//   - stops the moment its sandbox stops (admin stop, retire, E2B timeout,
//     a replacement sandbox from auto-restart, shutdown via stopActiveLoops),
//     and every step re-checks it is still the current loop of a running
//     session before calling the model or typing anything.
// Owned (launchpad) slots are never driven by it.
//
// Optional `yukonSandbox` (server/lib/yukon-sandbox.js): right after the
// one-time workbench task finishes on a freshly started sandbox (ok or not),
// and ONLY for the one roster slot whose track is blake3-r1-exploratory
// (yukonSandbox.isYukonSandboxTrack), this runs the real external Yukon CLI
// workflow (install, login, clone, setup, run, then an honest submit
// decision) over the sandbox's own command channel — never on the host, and
// never typed into a visible terminal. It is a no-op for every other slot,
// and a no-op for this one too until the operator sets
// RAMHERD_YUKON_SUBMIT=true with a real YUKON_API_KEY (both checked inside
// yukon-sandbox.js itself, not here). See that module's header for the key-
// handling and honesty rules; results land in the feed as `yukon-*` entries.
//
// Optional `costLedger` (server/lib/cost.js): when given, every real "thinking"
// LLM call (the one place `advance()` calls `llmProvider.complete()`) reports
// its tokens and USD cost against this slot, and against the slot's RAM id
// if it's an owned one. Backend bookkeeping only: nothing here puts a cost
// figure into `snapshot()`, so the public/admin slot API is unchanged by it.
//
// Owned slots (launchpad RAMs, server/lib/rams.js): `createOwnedSlot` makes a
// slot that belongs to a user's wallet, on the track/approach/model that user
// chose, carrying their operator-approved brief. Owned slots are `kind:
// 'owned'` and sit OUTSIDE the budget-driven roster: `setSlotCount` only ever
// counts, grows or retires `kind: 'roster'` slots, so the shared pool's
// allocator can never retire a RAM someone paid to create, and a user's RAM
// never takes a roster seat. Its compute is charged to its own funding account
// (ramfunds.js), not the shared pool.

import { assignmentForIndex, ACTIVE_TRACKS } from './targets.js';
import { contextPayload } from './sandbox-context.js';
import {
  parseThinking, noteBlock, MAX_IDLE_MS, DEFAULT_STEP_PAUSE_SEC, MIN_STEP_PAUSE_SEC, MAX_STEP_PAUSE_SEC,
  DEFAULT_BROWSE_EVERY, DEFAULT_MAX_THINKING_PER_SESSION, LOOP_THINKING_MAX_TOKENS,
} from './sandbox-activity.js';

// 'validated' = the candidate passed HashSmash's real local intake (mechanical
// checks only). It is not judged, not scored, and not submitted anywhere.
export const SLOT_STATUSES = ['idle', 'thinking', 'running-experiment', 'validated', 'submitted', 'failed'];

/**
 * Wait before auto-restart attempt number `failures + 1`, where `failures` is
 * how many restarts of that slot failed in a row: 0 -> at once, then
 * base, 2*base, 4*base ... capped at `maxMs`.
 */
export function restartDelayMs(failures, baseMs, maxMs) {
  if (failures <= 0) return 0;
  return Math.min(maxMs, baseMs * 2 ** (failures - 1));
}

/** System prompt for a thinking step the active loop drives. */
export const LOOP_THINKING_SYSTEM = 'You are a HashSmash solver agent whose work is shown live on a desktop people are watching. '
  + 'Your standing goal across this whole session is to beat your own best REAL result so far on this target (lowest time_log2, highest success_probability) — '
  + 'you are not just cycling through statuses, you are trying to genuinely improve on what you have actually produced. '
  + 'In two or three short sentences, say the next concrete thing you will try on this target, why, and how it could beat your best result so far. '
  + 'Never claim a result, a found collision or progress you do not have; if you have no real result yet, or cannot beat your best one, say that plainly instead of pretending otherwise. '
  + 'If looking up published literature would genuinely help this step, end with one line "SEARCH: <a short query for the IACR ePrint archive>"; otherwise do not add that line.';

/** Feed entry types that are the RAM's research history (what a thinking step is grounded in). */
const HISTORY_TYPES = /^(thinking|running-experiment|validated|submitted|failed|pipeline-.*|sandbox-browse|sandbox-task-done|suggestion-attached)$/;

/**
 * Updates, on the slot itself, the best REAL numeric result a pipeline run
 * has produced this session (lowest time_log2, highest success_probability).
 * Only ever replaced by a genuinely better real measurement from `detail`
 * (a pipeline cycle's `candidate`, see hashsmash.js) — never invented, never
 * moved by anything else. Lives on the slot (in-memory, per slot), not in the
 * public snapshot. Returns the slot's best record (or null if `detail` had
 * nothing numeric yet).
 */
export function updateBestResult(slot, detail) {
  if (!detail) return slot.bestResult ?? null;
  if (!slot.bestResult) slot.bestResult = { timeLog2: null, successProbability: null };
  if (typeof detail.timeLog2 === 'number' && (slot.bestResult.timeLog2 === null || detail.timeLog2 < slot.bestResult.timeLog2)) {
    slot.bestResult.timeLog2 = detail.timeLog2;
  }
  if (typeof detail.successProbability === 'number' && (slot.bestResult.successProbability === null || detail.successProbability > slot.bestResult.successProbability)) {
    slot.bestResult.successProbability = detail.successProbability;
  }
  return slot.bestResult;
}

/** Real recent history + the running best-so-far + last real search results, appended to a loop thinking prompt. */
export function loopGrounding(slot) {
  const clip = (t, n) => { const x = String(t).replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
  const recent = slot.feed.filter((f) => HISTORY_TYPES.test(f.type)).slice(-6).map((f) => `[${f.type}] ${clip(f.message, 220)}`);
  let out = ` Your recent activity, newest last: ${recent.length ? recent.join(' || ') : 'none yet'}.`;
  const best = slot.bestResult;
  out += (best && (best.timeLog2 !== null || best.successProbability !== null))
    ? ` Your best REAL result so far this session: ${best.timeLog2 !== null ? `time 2^${best.timeLog2}` : 'time not yet measured'}, ${
      best.successProbability !== null ? `success probability ${best.successProbability}` : 'success probability not yet measured'
    }. Try to beat it; if you cannot, say so honestly instead of claiming you did.`
    : ' You have no real measured result yet this session on this target (no experiment has actually produced a number); say that honestly rather than inventing one.';
  const ls = slot.lastSearch;
  if (ls) {
    out += ` Your last literature search, "${ls.query}" on the IACR ePrint archive, listed: ${
      ls.results.length ? ls.results.slice(0, 5).map((r) => `${r.id} "${clip(r.title, 120)}"`).join('; ') : 'no results'
    } (titles only; you have not read these papers).`;
  }
  return out;
}

function freezeCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * @param {{
 *   llmProvider: import('./llm.js').LlmProvider,
 *   pipelineRunner?: ReturnType<typeof import('./hashsmash.js').createHashSmashRunner>,
 *   sandboxManager?: ReturnType<typeof import('./sandbox.js').createSandboxManager>|null,
 *   sandboxTask?: typeof import('./sandbox-task.js').runWorkbenchTask|null,
 *   sandboxContext?: typeof import('./sandbox-context.js').contextBanner|null,
 *   costLedger?: ReturnType<typeof import('./cost.js').createCostLedger>|null,
 *   modelOverride?: string|null,
 *   autoRestart?: { enabled?: boolean, baseDelayMs?: number, maxDelayMs?: number, maxFailures?: number }|null,
 *   sandboxActivity?: typeof import('./sandbox-activity.js').desktopActivity|null,
 *   activeLoop?: { enabled?: boolean, live: boolean, stepPauseMs?: number, minStepPauseMs?: number, browseEvery?: number, maxThinkingPerSession?: number, maxFailures?: number }|null,
 *   yukonSandbox?: typeof import('./yukon-sandbox.js')|null,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (handle: any) => void,
 *   now?: () => string,
 *   idPrefix?: string,
 * }} opts
 */
export function createSlotManager({ llmProvider, pipelineRunner = null, sandboxManager = null, sandboxTask = null, sandboxContext = null, costLedger = null, modelOverride = null, autoRestart = null, sandboxActivity = null, activeLoop = null, yukonSandbox = null, setTimer = setTimeout, clearTimer = clearTimeout, now = () => new Date().toISOString(), idPrefix = 'slot' }) {
  if (!llmProvider || typeof llmProvider.complete !== 'function') {
    throw new TypeError('createSlotManager requires an llmProvider with complete()');
  }
  if (modelOverride !== null && (typeof modelOverride !== 'string' || !modelOverride.trim())) {
    throw new TypeError('modelOverride must be a non-empty string or null');
  }

  /** @type {Map<string, any>} */
  const slots = new Map();
  let nextAssignmentIndex = 0;
  let nextSlotSeq = 0;
  /** @type {Map<string, Promise<void>>} slot id -> its latest sandbox task run */
  const sandboxTasks = new Map();
  /** @type {Map<string, { sessionId: string, ready: boolean, starting: Promise<void>, inflight: Promise<void>|null, dirty: boolean }>} slot id -> its banner */
  const contexts = new Map();
  // Auto-restart config; null when not configured (then nothing below ever schedules).
  const restartCfg = autoRestart && sandboxManager ? {
    enabled: autoRestart.enabled !== false,
    baseDelayMs: autoRestart.baseDelayMs ?? 30_000,
    maxDelayMs: autoRestart.maxDelayMs ?? 10 * 60_000,
    maxFailures: autoRestart.maxFailures ?? 5,
    shutDown: false,
  } : null;
  /** @type {Map<string, { failures: number, timer: any, nextAt: string, attempt: Promise<void>|null }>} slot id -> its pending auto-restart */
  const restarts = new Map();
  // Active loop config; null when not configured (then nothing below ever drives a slot).
  const loopCfg = activeLoop && activeLoop.enabled !== false && sandboxManager && sandboxActivity ? (() => {
    const floor = activeLoop.minStepPauseMs ?? MIN_STEP_PAUSE_SEC * 1000;
    return {
      live: activeLoop.live === true,
      stepPauseMs: Math.min(MAX_STEP_PAUSE_SEC * 1000, Math.max(floor, activeLoop.stepPauseMs ?? DEFAULT_STEP_PAUSE_SEC * 1000)),
      browseEvery: Math.max(1, activeLoop.browseEvery ?? DEFAULT_BROWSE_EVERY),
      maxThinkingPerSession: Math.max(1, activeLoop.maxThinkingPerSession ?? DEFAULT_MAX_THINKING_PER_SESSION),
      maxFailures: Math.max(1, activeLoop.maxFailures ?? 5),
      shutDown: false,
    };
  })() : null;
  /** @type {Map<string, any>} slot id -> its running active loop */
  const loops = new Map();
  /** @type {Map<string, Promise<any>>} slot id -> its latest advance() (steps of one slot never overlap) */
  const advanceChains = new Map();

  // Bounded memory, same reasoning as cost.js's MAX_COST_ENTRIES: with the
  // active loop running thousands of steps per sandbox session, an unbounded
  // feed is a real, confirmed problem, not a theoretical one -- it quietly
  // grew this process to the point the whole site stopped responding
  // (2026-10-06, found live: /api/slots requests taking 18s+, then the proxy
  // could no longer reach the app at all). Oldest entries age out silently;
  // nothing here is ever edited, only the window is trimmed.
  const MAX_FEED_ENTRIES = 300;

  function pushFeed(slot, type, message) {
    slot.feed.push({ ts: now(), type, message });
    if (slot.feed.length > MAX_FEED_ENTRIES) slot.feed.splice(0, slot.feed.length - MAX_FEED_ENTRIES);
    slot.updatedAt = now();
    syncContext(slot);
  }

  function snapshot(slot) {
    return {
      id: slot.id,
      kind: slot.kind,
      owner: slot.owner,
      ramId: slot.ramId,
      brief: slot.brief,
      active: slot.active,
      status: slot.status,
      assignment: { ...slot.assignment },
      feed: freezeCopy(slot.feed),
      suggestions: freezeCopy(slot.suggestions),
      pipeline: slot.pipeline ? freezeCopy(slot.pipeline) : null,
      sandbox: slot.sandbox ? { ...slot.sandbox } : null,
      createdAt: slot.createdAt,
      updatedAt: slot.updatedAt,
    };
  }

  function activateOne() {
    const base = assignmentForIndex(nextAssignmentIndex++);
    const assignment = modelOverride
      ? { ...base, model: modelOverride.trim(), modelSource: 'override' }
      : { ...base, modelSource: 'roster' };
    const id = `${idPrefix}-${nextSlotSeq++}`;
    const slot = {
      id,
      kind: 'roster',
      owner: null,
      ramId: null,
      brief: null,
      active: true,
      status: 'idle',
      assignment,
      feed: [],
      suggestions: [],
      pipeline: null,
      sandbox: null,
      createdAt: now(),
      updatedAt: now(),
    };
    pushFeed(slot, 'activated', `Slot activated on ${assignment.track} (${assignment.approach}), model ${assignment.model}.`);
    slots.set(id, slot);
    return slot;
  }

  function activeSlots() {
    return [...slots.values()].filter((s) => s.active);
  }

  function activeRosterSlots() {
    return activeSlots().filter((s) => s.kind === 'roster');
  }

  /**
   * Creates a slot owned by a launchpad RAM's wallet. Only rams.js calls this,
   * after the operator confirmed the launch and approved the brief.
   *
   * @param {{ ramId: string, owner: string, track: string, approach: string, model: string, brief: string }} p
   */
  function createOwnedSlot({ ramId, owner, track, approach, model, brief }) {
    const base = ACTIVE_TRACKS.find((t) => t.track === track);
    if (!base) throw new RangeError(`unknown track: ${track}`);
    if (typeof ramId !== 'string' || !ramId || typeof owner !== 'string' || !owner) throw new TypeError('ramId and owner are required');
    if ([...slots.values()].some((s) => s.ramId === ramId)) throw new Error(`RAM ${ramId} already has a slot`);
    const assignment = modelOverride
      ? { ...base, approach, model: modelOverride.trim(), modelSource: 'override' }
      : { ...base, approach, model, modelSource: 'owner' };
    const id = `${idPrefix}-${nextSlotSeq++}`;
    const slot = {
      id,
      kind: 'owned',
      owner,
      ramId,
      brief: String(brief),
      active: true,
      status: 'idle',
      assignment,
      feed: [],
      suggestions: [],
      pipeline: null,
      sandbox: null,
      createdAt: now(),
      updatedAt: now(),
    };
    pushFeed(slot, 'activated', `RAM ${ramId} activated for its owner on ${assignment.track} (${assignment.approach}), model ${assignment.model}.`);
    slots.set(id, slot);
    return snapshot(slot);
  }

  /**
   * Deliberately resizes the active slot pool to exactly `count`. Growing
   * activates new slots (assigned round-robin over the HashSmash track
   * catalog); shrinking retires the most recently activated slots first.
   * Retired slots are kept, not deleted — their full history stays visible.
   *
   * @param {number} count
   */
  function setSlotCount(count) {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError('count must be a non-negative integer');
    }
    const active = activeRosterSlots(); // owned (launchpad) slots are never resized here
    if (active.length < count) {
      for (let i = active.length; i < count; i++) activateOne();
    } else if (active.length > count) {
      const toRetire = active.slice(count); // keep the earliest-activated ones
      for (const slot of toRetire) {
        slot.active = false;
        pushFeed(slot, 'retired', 'Slot retired: compute budget no longer supports it.');
        cancelRestart(slot.id, 'the slot was retired');
        stopLoop(slot.id);
        if (slot.sandbox && (slot.sandbox.status === 'starting' || slot.sandbox.status === 'running')) {
          // Fire and forget: setSlotCount stays synchronous; the outcome lands in the feed.
          stopSandbox(slot.id).catch(() => {});
        }
      }
    }
    return getSlots();
  }

  function getSlots() {
    return [...slots.values()].map(snapshot);
  }

  function getSlot(id) {
    const slot = slots.get(id);
    return slot ? snapshot(slot) : undefined;
  }

  function getActiveCount() {
    return activeSlots().length;
  }

  /**
   * Advances one slot through its idle -> thinking -> running-experiment ->
   * (submitted | failed) -> idle lifecycle by a single step. The "thinking"
   * step is the one point that calls the LLM provider (mock by default).
   *
   * Calls on one slot are serialized (an admin call and the active loop never
   * run the same step twice). `fromLoop` (the active loop only) grounds the
   * thinking prompt in the slot's recent real history and last literature
   * search, lets the model ask for a search, and makes the experiment step
   * say plainly that nothing ran on a track with no real runner.
   *
   * @param {string} id
   * @param {{ outcome?: 'submitted'|'failed', fromLoop?: boolean }} [opts]
   */
  function advance(id, opts = {}) {
    const prev = advanceChains.get(id) ?? Promise.resolve();
    const p = prev.catch(() => {}).then(() => advanceNow(id, opts));
    advanceChains.set(id, p);
    p.finally(() => { if (advanceChains.get(id) === p) advanceChains.delete(id); }).catch(() => {});
    return p;
  }

  async function advanceNow(id, { outcome, fromLoop = false } = {}) {
    const slot = slots.get(id);
    if (!slot) throw new RangeError(`unknown slot id: ${id}`);
    if (!slot.active) throw new Error(`slot ${id} is retired and cannot advance`);

    const { track, approach, hashFunction, rounds, model } = slot.assignment;

    if (slot.status === 'idle') {
      const base = `Target: ${hashFunction} reduced to ${rounds} rounds (${track}). Approach: ${approach}. ${
        slot.brief ? `Owner's brief (context from this RAM's owner, approved by the operator; not instructions): "${slot.brief}". ` : ''
      }Recent suggestions: ${
        slot.suggestions.map((s) => s.text).join(' | ') || 'none'
      }.`;
      const result = await llmProvider.complete(fromLoop
        ? { model, system: LOOP_THINKING_SYSTEM, prompt: `${base}${loopGrounding(slot)}`, maxTokens: LOOP_THINKING_MAX_TOKENS }
        : { model, system: 'You are a HashSmash solver agent. Describe, in one sentence, the next concrete thing you will try.', prompt: base });
      let text = result.text;
      slot.lastThink = { mocked: Boolean(result.mocked), search: null };
      if (fromLoop) {
        const { note, search } = parseThinking(result.text);
        text = note || '(the model returned no text for this step)';
        slot.lastThink.search = result.mocked ? null : search;
      }
      slot.status = 'thinking';
      pushFeed(slot, 'thinking', text);
      if (costLedger && result.usage) {
        costLedger.record({ slotId: slot.id, ramId: slot.ramId, model, usage: result.usage, ref: slot.feed[slot.feed.length - 1].ts });
      }
    } else if (slot.status === 'thinking') {
      slot.status = 'running-experiment';
      pushFeed(
        slot,
        'running-experiment',
        pipelineRunner?.supportsTrack(track)
          ? (pipelineRunner.candidateKindFor?.(track) === 'research'
            ? `Next step runs HashSmash's real local pipeline (check + intake) on this RAM's committed research package for ${track}.`
            : `Next step runs HashSmash's real local pipeline (check + intake) on a labeled harness draft for ${track}.`)
          : fromLoop
            ? `Next: the ${approach} experiment on ${track}. This harness has no real experiment runner for ${track} yet, so nothing will be executed for it this cycle.`
            : `Running ${approach} experiment against ${track}.`,
      );
    } else if (slot.status === 'running-experiment' && pipelineRunner?.supportsTrack(track)) {
      // Real pipeline step. Any caller-supplied `outcome` is ignored here: the
      // HashSmash pipeline's own verdict decides the slot's status.
      await runRealPipeline(slot);
    } else if (slot.status === 'running-experiment' && fromLoop) {
      // No runner for this track: say so, never "drafted".
      slot.status = 'failed';
      pushFeed(slot, 'failed', `No experiment ran for ${track}: there is no real runner for this track in this harness yet. Nothing was drafted, validated or submitted.`);
    } else if (slot.status === 'running-experiment') {
      const next = outcome === 'failed' ? 'failed' : 'submitted';
      slot.status = next;
      pushFeed(
        slot,
        next,
        next === 'submitted'
          ? `Candidate package drafted for ${track}; not auto-submitted to HashSmash (see NOTES.md).`
          : `Experiment did not produce a usable result for ${track}.`,
      );
    } else {
      // validated, submitted or failed -> back to idle for the next research cycle.
      slot.status = 'idle';
      pushFeed(slot, 'cycle-reset', 'Starting next research cycle.');
    }
    return snapshot(slot);
  }

  async function runRealPipeline(slot) {
    const { track, model, approach, modelSource } = slot.assignment;
    let cycle;
    try {
      cycle = await pipelineRunner.runCycle({ slotId: slot.id, track, model, approach, modelSource });
    } catch (err) {
      slot.status = 'failed';
      slot.pipeline = { track, error: err.message, ranAt: now() };
      pushFeed(slot, 'pipeline-error', `HashSmash pipeline could not run: ${err.message}`);
      return;
    }
    updateBestResult(slot, cycle.candidate);
    slot.pipeline = {
      track,
      ranAt: now(),
      referenceHead: cycle.head,
      // Project-relative only: snapshots are served on the public /api/slots route.
      workspace: cycle.workspaceRelative ?? null,
      candidate: cycle.candidate?.kind ?? 'harness-draft',
      candidateDetail: cycle.candidate ?? null,
      // Which RAM (slot id, model, track) produced this candidate — written to
      // its own file outside the package by writeAttribution, never into
      // claim.json/proof.md. Ready for a real submission step; nothing here
      // sends it anywhere external yet.
      attributionPath: cycle.attribution?.path ?? null,
      precheck: { ok: cycle.precheck.ok, errors: cycle.precheck.errors },
      stages: cycle.stages.map(({ stage, outcome, exitCode, status, detail, durationMs, parsed }) => ({
        stage, outcome, exitCode, status, detail, durationMs,
        packageSha256: parsed?.package_sha256 ?? null,
      })),
    };
    if (!cycle.precheck.ok) {
      slot.status = 'failed';
      pushFeed(slot, 'pipeline-precheck', `Candidate failed precheck: ${cycle.precheck.errors.join('; ')}`);
      return;
    }
    for (const st of slot.pipeline.stages) {
      const sha = st.packageSha256 ? ` package_sha256=${st.packageSha256.slice(0, 16)}…` : '';
      pushFeed(slot, `pipeline-${st.stage}`, `HashSmash ${st.stage}: ${st.outcome} (exit ${st.exitCode ?? 'n/a'}, status ${st.status ?? 'none'})${sha}${st.detail ? ` — ${st.detail}` : ''}`);
    }
    const intake = slot.pipeline.stages.find((st) => st.stage === 'intake');
    if (intake && (intake.outcome === 'draft-not-submitted' || intake.outcome === 'ok')) {
      slot.status = 'validated';
      const judged = slot.pipeline.stages.find((st) => st.stage === 'judge');
      pushFeed(slot, 'validated', slot.pipeline.candidate === 'research'
        ? `Research package passed HashSmash's real local intake for ${track} (mechanical checks only). Judge stage: ${judged?.outcome ?? 'not run'}; nothing was scored or submitted. Its claim still rests on disclosed exploratory heuristics; passing intake is not a verdict on them. Attribution recorded: RAM ${slot.id}, model ${model}, track ${track} — not sent anywhere yet, there is no real external submission path.`
        : `Harness draft passed HashSmash's real local intake for ${track}. Integration check only: no attack is claimed, nothing was judged or submitted. Attribution recorded: RAM ${slot.id}, model ${model}, track ${track}.`);
    } else {
      slot.status = 'failed';
      const blocked = intake?.outcome === 'environment-blocked';
      pushFeed(slot, blocked ? 'pipeline-blocked' : 'failed', blocked
        ? `HashSmash pipeline blocked by the local environment, not by the candidate: ${intake.detail}`
        : `HashSmash pipeline rejected the candidate for ${track}.`);
    }
  }

  /**
   * Attaches an approved viewer idea to a slot as labeled context — never
   * as a command. Only the moderation flow (after human approval) calls
   * this; it is intentionally absent from the coordinator's view.
   *
   * @param {string} id
   * @param {{ id: string, text: string }} idea
   */
  function attachSuggestion(id, idea) {
    const slot = slots.get(id);
    if (!slot) throw new RangeError(`unknown slot id: ${id}`);
    const entry = { id: idea.id, text: idea.text, label: 'viewer suggestion', attachedAt: now() };
    slot.suggestions.push(entry);
    pushFeed(slot, 'suggestion-attached', `Viewer suggestion attached: "${idea.text}"`);
    return snapshot(slot);
  }

  function requireSandboxes() {
    if (!sandboxManager) throw new Error('sandboxes are disabled (set RAMHERD_SANDBOX=e2b and E2B_API_KEY)');
  }

  /**
   * Creates (or returns the existing) E2B desktop sandbox for an active slot.
   * @param {string} id
   */
  async function startSandbox(id) {
    requireSandboxes();
    const slot = slots.get(id);
    if (slot && slot.active) cancelRestart(id, 'an admin started its sandbox');
    return startSandboxNow(id);
  }

  async function startSandboxNow(id) {
    const slot = slots.get(id);
    if (!slot) throw new RangeError(`unknown slot id: ${id}`);
    if (!slot.active) throw new Error(`slot ${id} is retired and cannot start a sandbox`);
    if (slot.sandbox?.status === 'running') return snapshot(slot);
    stopLoop(id); // a new session never inherits the old one's loop
    slot.sandbox = { provider: sandboxManager.provider, status: 'starting', sessionId: null, requestedAt: now() };
    pushFeed(slot, 'sandbox-starting', 'Starting an isolated desktop sandbox for this RAM.');
    try {
      const info = await sandboxManager.start(id, { exempt: slot.kind === 'owned' });
      slot.sandbox = { ...info, status: 'running' };
      pushFeed(slot, 'sandbox-started', `Desktop sandbox ${info.sessionId} running (${info.template}), hard stop at ${info.expiresAt}.`);
      if (sandboxContext && typeof sandboxManager.runTask === 'function') startContext(slot, info.sessionId);
      if (sandboxTask && typeof sandboxManager.runTask === 'function') sandboxTasks.set(id, runSandboxTask(slot, info.sessionId));
    } catch (err) {
      slot.sandbox = { provider: sandboxManager.provider, status: 'failed', sessionId: null, error: err.message, failedAt: now() };
      pushFeed(slot, 'sandbox-error', `Desktop sandbox could not start: ${err.message}`);
      throw err;
    }
    return snapshot(slot);
  }

  /**
   * Fire-and-forget body of the sandbox task: never rejects, reports to the feed.
   * Feed lines only carry the typed commands, exit codes and values read from
   * the public HashSmash repo, nothing secret.
   */
  async function runSandboxTask(slot, sessionId) {
    // Yield first so startSandbox's caller sees 'sandbox-started' as the last entry.
    await Promise.resolve();
    const { track, editablePath } = slot.assignment;
    const current = () => slot.sandbox?.sessionId === sessionId && slot.sandbox?.status === 'running';
    pushFeed(slot, 'sandbox-task-started', `Opening a terminal on desktop ${sessionId}: cloning the real HashSmash repo and opening ${editablePath} for ${track}, typed live.`);
    try {
      const result = await sandboxManager.runTask(slot.id, (sbx, { isLive }) => sandboxTask(sbx, slot.assignment, {
        isLive: () => isLive() && current(),
        onStep: (st) => pushFeed(slot, 'sandbox-task-step', `Desktop terminal: \`${st.command}\` (exit ${st.exitCode}).`),
      }));
      if (!result.ok) {
        pushFeed(slot, 'sandbox-task-error', `Desktop terminal stopped: "${result.failedStep}" step exited non-zero.`);
        return;
      }
      const parts = [];
      if (result.repo) parts.push(`cloned ${result.repo.origin ?? 'HashSmash'} at ${result.repo.head.slice(0, 12)}`);
      const c = result.claim;
      if (c) parts.push(`${editablePath}/claim.json: ${c.attackClass}, time 2^${c.timeLog2}, memory 2^${c.memoryLog2Bytes} bytes, success ${c.successProbability}, state ${c.submissionState}`);
      if (result.check) parts.push(`organizer check: ${result.check.status}`);
      pushFeed(slot, 'sandbox-task-done', `Workbench ready on desktop ${sessionId}: ${parts.join('; ') || 'commands ran'}.`);
    } catch (err) {
      pushFeed(slot, 'sandbox-task-error', `Desktop terminal task did not finish: ${err.message}`);
    } finally {
      // The real Yukon CLI integration (yukon-sandbox.js): scoped to exactly
      // one roster slot (blake3-r1-exploratory), gated by RAMHERD_YUKON_SUBMIT
      // + a real YUKON_API_KEY inside that module itself, so this call is a
      // no-op (and touches nothing on the sandbox) for every other slot and
      // for this one too until the operator turns the gate on.
      if (current() && yukonSandbox && yukonSandbox.isYukonSandboxTrack(track)) {
        await runYukonSandboxOnce(slot, sessionId, current).catch(() => {});
      }
      // The always-on loop takes over from the one-time intro, ok or not, if the desktop is still up.
      if (current()) startLoop(slot, sessionId);
    }
  }

  /**
   * Runs yukon-sandbox.js's one-time cycle on a freshly started sandbox and
   * turns its result into feed lines — real ones only, whatever the real CLI
   * actually said. Never rejects (the caller's `.catch(() => {})` is a last
   * resort; every expected outcome, including an exception from the sandbox
   * call itself, is turned into a feed line here).
   */
  async function runYukonSandboxOnce(slot, sessionId, current) {
    try {
      const result = await sandboxManager.runTask(slot.id, (sbx) => yukonSandbox.runYukonSandboxCycle(sbx, {
        assignment: slot.assignment,
        bestResult: slot.bestResult ?? null,
      }));
      if (!current()) return;
      if (result.skipped) {
        pushFeed(slot, 'yukon-setup-skipped', `Yukon CLI integration not started: ${result.reason}.`);
        return;
      }
      for (const step of result.steps) pushFeed(slot, 'yukon-step', yukonSandbox.yukonStepMessage(step));
      if (!result.ok) {
        pushFeed(slot, 'yukon-setup-error', `Yukon CLI workbench stopped at "${result.failedStep}": ${result.reason}.`);
        return;
      }
      pushFeed(slot, 'yukon-setup-done', `Yukon CLI workbench ready inside the sandbox (workspace ${result.workspaceDir}): install, login, clone, setup and run all completed for real.`);
      if (!result.submitted) {
        pushFeed(slot, 'yukon-submit-skipped', `Not submitting to Yukon: ${result.decision.reason}.`);
        return;
      }
      const sub = result.submitResult;
      pushFeed(slot, sub.ok ? 'yukon-submit-done' : 'yukon-submit-error', `yukon submit (model ${sub.model}, harness "${sub.harness}"): exit ${sub.exitCode ?? 'n/a'}${sub.stdout ? ` — ${sub.stdout.trim().slice(0, 300)}` : ''}`);
    } catch (err) {
      if (current()) pushFeed(slot, 'yukon-setup-error', `Yukon CLI integration did not finish: ${err.message}`);
    }
  }

  // ---- active loop (see the header) ----

  function loopActive() {
    return Boolean(loopCfg && !loopCfg.shutDown);
  }

  function loopIsCurrent(slot, entry) {
    return loopActive() && loops.get(slot.id) === entry && !entry.stopped && slot.active
      && slot.sandbox?.status === 'running' && slot.sandbox?.sessionId === entry.sessionId;
  }

  /** Starts the always-on loop on a slot's running sandbox, or says in the feed why it will not. */
  function startLoop(slot, sessionId) {
    if (!loopActive() || slot.kind !== 'roster' || !slot.active) return;
    stopLoop(slot.id);
    if (!loopCfg.live) {
      pushFeed(slot, 'sandbox-loop-skipped', 'Always-on research loop not started: the model provider is in mock (dry-run) mode, so there is no real model to think with.');
      return;
    }
    if (pipelineRunner?.judgeAllowed) {
      pushFeed(slot, 'sandbox-loop-skipped', 'Always-on research loop not started: the paid HashSmash judge gate is open, and a back-to-back loop would buy a judge call every cycle.');
      return;
    }
    const entry = {
      sessionId, timer: null, running: null, stopped: false, startedAt: now(),
      steps: 0, thinking: 0, failures: 0, lastBrowseThinking: -Infinity, browses: 0,
      notepadId: null, browserId: null, terminalId: null, inspects: 0, unverifiedTyping: 0,
      lastAdvanceEndMs: null, maxGapMs: 0, history: [],
    };
    loops.set(slot.id, entry);
    pushFeed(slot, 'sandbox-loop-started', `Always-on research loop started on desktop ${sessionId}: this RAM now advances its real research cycle step after step (a ${Math.round(loopCfg.stepPauseMs / 1000)}s pause between steps, never idle for ${MAX_IDLE_MS / 1000}s unless a step is mid-call); each step's feed line is typed into a notes editor, and on a running-experiment step a terminal also looks at this RAM's own real cloned candidate files, on the desktop as it happens.`);
    scheduleLoopStep(slot, entry, 0);
  }

  function scheduleLoopStep(slot, entry, delayMs) {
    if (!loopIsCurrent(slot, entry)) return;
    entry.timer = setTimer(() => {
      entry.timer = null;
      entry.running = loopStep(slot, entry);
    }, delayMs);
    entry.timer?.unref?.();
  }

  /** One loop step: a real advance(), then its feed line(s) typed on the desktop, maybe a real search. Never rejects. */
  async function loopStep(slot, entry) {
    if (!loopIsCurrent(slot, entry)) return;
    const wasIdle = slot.status === 'idle';
    if (wasIdle && entry.thinking >= loopCfg.maxThinkingPerSession) {
      pushFeed(slot, 'sandbox-loop-stopped', `Always-on research loop stopped: it reached its cap of ${loopCfg.maxThinkingPerSession} model calls for this desktop session. A new session (restart) starts a fresh count.`);
      stopLoop(slot.id);
      return;
    }
    const startMs = Date.now();
    if (entry.lastAdvanceEndMs !== null) entry.maxGapMs = Math.max(entry.maxGapMs, startMs - entry.lastAdvanceEndMs);
    const before = slot.feed.length;
    const statusBefore = slot.status;
    try {
      await advance(slot.id, { fromLoop: true });
      entry.lastAdvanceEndMs = Date.now();
      entry.steps += 1;
      entry.history.push({ at: now(), statusBefore, statusAfter: slot.status, advanceMs: entry.lastAdvanceEndMs - startMs });
      if (entry.history.length > 50) entry.history.shift();
      if (wasIdle) {
        entry.thinking += 1;
        if (slot.lastThink?.mocked) {
          pushFeed(slot, 'sandbox-loop-stopped', 'Always-on research loop stopped: the model call came back as a mock (dry-run) answer, so nothing is typed as if it were real thinking.');
          stopLoop(slot.id);
          return;
        }
      }
      if (!loopIsCurrent(slot, entry)) return;
      const produced = slot.feed.slice(before).filter((f) => !f.type.startsWith('sandbox-'));
      const block = noteBlock({ ts: produced.at(-1)?.ts ?? now(), statusBefore, statusAfter: slot.status, entries: produced });
      const typed = await sandboxManager.runTask(slot.id, async (sbx) => {
        entry.notepadId = await sandboxActivity.ensureNotepad(sbx, { assignment: slot.assignment, windowId: entry.notepadId });
        if (!loopIsCurrent(slot, entry)) return null;
        return sandboxActivity.typeIntoNotepad(sbx, { assignment: slot.assignment, windowId: entry.notepadId, block });
      });
      if (typed && !typed.verified) entry.unverifiedTyping += 1;
      // A second, distinct honest activity: on the step that just entered
      // running-experiment, a terminal looks at this RAM's own real cloned
      // candidate files (sandbox-activity.js), so a viewer sees more than
      // the notes editor and an occasional browser tab. Cycled so the same
      // file is never shown twice back to back.
      if (slot.status === 'running-experiment' && loopIsCurrent(slot, entry)) {
        const inspected = await sandboxManager.runTask(slot.id, (sbx) => sandboxActivity.inspectRepoFile(sbx, { assignment: slot.assignment, windowId: entry.terminalId, index: entry.inspects }));
        if (loopIsCurrent(slot, entry)) {
          entry.terminalId = inspected.windowId;
          entry.inspects += 1;
          pushFeed(slot, 'sandbox-inspect', `Opened a terminal on desktop ${entry.sessionId} and looked at ${inspected.label}: ${
            inspected.output ? inspected.output.slice(0, 220) : '(no output)'
          }`);
        }
      }
      const query = wasIdle ? slot.lastThink?.search : null;
      if (query && entry.thinking - entry.lastBrowseThinking >= loopCfg.browseEvery && loopIsCurrent(slot, entry)) {
        entry.lastBrowseThinking = entry.thinking;
        const b = await sandboxManager.runTask(slot.id, (sbx) => sandboxActivity.browseLiterature(sbx, { query, windowId: entry.browserId }));
        if (!loopIsCurrent(slot, entry)) return;
        entry.browserId = b.windowId;
        entry.browses += 1;
        slot.lastSearch = { query, url: b.url, results: b.results, at: now() };
        pushFeed(slot, 'sandbox-browse', `Looked up "${query}" on the IACR ePrint archive in Chrome on desktop ${entry.sessionId} (this RAM's model asked for the search). ${
          b.results.length
            ? `Results listed include: ${b.results.slice(0, 3).map((r) => `${r.id} "${r.title}"`).join('; ')}. Titles only: no paper has been read and nothing is concluded from them yet.`
            : 'The search listed no papers.'
        }`);
      }
      entry.failures = 0;
      scheduleLoopStep(slot, entry, loopCfg.stepPauseMs);
    } catch (err) {
      if (!loopIsCurrent(slot, entry)) return; // the sandbox went away mid-step: stop quietly
      entry.failures += 1;
      if (entry.failures >= loopCfg.maxFailures) {
        pushFeed(slot, 'sandbox-loop-stopped', `Always-on research loop stopped after ${entry.failures} failed steps in a row; last error: ${err.message}. It starts again with the next desktop session.`);
        stopLoop(slot.id);
        return;
      }
      // Back off, but stay under the idle ceiling.
      const delay = Math.min(MAX_IDLE_MS - 10_000, loopCfg.stepPauseMs * 2 ** entry.failures);
      pushFeed(slot, 'sandbox-loop-error', `Research loop step failed (${err.message}); retrying in ${Math.round(delay / 1000)}s (${entry.failures}/${loopCfg.maxFailures} failures before it stops).`);
      scheduleLoopStep(slot, entry, delay);
    }
  }

  /** Stops a slot's loop at once (no feed line: the reason is already in the feed). */
  function stopLoop(id) {
    const entry = loops.get(id);
    if (!entry) return false;
    entry.stopped = true;
    if (entry.timer) clearTimer(entry.timer);
    entry.timer = null;
    loops.delete(id);
    return true;
  }

  /** Permanent off switch for shutdown: stops every loop; none starts again. */
  function stopActiveLoops() {
    if (!loopCfg) return;
    loopCfg.shutDown = true;
    for (const id of [...loops.keys()]) stopLoop(id);
  }

  function activeLoopStatus() {
    return {
      configured: Boolean(loopCfg),
      active: loopActive(),
      live: loopCfg?.live ?? false,
      stepPauseMs: loopCfg?.stepPauseMs ?? null,
      maxIdleMs: MAX_IDLE_MS,
      browseEvery: loopCfg?.browseEvery ?? null,
      maxThinkingPerSession: loopCfg?.maxThinkingPerSession ?? null,
      loops: [...loops].map(([slotId, e]) => ({
        slotId, sessionId: e.sessionId, startedAt: e.startedAt, steps: e.steps, thinking: e.thinking, browses: e.browses, inspects: e.inspects,
        failures: e.failures, maxGapMs: e.maxGapMs, unverifiedTyping: e.unverifiedTyping, history: e.history.map((h) => ({ ...h })),
      })),
    };
  }

  /** Test/operator hook: resolves once the slot's in-flight loop step (if any) settled. */
  async function waitForLoopStep(id) {
    const entry = loops.get(id);
    if (entry?.running) await entry.running;
  }

  /** Test/operator hook: resolves once the slot's latest sandbox task has finished (or at once if none). */
  async function waitForSandboxTask(id) {
    await (sandboxTasks.get(id) || Promise.resolve());
  }

  function contextFor(slot) {
    return contextPayload({ slotId: slot.id, ramId: slot.ramId, assignment: slot.assignment, status: slot.status, feed: slot.feed });
  }

  function contextIsCurrent(slot, ctx) {
    return contexts.get(slot.id) === ctx && slot.sandbox?.status === 'running' && slot.sandbox?.sessionId === ctx.sessionId;
  }

  /** Puts the always-on context banner on a freshly started sandbox. Never rejects. */
  function startContext(slot, sessionId) {
    const ctx = { sessionId, ready: false, starting: null, inflight: null, dirty: false };
    contexts.set(slot.id, ctx);
    ctx.starting = (async () => {
      await Promise.resolve(); // let startSandbox finish its own feed line first
      try {
        await sandboxManager.runTask(slot.id, (sbx) => sandboxContext.start(sbx, contextFor(slot)));
        if (!contextIsCurrent(slot, ctx)) return;
        ctx.ready = true;
        // Feed entries pushed while it was starting are picked up by this line's sync.
        pushFeed(slot, 'sandbox-context-started', `On-screen context banner is up on desktop ${sessionId}: this RAM's assignment, status and latest feed entry, kept current.`);
      } catch (err) {
        if (contextIsCurrent(slot, ctx)) pushFeed(slot, 'sandbox-context-error', `On-screen context banner could not start: ${err.message}`);
      }
    })();
  }

  /**
   * Rewrites the banner's text from the slot's real state. Coalesced: while a
   * write is in flight, later calls only mark it dirty and one more write
   * follows with the newest state. Failures are dropped (the sandbox may have
   * just stopped); the feed already shows sandbox start/stop/errors.
   */
  function syncContext(slot) {
    const ctx = contexts.get(slot.id);
    if (!ctx || !ctx.ready || !contextIsCurrent(slot, ctx)) return;
    if (ctx.inflight) { ctx.dirty = true; return; }
    ctx.inflight = (async () => {
      do {
        ctx.dirty = false;
        await Promise.resolve(); // batch entries pushed in the same tick
        if (!contextIsCurrent(slot, ctx)) return;
        try {
          await sandboxManager.runTask(slot.id, (sbx) => sandboxContext.update(sbx, contextFor(slot)));
        } catch { /* sandbox gone or command failed; next entry retries */ }
      } while (ctx.dirty);
    })().finally(() => { ctx.inflight = null; });
  }

  /** Test/operator hook: resolves once the banner has started and any pending text update has been written. */
  async function waitForSandboxContext(id) {
    const ctx = contexts.get(id);
    if (!ctx) return;
    await ctx.starting;
    while (ctx.inflight) await ctx.inflight;
  }

  /**
   * Records that E2B ended the slot's sandbox on its own (sandbox.js found it
   * gone: hard timeout, or anything else on E2B's side). Only applies to the
   * session the slot still believes is running; returns whether it did.
   * @param {any} slot
   * @param {{ sessionId: string, endedBy: 'timeout'|'provider', endedAt: string, noticedAt: string, ranSeconds: number }} d
   */
  function markSandboxEnded(slot, d) {
    if (!slot.sandbox || slot.sandbox.sessionId !== d.sessionId || slot.sandbox.status !== 'running') return false;
    stopLoop(slot.id);
    slot.sandbox = { ...slot.sandbox, status: 'expired', endedBy: d.endedBy, endedAt: d.endedAt, noticedAt: d.noticedAt, ranSeconds: d.ranSeconds };
    const ran = Math.round(d.ranSeconds);
    pushFeed(slot, 'sandbox-expired', d.endedBy === 'timeout'
      ? `Desktop sandbox ${d.sessionId} reached its hard stop after ${ran}s; E2B closed it. The RAM's work continues on the host.`
      : `Desktop sandbox ${d.sessionId} is no longer running on E2B (closed before its hard stop, about ${ran}s in). The RAM's work continues on the host.`);
    return true;
  }

  if (sandboxManager && typeof sandboxManager.onEnded === 'function') {
    sandboxManager.onEnded((slotId, details) => {
      const slot = slots.get(slotId);
      if (slot && markSandboxEnded(slot, details)) afterSandboxEnded(slot, details);
    });
  }

  // ---- auto-restart (see the header) ----

  function autoRestartActive() {
    return Boolean(restartCfg && restartCfg.enabled && !restartCfg.shutDown);
  }

  /** Called only for a sandbox E2B ended on its own (never for a stop from here). */
  function afterSandboxEnded(slot, details) {
    if (!autoRestartActive() || slot.kind !== 'roster' || !slot.active) return;
    if (details.endedBy !== 'timeout') {
      pushFeed(slot, 'sandbox-autorestart-skipped', `Not auto-restarting: desktop sandbox ${details.sessionId} ended before its hard stop, which can be a deliberate kill on E2B's side. An admin can start a new one.`);
      return;
    }
    scheduleRestart(slot, 0, null);
  }

  function scheduleRestart(slot, failures, lastError) {
    const delay = restartDelayMs(failures, restartCfg.baseDelayMs, restartCfg.maxDelayMs);
    const entry = { failures, timer: null, nextAt: new Date(Date.now() + delay).toISOString(), attempt: null };
    restarts.set(slot.id, entry);
    entry.timer = setTimer(() => {
      entry.timer = null;
      entry.attempt = attemptRestart(slot, entry);
    }, delay);
    entry.timer?.unref?.();
    pushFeed(slot, 'sandbox-autorestart-scheduled', failures === 0
      ? 'Auto-restart: starting a fresh desktop sandbox for this RAM (the old one is gone; nothing on it carries over).'
      : `Auto-restart attempt ${failures} failed (${lastError}); retrying in ${Math.round(delay / 1000)}s (${failures}/${restartCfg.maxFailures} failures before giving up).`);
  }

  /** One restart attempt. Never rejects; failures schedule the next try or give up. */
  async function attemptRestart(slot, entry) {
    if (restarts.get(slot.id) !== entry) return; // cancelled meanwhile
    if (!autoRestartActive() || slot.kind !== 'roster' || !slot.active) {
      restarts.delete(slot.id);
      return;
    }
    try {
      await startSandboxNow(slot.id);
      if (restarts.get(slot.id) === entry) restarts.delete(slot.id);
    } catch (err) {
      if (restarts.get(slot.id) !== entry) return; // an admin or shutdown took over meanwhile
      const failures = entry.failures + 1;
      if (!autoRestartActive() || !slot.active) {
        restarts.delete(slot.id);
        return;
      }
      if (failures >= restartCfg.maxFailures) {
        restarts.delete(slot.id);
        pushFeed(slot, 'sandbox-autorestart-gave-up', `Auto-restart gave up after ${failures} failed attempts in a row; last error: ${err.message}. No more automatic restarts for this RAM until an admin starts its sandbox.`);
        return;
      }
      scheduleRestart(slot, failures, err.message);
    }
  }

  /** Drops a slot's pending restart (clears its timer). Returns whether one was pending. */
  function cancelRestart(id, why) {
    const entry = restarts.get(id);
    if (!entry) return false;
    restarts.delete(id);
    if (entry.timer) clearTimer(entry.timer);
    const slot = slots.get(id);
    if (slot && why) pushFeed(slot, 'sandbox-autorestart-cancelled', `Auto-restart cancelled: ${why}.`);
    return true;
  }

  function cancelAllRestarts(why) {
    for (const id of [...restarts.keys()]) cancelRestart(id, why);
  }

  /**
   * Turns auto-restart on or off at runtime (admin). Turning it on only works
   * when it was configured (RAMHERD_SANDBOX_AUTORESTART=true) and the app is
   * not shutting down; turning it off cancels every pending restart.
   * @param {boolean} enabled
   */
  function setAutoRestart(enabled) {
    if (!restartCfg) throw new Error('auto-restart is not configured (set RAMHERD_SANDBOX_AUTORESTART=true with RAMHERD_SANDBOX=e2b)');
    if (enabled && restartCfg.shutDown) throw new Error('auto-restart was stopped for shutdown');
    restartCfg.enabled = Boolean(enabled);
    if (!restartCfg.enabled) cancelAllRestarts('auto-restart was switched off');
    return autoRestartStatus();
  }

  /** Permanent off switch for shutdown: cancels every pending restart; nothing is scheduled again. */
  function stopAutoRestart() {
    if (!restartCfg) return;
    restartCfg.shutDown = true;
    cancelAllRestarts('the server is shutting down');
  }

  function autoRestartStatus() {
    return {
      configured: Boolean(restartCfg),
      active: autoRestartActive(),
      maxFailures: restartCfg?.maxFailures ?? null,
      baseDelayMs: restartCfg?.baseDelayMs ?? null,
      maxDelayMs: restartCfg?.maxDelayMs ?? null,
      pending: [...restarts].map(([slotId, e]) => ({ slotId, failures: e.failures, nextAt: e.nextAt, attempting: Boolean(e.attempt) })),
    };
  }

  /** Test/operator hook: resolves once the slot's in-flight restart attempt (if any) settled. */
  async function waitForSandboxRestart(id) {
    const entry = restarts.get(id);
    if (entry?.attempt) await entry.attempt;
  }

  /**
   * Kills the slot's sandbox, if it has a live one. Works on retired slots too.
   * If E2B had already ended it, that is what gets recorded (status 'expired'),
   * not a stop that never happened.
   * @param {string} id
   */
  async function stopSandbox(id) {
    requireSandboxes();
    const slot = slots.get(id);
    if (!slot) throw new RangeError(`unknown slot id: ${id}`);
    // A human stopping this desk wins over any pending auto-restart, and ends its loop at once.
    cancelRestart(id, 'an admin stopped this sandbox');
    stopLoop(id);
    try {
      const result = await sandboxManager.stop(id);
      if (result && slot.sandbox) {
        if (result.alreadyGone && markSandboxEnded(slot, result)) return snapshot(slot);
        slot.sandbox = { ...slot.sandbox, status: 'stopped', stoppedAt: result.stoppedAt, ranSeconds: result.ranSeconds };
        pushFeed(slot, 'sandbox-stopped', `Desktop sandbox ${result.sessionId} stopped after ${Math.round(result.ranSeconds)}s.`);
      }
    } catch (err) {
      pushFeed(slot, 'sandbox-error', `Desktop sandbox stop failed: ${err.message}`);
      throw err;
    }
    return snapshot(slot);
  }

  /** Asks the sandbox manager to check with E2B now (tests, operators); no-op when sandboxes are off. */
  async function reconcileSandboxes() {
    if (!sandboxManager || typeof sandboxManager.reconcile !== 'function') return [];
    return sandboxManager.reconcile();
  }

  /** Admin only: stream URL incl. VNC password, or null. */
  function getSandboxStream(id) {
    if (!slots.has(id)) throw new RangeError(`unknown slot id: ${id}`);
    return sandboxManager ? sandboxManager.getStream(id) : null;
  }

  return {
    sandboxesEnabled: Boolean(sandboxManager),
    startSandbox,
    stopSandbox,
    getSandboxStream,
    waitForSandboxTask,
    waitForSandboxContext,
    waitForSandboxRestart,
    reconcileSandboxes,
    setAutoRestart,
    stopAutoRestart,
    autoRestartStatus,
    stopActiveLoops,
    activeLoopStatus,
    waitForLoopStep,
    setSlotCount,
    createOwnedSlot,
    getSlots,
    getSlot,
    getActiveCount,
    advance,
    attachSuggestion,
  };
}
