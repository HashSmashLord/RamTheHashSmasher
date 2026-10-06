// Human-moderated idea queue.
//
// Viewer ideas never reach a solver agent directly. `submit()` runs a
// rule-based screen first — this is *not* claimed to be bulletproof, it is
// a fail-closed first filter for obviously malicious/injection-shaped
// content. Anything it rejects never enters the PENDING queue at all; it
// only shows up in the rejected/audit list. Anything it passes still sits
// in PENDING until an admin explicitly approves or rejects it — the human
// approval step is the real gate, not this filter.
//
// An approved idea is attached to one or more solver slots as a labeled
// "viewer suggestion" (see `slots.js#attachSuggestion`) — context, never a
// command. This module never imports the slot manager; the caller passes an
// `attach(slotId, idea)` function so moderation and solver-slot code stay
// decoupled.
//
// Persistence (opt-in, `persistPath`; same atomic-write pattern as
// rams.js/persist.js): confirmed real 2026-10-06, a recurring research-
// guidance review caught a genuinely good, independently-reverified finding
// (an approved idea on sha3-256-r6) silently wiped by an in-memory-only
// reset, three rounds in a row. The queue's own records (pending/approved/
// rejected, the id counter) rehydrate at construction time, same as
// rams.js. The slot *attachment* itself does not: slots are pure runtime
// state (never persisted, recreated fresh on every boot), so there is
// nothing to attach an approved idea to yet at the moment this module is
// constructed -- the roster doesn't exist until later in boot. See
// `reattachApproved` below, called once the roster is actually up.

import { readJsonFile, writeJsonFileAtomic } from './persist.js';

const MAX_LENGTH = 4000;

const FUND_MOVEMENT_RE =
  /\b(send|transfer|withdraw|move|drain|sweep|claim|cash\s*out)\b[\s\S]{0,60}\b(fund|funds|money|treasury|wallet|balance|fee|fees|sol|eth|usdc|usdt|token|tokens|payout)\b|\b(fund|funds|money|treasury|wallet|balance|fee|fees|sol|eth|usdc|usdt|token|tokens|payout)\b[\s\S]{0,60}\b(send|transfer|withdraw|move|drain|sweep|claim|cash\s*out)\b/i;

const KEY_OR_SEED_RE =
  /\b(private\s*key|seed\s*phrase|recovery\s*phrase|mnemonic|wallet\s*seed|api\s*key|secret\s*key|keypair|\.env\b)\b/i;

const INJECTION_RE =
  /\b(ignore|disregard)\b[\s\S]{0,30}\b(all|the|above|prior|previous)\b[\s\S]{0,30}\binstructions?\b|\byou\s+are\s+now\b|\bact\s+as\s+(a|an)\s+system\b|\bsystem\s*prompt\b|\bnew\s+instructions\s*:|\boverride\s+(your|the)\s+instructions\b|\bjailbreak\b|\bsudo\s+(mode|rm)\b|\bdeveloper\s+mode\b|<\|?\s*(system|admin|instruction)s?\s*\|?>/i;

const ZERO_WIDTH_RE = /[​‌‍﻿]/;
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
const LONG_BASE64_RE = /[A-Za-z0-9+/]{80,}={0,2}/;

const RULES = [
  { id: 'empty', test: (t) => t.trim().length === 0, reason: 'Idea text is empty.' },
  {
    id: 'too_long',
    test: (t) => t.length > MAX_LENGTH,
    reason: `Idea text is longer than ${MAX_LENGTH} characters.`,
  },
  {
    id: 'fund_movement',
    test: (t) => FUND_MOVEMENT_RE.test(t),
    reason: 'Reads as an instruction to move, send, withdraw, or claim funds.',
  },
  {
    id: 'key_or_seed',
    test: (t) => KEY_OR_SEED_RE.test(t),
    reason: 'Mentions a private key, seed phrase, mnemonic, or API key.',
  },
  {
    id: 'prompt_injection',
    test: (t) => INJECTION_RE.test(t),
    reason: 'Looks like an attempt to give the system new/overriding instructions.',
  },
  {
    id: 'hidden_content',
    test: (t) => ZERO_WIDTH_RE.test(t) || CONTROL_CHAR_RE.test(t) || LONG_BASE64_RE.test(t),
    reason: 'Contains hidden (zero-width/control) characters or a long encoded blob.',
  },
];

/**
 * Rule-based first pass. Not claimed to catch everything — a human still
 * reviews everything that passes this before it reaches any solver agent.
 *
 * @param {string} rawText
 */
export function screenIdea(rawText) {
  const text = String(rawText ?? '');
  for (const rule of RULES) {
    if (rule.test(text)) return { ok: false, rule: rule.id, reason: rule.reason };
  }
  return { ok: true };
}

/**
 * @param {{ now?: () => string, idPrefix?: string, persistPath?: string|null, log?: (line: string) => void }} [opts]
 */
export function createIdeaQueue({ now = () => new Date().toISOString(), idPrefix = 'idea', persistPath = null, log = () => {} } = {}) {
  let seq = 0;
  /** @type {Map<string, any>} */
  const pending = new Map();
  /** @type {Map<string, any>} */
  const approved = new Map();
  /** @type {Map<string, any>} */
  const rejected = new Map(); // both auto-rejected (screening) and human-rejected

  function persist() {
    if (!persistPath) return;
    writeJsonFileAtomic(
      persistPath,
      { version: 1, seq, pending: [...pending.values()], approved: [...approved.values()], rejected: [...rejected.values()] },
      { log },
    );
  }

  // Rehydrate the real records only -- no slot interaction here, see the
  // module header and reattachApproved below for why that is a separate,
  // later step. A missing file (first boot, or no persistPath at all) or a
  // corrupt/foreign one both leave this queue exactly as empty as it would
  // be without persistence -- readJsonFile has already logged the latter.
  if (persistPath) {
    const loaded = readJsonFile(persistPath, { log });
    if (loaded && Array.isArray(loaded.pending) && Array.isArray(loaded.approved) && Array.isArray(loaded.rejected)) {
      for (const idea of loaded.pending) if (idea?.id) pending.set(idea.id, idea);
      for (const idea of loaded.approved) if (idea?.id) approved.set(idea.id, idea);
      for (const idea of loaded.rejected) if (idea?.id) rejected.set(idea.id, idea);
      if (Number.isInteger(loaded.seq) && loaded.seq > seq) seq = loaded.seq;
      log(`moderation: rehydrated ${pending.size} pending, ${approved.size} approved, ${rejected.size} rejected idea(s) from ${persistPath}.`);
    } else if (loaded) {
      log(`moderation: ${persistPath} did not have the expected shape, starting empty.`);
    }
  }

  /**
   * @param {string} text
   * @param {{ author?: string }} [meta]
   */
  function submit(text, meta = {}) {
    const id = `${idPrefix}-${seq++}`;
    const screening = screenIdea(text);
    const base = { id, text: String(text ?? ''), author: meta.author || null, submittedAt: now() };
    if (!screening.ok) {
      rejected.set(id, { ...base, status: 'auto-rejected', rule: screening.rule, reason: screening.reason });
      persist();
      return { ok: false, id, rule: screening.rule, reason: screening.reason };
    }
    pending.set(id, { ...base, status: 'pending' });
    persist();
    return { ok: true, id, status: 'pending' };
  }

  const listPending = () => [...pending.values()];
  const listApproved = () => [...approved.values()];
  const listRejected = () => [...rejected.values()];

  /**
   * Admin-only: approve a pending idea and attach it to one or more solver
   * slots. `attach`, if given, is called once per target slot id as
   * `attach(slotId, { id, text })` — purely a context-attach, never an
   * action on funds or allocation.
   *
   * @param {string} id
   * @param {{ targetSlotIds?: string[], attach?: (slotId: string, idea: { id: string, text: string }) => void }} [opts]
   */
  function approve(id, { targetSlotIds = [], attach } = {}) {
    const idea = pending.get(id);
    if (!idea) throw new RangeError(`no pending idea with id ${id}`);
    pending.delete(id);
    const record = { ...idea, status: 'approved', decidedAt: now(), targetSlotIds: [...targetSlotIds] };
    approved.set(id, record);
    persist();
    if (typeof attach === 'function') {
      for (const slotId of targetSlotIds) attach(slotId, { id: record.id, text: record.text });
    }
    return record;
  }

  /**
   * Replays every currently-approved idea's real attachment onto today's
   * roster — called once, after the roster actually exists (see
   * server/index.js), never at construction time. `attach` is the exact
   * same function the live admin approve route already uses
   * (`(slotId, idea) => store.slotManager.attachSuggestion(slotId, idea)`).
   * A target slot that no longer exists (the roster shrank, or an owned
   * slot was retired) is skipped and logged, never thrown -- one missing
   * slot must never stop the rest of the queue from reattaching, and this
   * runs during boot, before anything else can handle a thrown error.
   * @param {(slotId: string, idea: { id: string, text: string }) => void} attach
   */
  function reattachApproved(attach) {
    if (typeof attach !== 'function') return { reattached: 0, skipped: 0 };
    let reattached = 0;
    let skipped = 0;
    for (const record of approved.values()) {
      for (const slotId of record.targetSlotIds ?? []) {
        try {
          attach(slotId, { id: record.id, text: record.text });
          reattached++;
        } catch (err) {
          skipped++;
          log(`moderation: could not reattach approved idea ${record.id} to ${slotId} on boot, continuing: ${err?.message || err}`);
        }
      }
    }
    if (reattached || skipped) log(`moderation: reattached ${reattached} approved idea/slot pair(s) on boot (${skipped} skipped).`);
    return { reattached, skipped };
  }

  /**
   * @param {string} id
   * @param {string} [reason]
   */
  function reject(id, reason = '') {
    const idea = pending.get(id);
    if (!idea) throw new RangeError(`no pending idea with id ${id}`);
    pending.delete(id);
    const record = { ...idea, status: 'rejected', decidedAt: now(), reason };
    rejected.set(id, record);
    persist();
    return record;
  }

  return { submit, listPending, listApproved, listRejected, approve, reject, reattachApproved };
}
