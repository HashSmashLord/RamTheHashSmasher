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
// track the runner supports (today: sha256-r31-exploratory) stops simulating
// its experiment step and instead drives HashSmash's REAL local pipeline —
// writes an honestly-labeled harness DRAFT into its own clone of the vendored
// repo, then runs the real `local_tracks.py check` and
// `hashsmash_pipeline.py intake`. The slot's outcome is whatever that real
// pipeline returns. That proves the integration works; it is not, and is never
// reported as, a cryptanalysis result. Other tracks keep the mock lifecycle.
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
// slot stops its sandbox so nothing is left billing. The sandbox does not run
// the slot's work yet: that still happens on the host as before.

import { assignmentForIndex } from './targets.js';

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
 *   modelOverride?: string|null,
 *   now?: () => string,
 *   idPrefix?: string,
 * }} opts
 */
export function createSlotManager({ llmProvider, pipelineRunner = null, sandboxManager = null, modelOverride = null, now = () => new Date().toISOString(), idPrefix = 'slot' }) {
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

  function pushFeed(slot, type, message) {
    slot.feed.push({ ts: now(), type, message });
    slot.updatedAt = now();
  }

  function snapshot(slot) {
    return {
      id: slot.id,
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
    const active = activeSlots();
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
        prompt: `Target: ${hashFunction} reduced to ${rounds} rounds (${track}). Approach: ${approach}. Recent suggestions: ${
          slot.suggestions.map((s) => s.text).join(' | ') || 'none'
        }.`,
      });
      slot.status = 'thinking';
      pushFeed(slot, 'thinking', result.text);
    } else if (slot.status === 'thinking') {
      slot.status = 'running-experiment';
      pushFeed(
        slot,
        'running-experiment',
        pipelineRunner?.supportsTrack(track)
          ? `Next step runs HashSmash's real local pipeline (check + intake) on a labeled harness draft for ${track}.`
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
      candidate: 'harness-draft',
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
      pushFeed(slot, 'validated', `Harness draft passed HashSmash's real local intake for ${track}. Integration check only: no attack is claimed, nothing was judged or submitted.`);
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
    } catch (err) {
      slot.sandbox = { provider: sandboxManager.provider, status: 'failed', sessionId: null, error: err.message, failedAt: now() };
      pushFeed(slot, 'sandbox-error', `Desktop sandbox could not start: ${err.message}`);
      throw err;
    }
    return snapshot(slot);
  }

  /**
   * Kills the slot's sandbox, if it has a live one. Works on retired slots too.
   * @param {string} id
   */
  async function stopSandbox(id) {
    requireSandboxes();
    const slot = slots.get(id);
    if (!slot) throw new RangeError(`unknown slot id: ${id}`);
    try {
      const result = await sandboxManager.stop(id);
      if (result && slot.sandbox) {
        slot.sandbox = { ...slot.sandbox, status: 'stopped', stoppedAt: result.stoppedAt, ranSeconds: result.ranSeconds };
        pushFeed(slot, 'sandbox-stopped', `Desktop sandbox ${result.sessionId} stopped after ${Math.round(result.ranSeconds)}s.`);
      }
    } catch (err) {
      pushFeed(slot, 'sandbox-error', `Desktop sandbox stop failed: ${err.message}`);
      throw err;
    }
    return snapshot(slot);
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
    setSlotCount,
    getSlots,
    getSlot,
    getActiveCount,
    advance,
    attachSuggestion,
  };
}
