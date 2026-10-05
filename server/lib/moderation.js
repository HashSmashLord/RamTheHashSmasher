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
 * @param {{ now?: () => string, idPrefix?: string }} [opts]
 */
export function createIdeaQueue({ now = () => new Date().toISOString(), idPrefix = 'idea' } = {}) {
  let seq = 0;
  /** @type {Map<string, any>} */
  const pending = new Map();
  /** @type {Map<string, any>} */
  const approved = new Map();
  /** @type {Map<string, any>} */
  const rejected = new Map(); // both auto-rejected (screening) and human-rejected

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
      return { ok: false, id, rule: screening.rule, reason: screening.reason };
    }
    pending.set(id, { ...base, status: 'pending' });
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
    if (typeof attach === 'function') {
      for (const slotId of targetSlotIds) attach(slotId, { id: record.id, text: record.text });
    }
    return record;
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
    return record;
  }

  return { submit, listPending, listApproved, listRejected, approve, reject };
}
