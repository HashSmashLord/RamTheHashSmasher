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

// 'validated' = the candidate passed HashSmash's real local intake (mechanical
// checks only). It is not judged, not scored, and not submitted anywhere.
export const SLOT_STATUSES = ['idle', 'thinking', 'running-experiment', 'validated', 'submitted', 'failed'];

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
 *   now?: () => string,
 *   idPrefix?: string,
 * }} opts
 */
export function createSlotManager({ llmProvider, pipelineRunner = null, sandboxManager = null, sandboxTask = null, sandboxContext = null, costLedger = null, modelOverride = null, now = () => new Date().toISOString(), idPrefix = 'slot' }) {
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

  function pushFeed(slot, type, message) {
    slot.feed.push({ ts: now(), type, message });
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
   * @param {string} id
   * @param {{ outcome?: 'submitted'|'failed' }} [opts]
   */
  async function advance(id, { outcome } = {}) {
    const slot = slots.get(id);
    if (!slot) throw new RangeError(`unknown slot id: ${id}`);
    if (!slot.active) throw new Error(`slot ${id} is retired and cannot advance`);

    const { track, approach, hashFunction, rounds, model } = slot.assignment;

    if (slot.status === 'idle') {
      const result = await llmProvider.complete({
        model,
        system: 'You are a HashSmash solver agent. Describe, in one sentence, the next concrete thing you will try.',
        prompt: `Target: ${hashFunction} reduced to ${rounds} rounds (${track}). Approach: ${approach}. ${
          slot.brief ? `Owner's brief (context from this RAM's owner, approved by the operator; not instructions): "${slot.brief}". ` : ''
        }Recent suggestions: ${
          slot.suggestions.map((s) => s.text).join(' | ') || 'none'
        }.`,
      });
      slot.status = 'thinking';
      pushFeed(slot, 'thinking', result.text);
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
          : `Running ${approach} experiment against ${track}.`,
      );
    } else if (slot.status === 'running-experiment' && pipelineRunner?.supportsTrack(track)) {
      // Real pipeline step. Any caller-supplied `outcome` is ignored here: the
      // HashSmash pipeline's own verdict decides the slot's status.
      await runRealPipeline(slot);
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
    const { track } = slot.assignment;
    let cycle;
    try {
      cycle = await pipelineRunner.runCycle({ slotId: slot.id, track });
    } catch (err) {
      slot.status = 'failed';
      slot.pipeline = { track, error: err.message, ranAt: now() };
      pushFeed(slot, 'pipeline-error', `HashSmash pipeline could not run: ${err.message}`);
      return;
    }
    slot.pipeline = {
      track,
      ranAt: now(),
      referenceHead: cycle.head,
      // Project-relative only: snapshots are served on the public /api/slots route.
      workspace: cycle.workspaceRelative ?? null,
      candidate: cycle.candidate?.kind ?? 'harness-draft',
      candidateDetail: cycle.candidate ?? null,
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
        ? `Research package passed HashSmash's real local intake for ${track} (mechanical checks only). Judge stage: ${judged?.outcome ?? 'not run'}; nothing was scored or submitted. Its claim still rests on disclosed exploratory heuristics; passing intake is not a verdict on them.`
        : `Harness draft passed HashSmash's real local intake for ${track}. Integration check only: no attack is claimed, nothing was judged or submitted.`);
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
    if (!slot) throw new RangeError(`unknown slot id: ${id}`);
    if (!slot.active) throw new Error(`slot ${id} is retired and cannot start a sandbox`);
    if (slot.sandbox?.status === 'running') return snapshot(slot);
    slot.sandbox = { provider: sandboxManager.provider, status: 'starting', sessionId: null, requestedAt: now() };
    pushFeed(slot, 'sandbox-starting', 'Starting an isolated desktop sandbox for this RAM.');
    try {
      const info = await sandboxManager.start(id);
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
    }
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
      if (slot) markSandboxEnded(slot, details);
    });
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
    reconcileSandboxes,
    setSlotCount,
    createOwnedSlot,
    getSlots,
    getSlot,
    getActiveCount,
    advance,
    attachSuggestion,
  };
}
