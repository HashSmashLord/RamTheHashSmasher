// HashSmash pipeline runner: drives the REAL vendored competition repo
// (`reference/hash-smash/`) through its own CLI from Node.
//
// What this module proves, and what it does not:
//
//   PROVEN: a RAM slot can run HashSmash's own organizer-owned scripts
//   (`scripts/local_tracks.py list|check`, `scripts/hashsmash_pipeline.py
//   intake`) against a candidate package and get back the pipeline's real
//   verdict (exit code, status, package_sha256, evidence file). Nothing here
//   re-implements or mocks the Python; the Python decides.
//
//   NOT CLAIMED by the harness path: any cryptanalysis result. For every
//   harness-draft track (sha256-r31, sha3-256-r5, sha3-256-r6, blake3-r1,
//   blake3-r2 — see PIPELINE_TRACKS) the candidate this module writes is a
//   harness-test DRAFT built from the organizer's own per-track
//   `LaneTrack.draft_claim()` template (verifier/frontier_tracks.py; the
//   template logic is already generic across every frontier family —
//   nothing here reimplements it per hash function), labeled as a test in
//   both claim.json and proof.md. HashSmash's intake refuses to send a draft
//   to the judge (`draft_not_submitted`), so that package can never be judged,
//   scored, or ranked.
//
//   RESEARCH path (sha256-r32 only, see RESEARCH_CANDIDATES): the slot writes
//   a real, committed candidate package (research/sha256-r32/package/). It
//   extends the existing r32 package with an independent reproduction and a
//   staged tail-yield measurement; its claim still rests on disclosed
//   exploratory heuristics and nobody has judged it. Passing intake means
//   "mechanically well-formed" for this package too, never "a real attack".
//
// Safety rails:
//   - Every slot works in its own throwaway `git clone` of the vendored repo
//     under `workspacesDir`. The vendored repo itself (and its real accepted
//     sha256-r31 candidate) is never written to.
//   - Python runs with argv arrays (no shell) and a minimal environment: no
//     provider key is ever passed to credential-free stages.
//   - `judge` (a paid model call) and `score` run only when `judgeAllowed`,
//     which `pipelinePolicy()` grants only under the same RAMHERD_LIVE +
//     OPENROUTER_API_KEY switch as the LLM provider PLUS its own
//     RAMHERD_HASHSMASH_JUDGE=true flag.
//   - Live submission to the real HashSmash/Yukon competition (`submitLive`,
//     live-submit.js) refuses unless RAMHERD_HASHSMASH_LIVE_SUBMIT=true and a
//     real YUKON_API_KEY are set (off by default), and then only for a
//     'ready', adversarially verified loop-draft whose real check and intake
//     both came back ok.

import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLiveMode } from './llm.js';
import { liveSubmitPolicy, liveSubmitEligibility, collectCandidateFiles, LIVE_SUBMIT_FLAG } from './live-submit.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_REFERENCE_ROOT = join(PROJECT_ROOT, 'reference', 'hash-smash');
export const DEFAULT_WORKSPACES_DIR = join(PROJECT_ROOT, '.ramherd', 'workspaces');
// Attribution records live OUTSIDE every slot's workspace clone, never inside
// the candidate package or the vendored repo tree: nothing the organizer's
// own `check`/`intake` scripts walk ever sees an extra file from us. This is
// our own bookkeeping only, kept ready for the day a real external submission
// path exists (see `writeAttribution` below).
export const DEFAULT_ATTRIBUTION_DIR = join(PROJECT_ROOT, '.ramherd', 'attribution');

/**
 * Tracks this runner drives today: every active exploratory track in the
 * manifest (targets.js's ACTIVE_TRACKS / the real repo's six solver
 * assignments). sha256-r31-exploratory is the research brief's recommended
 * first target (docs/research/hashsmash-technical-brief.md section 5) and
 * runs the labeled harness draft; so do sha3-256-r5/r6 and blake3-r1/r2 —
 * verified against the real vendored repo (`verifier.frontier_tracks.
 * get_frontier_track(track).draft_claim()`, `scripts/local_tracks.py check`,
 * `scripts/hashsmash_pipeline.py intake`) to land on the same honest
 * draft_not_submitted verdict as sha256-r31, nothing assumed. sha256-r32-
 * exploratory runs the committed research package below (RESEARCH_CANDIDATES);
 * it is still the only track with real research content. No other tracks
 * are currently defined as active manifest assignments (see frontier-v1.json
 * in the vendored repo): a track outside this list keeps the slot manager's
 * mock lifecycle.
 */
export const PIPELINE_TRACKS = Object.freeze([
  'sha256-r31-exploratory',
  'sha256-r32-exploratory',
  'sha3-256-r5-exploratory',
  'sha3-256-r6-exploratory',
  'blake3-r1-exploratory',
  'blake3-r2-exploratory',
]);

/**
 * Tracks with real research content. A slot on one of these copies the
 * committed package (claim.json, proof.md, certificates/manifest.json) into
 * its own clone instead of drafting the empty template. The package is never
 * edited by the slot: what passes or fails intake is exactly what is in git.
 */
export const RESEARCH_CANDIDATES = Object.freeze({
  'sha256-r32-exploratory': Object.freeze({
    dir: join(PROJECT_ROOT, 'research', 'sha256-r32', 'package'),
    files: Object.freeze(['claim.json', 'proof.md', 'certificates/manifest.json']),
    summary: 'sha256-r32 package extended with an independent reproduction of its finite construction and a staged measurement of its weakest premise (average tail yield); same 2^86 claim, still resting on disclosed exploratory heuristics, not judged',
  }),
});

/** Marker placed in claim.json restrictions and proof.md of every harness draft. */
export const HARNESS_MARKER = 'HashRammers harness integration test';

/**
 * Marker placed in claim.json restrictions and proof.md of a loop-authored
 * draft (writeLoopDraftCandidate): a candidate whose claim.claim numbers and
 * one heuristic were written by the active research loop's own model this
 * session, from its own real research, instead of the organizer's empty
 * draft_claim() template. See validateLoopAttempt and writeLoopDraftCandidate.
 */
export const LOOP_DRAFT_MARKER = 'HashRammers loop-authored draft';

/**
 * Reads the env once and decides what the pipeline may do. Defaults are all
 * off: the pipeline only runs when RAMHERD_PIPELINE=local, and even then only
 * the credential-free local stages run unless the paid-judge gate is open.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function pipelinePolicy(env = process.env) {
  const enabled = env.RAMHERD_PIPELINE === 'local';
  const judgeAllowed = enabled && isLiveMode(env) && env.RAMHERD_HASHSMASH_JUDGE === 'true';
  return Object.freeze({
    enabled,
    judgeAllowed,
    // Legacy flag: recorded so the UI/logs can show someone asked for it; never acted on.
    liveSubmitRequested: env.RAMHERD_HASHSMASH_SUBMIT === 'true',
    // The real gate (live-submit.js): RAMHERD_HASHSMASH_LIVE_SUBMIT=true AND a
    // real YUKON_API_KEY AND the pipeline itself on. Off by default.
    liveSubmitAllowed: enabled && liveSubmitPolicy(env).allowed,
  });
}

// ---------------------------------------------------------------------------
// Minimal JSON-Schema subset validator, driven by the repo's REAL schema files
// (so it can't drift from them). It is a fast, friendly precheck only; the
// authoritative validation is HashSmash's own Python (`check` / `intake`).
// Supports exactly the keywords those schemas use.
// ---------------------------------------------------------------------------

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(expected, v) {
  const actual = typeOf(v);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

export function validateAgainstSchema(schema, value, path = '$', errors = []) {
  if (!schema || typeof schema !== 'object') return errors;
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
    return errors;
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: must be one of ${schema.enum.join(', ')}`);
    return errors;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: too long`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: too many items`);
    if (schema.items) value.forEach((item, i) => validateAgainstSchema(schema.items, item, `${path}[${i}]`, errors));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}: missing required field "${key}"`);
    }
    const props = schema.properties || {};
    for (const [key, sub] of Object.entries(value)) {
      if (key in props) validateAgainstSchema(props[key], sub, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected field "${key}"`);
    }
  }
  return errors;
}

/**
 * Counts proof.md's lines the exact same way HashSmash's own real verifier
 * does (`verifier/intake.py`'s `_number_proof`: Python's `str.splitlines()`),
 * so a `proof:<n>` evidence reference this precheck accepts is one the real
 * `check`/`intake` will also accept. Deliberately NOT `text.split('\n')
 * .length`: that overcounts by one whenever the text ends with a newline
 * (JS's split leaves a trailing empty string; Python's splitlines does not),
 * which would let this precheck pass a reference the real verifier rejects
 * as "proof reference outside document" — exactly the gap a loop-authored
 * draft's own computed evidence_ids must not fall into.
 */
export function countProofLines(text) {
  const s = String(text ?? '');
  if (s === '') return 0;
  const parts = s.split('\n');
  if (s.endsWith('\n')) parts.pop();
  return parts.length;
}

/**
 * Precheck of a candidate package's shape against the repo contract
 * (brief section 1.1) and the real claim/certificate schemas. Returns every
 * problem found rather than stopping at the first.
 *
 * @param {string} candidateDir
 * @param {string} repoRoot - a HashSmash checkout, used to load the real schemas
 */
export function precheckCandidate(candidateDir, repoRoot) {
  const errors = [];
  if (!existsSync(candidateDir)) return { ok: false, errors: ['candidate directory does not exist'], claim: null };
  for (const name of readdirSync(candidateDir)) {
    const st = lstatSync(join(candidateDir, name));
    if (st.isSymbolicLink()) errors.push(`${name}: symlinks are not allowed`);
    else if (st.isDirectory() && !['certificates', 'experiments'].includes(name)) errors.push(`${name}/: only certificates/ and experiments/ subdirectories are allowed`);
    else if (st.isFile() && !['claim.json', 'proof.md'].includes(name)) errors.push(`${name}: unexpected file at package root`);
  }
  for (const required of ['claim.json', 'proof.md']) {
    if (!existsSync(join(candidateDir, required))) errors.push(`${required}: required file missing`);
  }

  let claim = null;
  if (existsSync(join(candidateDir, 'claim.json'))) {
    try {
      claim = JSON.parse(readFileSync(join(candidateDir, 'claim.json'), 'utf8'));
    } catch (err) {
      errors.push(`claim.json: invalid JSON (${err.message})`);
    }
  }
  if (claim) {
    const schema = JSON.parse(readFileSync(join(repoRoot, 'schemas', 'claim-frontier-v3.schema.json'), 'utf8'));
    validateAgainstSchema(schema, claim, 'claim.json', errors);
    if (claim.certificate_manifest) {
      const manifestPath = join(candidateDir, 'certificates', 'manifest.json');
      if (!existsSync(manifestPath)) errors.push('certificates/manifest.json: declared in claim.json but missing');
      else {
        const certSchema = JSON.parse(readFileSync(join(repoRoot, 'schemas', 'certificate-manifest-local-v2.schema.json'), 'utf8'));
        try {
          validateAgainstSchema(certSchema, JSON.parse(readFileSync(manifestPath, 'utf8')), 'certificates/manifest.json', errors);
        } catch (err) {
          errors.push(`certificates/manifest.json: invalid JSON (${err.message})`);
        }
      }
    }
    if (claim.experiment_manifest && !existsSync(join(candidateDir, 'experiments', 'manifest.json'))) {
      errors.push('experiments/manifest.json: declared in claim.json but missing');
    }
    // proof:<a>-<b> evidence references must fall inside proof.md's line count.
    if (existsSync(join(candidateDir, 'proof.md')) && Array.isArray(claim.heuristics)) {
      const lines = countProofLines(readFileSync(join(candidateDir, 'proof.md'), 'utf8'));
      for (const h of claim.heuristics) {
        for (const ref of h?.evidence_ids || []) {
          const m = /^proof:(\d+)(?:-(\d+))?$/.exec(ref);
          if (m && Number(m[2] ?? m[1]) > lines) errors.push(`heuristic ${h.id}: ${ref} is past the end of proof.md (${lines} lines)`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors, claim };
}

/** Matches the "PR#<number>" form a drafting call uses to cite a real competitor's open PR instead of an ePrint id. */
const PEER_CITATION_RE = /^PR#(\d+)$/i;
/** Matches the "EXP#<number>" form a drafting call uses to cite one of this session's own real experiment/verify results. */
const EXPERIMENT_CITATION_RE = /^EXP#(\d+)$/i;

/**
 * Resolves an "EXP#<n>" id against this session's own real experiment
 * records (slots.js runLoopExperiment / runLoopVerify). Only a record whose
 * status is 'completed' resolves: a run that errored, timed out, or whose
 * pair the organizer's own Python recomputation DISAGREED with (status
 * 'discarded') is not a result and can never be cited.
 */
function findExperiment(id, experiments) {
  const m = EXPERIMENT_CITATION_RE.exec(String(id ?? '').trim());
  if (!m) return null;
  const want = `EXP#${Number(m[1])}`;
  const rec = (experiments || []).find((e) => e?.id === want);
  if (!rec || rec.status !== 'completed' || !rec.result) return null;
  return {
    kind: 'experiment',
    id: rec.id,
    experimentKind: rec.result.kind,
    track: rec.result.track,
    summary: rec.summary ?? null,
    result: rec.result,
    organizerCheck: rec.organizerCheck ?? null,
  };
}

/**
 * Resolves a drafting call's CITED_PAPER_ID against the slot's own real
 * session state — either a real IACR ePrint search result
 * (`lastSearchResults`, sandbox-activity.js's browseLiterature) or a real
 * competitor pull request on the real HashSmash repo
 * (`lastPeerResults`, sandbox-activity.js's browsePeerSubmissions) — and
 * returns a small tagged record describing which, or `null` if it matches
 * neither. This is the one place that decides what a citation referred to;
 * both validateLoopAttempt (does it exist at all) and slots.js's
 * runLoopDraftAttempt (what to actually write into the candidate) call this
 * so the two can never disagree about what was cited.
 *
 * Two more real sources (2026-10-07):
 *   - "EXP#<n>": one of this session's own real, completed experiment or
 *     verify results (`experiments`, slots.js) — the RAM's own computed
 *     evidence, resolved the same way: it must actually exist in session
 *     state, never just be named.
 *   - an ePrint id this session actually READ (`readPapers`,
 *     sandbox-activity.js readPaper: title, authors and abstract really
 *     fetched from the paper's own page) resolves too, with `read: true` and
 *     the real abstract, so downstream text can say honestly that more than
 *     a title was read. A search-result-only paper keeps the exact old shape.
 *
 * @param {string|null} citedPaperId
 * @param {{ lastSearchResults?: Array<{id: string, title: string}>, lastPeerResults?: Array<{number: number, login: string|null, title: string, claimedScore: string|null, url: string|null}>, readPapers?: Array<{id: string, title: string, authors?: string[], abstract?: string, url?: string}>, experiments?: Array<any> }} [ctx]
 */
export function findCitedReference(citedPaperId, { lastSearchResults = [], lastPeerResults = [], readPapers = [], experiments = [] } = {}) {
  if (typeof citedPaperId !== 'string' || !citedPaperId.trim()) return null;
  const id = citedPaperId.trim();
  const prMatch = PEER_CITATION_RE.exec(id);
  if (prMatch) {
    const number = Number(prMatch[1]);
    const pr = lastPeerResults.find((r) => r?.number === number);
    return pr ? { kind: 'peer-pr', number: pr.number, login: pr.login ?? null, title: pr.title, url: pr.url ?? null, claimedScore: pr.claimedScore ?? null } : null;
  }
  if (EXPERIMENT_CITATION_RE.test(id)) return findExperiment(id, experiments);
  const read = (readPapers || []).find((r) => r?.id === id && r.title);
  if (read) {
    return { kind: 'eprint', id: read.id, title: read.title, read: true, authors: read.authors ?? [], abstract: read.abstract ?? '', url: read.url ?? null };
  }
  const paper = lastSearchResults.find((r) => r?.id === id);
  return paper ? { kind: 'eprint', id: paper.id, title: paper.title } : null;
}

/**
 * An affirmative claim, in a drafted STATEMENT or EXTRAPOLATION, that this
 * session itself found/produced/computed an actual collision. Deliberately
 * narrow (it does not look at LIMITATIONS, where "no collision was found" is
 * the honest, expected wording).
 */
const CLAIMS_FOUND_COLLISION_RE = /\b(?:we|i|this (?:session|ram|run|experiment)|the experiment|my experiment)\s+(?:have\s+|has\s+)?(?:found|produced|obtained|computed|generated)\s+(?:a|an|the)\s+(?:real\s+|full\s+|genuine\s+|actual\s+|complete\s+)?collision\b/i;

/**
 * Structural honesty gate for a loop-drafted candidate attempt (see
 * sandbox-activity.js's parseDraftAttempt, slots.js's active loop), applied
 * BEFORE any file is written and IN ADDITION TO the real schema/precheck
 * every candidate goes through regardless. This is not a prompt instruction
 * the model can forget to follow: a call that produces something shaped
 * wrong, with an out-of-range number, or an unreal citation is rejected
 * here, deterministically, every time.
 *
 * `lastSearchResults` must be the slot's own real IACR ePrint search results
 * from THIS session (sandbox-activity.js's browseLiterature output), and
 * `lastPeerResults` its own real GitHub lookup of other competitors' open
 * PRs on this track this session (browsePeerSubmissions output) — never an
 * arbitrary string the model typed. `attempt.citedPaperId` is required to
 * resolve (via findCitedReference) to one of those two real sources: the
 * one place this harness checks that a loop's claim of "I looked this up"
 * actually happened, rather than trusting the model's say-so. Citing a real
 * competitor's PR is explicitly allowed here, but it is still just citing
 * another competitor's own self-reported, unverified claim — never treated
 * as more certain than that.
 *
 * Since 2026-10-07 a citation may also be one of this session's own real,
 * completed experiments ("EXP#<n>") or a paper this session actually read,
 * and an attempt may name an additional supporting experiment
 * (EXPERIMENT_ID). Each is resolved the same rigorous way (findCitedReference
 * against real session state; a named-but-unreal experiment is rejected).
 * Every check that existed before is unchanged; the additions only ever
 * reject more:
 *   - EXPERIMENT_ID, when given, must resolve to a real completed session
 *     experiment;
 *   - a cited/supporting experiment must be for this exact track (`track`);
 *   - STATEMENT/EXTRAPOLATION may not say this session found an actual
 *     collision unless a session VERIFY record shows a genuine full
 *     collision that the organizer's own Python recomputation confirmed.
 *
 * @param {ReturnType<typeof import('./sandbox-activity.js').parseDraftAttempt>} attempt
 * @param {{ lastSearchResults?: Array<{id: string, title: string}>, lastPeerResults?: Array<{number: number}>, readPapers?: Array<any>, experiments?: Array<any>, track?: string|null }} [ctx]
 */
export function validateLoopAttempt(attempt, { lastSearchResults = [], lastPeerResults = [], readPapers = [], experiments = [], track = null } = {}) {
  const errors = [];
  if (!attempt || typeof attempt !== 'object' || attempt.attempt !== true) {
    return { ok: false, errors: ['no drafting attempt was actually made'] };
  }
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!num(attempt.timeLog2) || attempt.timeLog2 < 0) errors.push('TIME_LOG2 must be a real non-negative number');
  if (!num(attempt.memoryLog2Bytes) || attempt.memoryLog2Bytes < 0) errors.push('MEMORY_LOG2_BYTES must be a real non-negative number');
  if (!num(attempt.successProbability) || attempt.successProbability < 0.39 || attempt.successProbability > 1) {
    errors.push('SUCCESS_PROBABILITY must be a real number between 0.39 and 1');
  }
  if (typeof attempt.heuristicId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(attempt.heuristicId)) {
    errors.push('HEURISTIC_ID is missing or not a valid id');
  }
  for (const field of ['statement', 'scope', 'extrapolation', 'limitations']) {
    if (typeof attempt[field] !== 'string' || attempt[field].trim().length < 20) {
      errors.push(`${field.toUpperCase()} must be a real, specific, disclosed sentence (got nothing usable)`);
    }
  }
  // Never let the loop write a limitations section that claims more certainty
  // than one session of reading and thinking can honestly support.
  if (/\b(proven|verified|confirmed collision|guaranteed|no doubt)\b/i.test(attempt.limitations || '')) {
    errors.push('LIMITATIONS must not claim the bound is proven, verified or guaranteed; this is at most an estimate under disclosed premises');
  }
  // Real-grounding rail: the citation must resolve to something this session
  // actually fetched for real — a real ePrint search result or a real
  // competitor PR this session actually looked at — never an invented or
  // remembered id.
  const sources = { lastSearchResults, lastPeerResults, readPapers, experiments };
  const cited = attempt.citedPaperId && attempt.citedPaperId !== 'NONE' ? findCitedReference(attempt.citedPaperId, sources) : null;
  if (!attempt.citedPaperId || attempt.citedPaperId === 'NONE') {
    errors.push('CITED_PAPER_ID is required: a loop-drafted claim must cite either a real ePrint paper or a real competitor PR this session actually looked up');
  } else if (!cited) {
    errors.push(`CITED_PAPER_ID "${attempt.citedPaperId}" does not match any real result from this session's own ePrint search or GitHub PR lookup`);
  }
  // Additional real-grounding rails for the research tools (2026-10-07).
  let supporting = null;
  if (attempt.experimentId && !/^none$/i.test(String(attempt.experimentId).trim())) {
    supporting = findCitedReference(attempt.experimentId, { experiments });
    if (!supporting || supporting.kind !== 'experiment') {
      errors.push(`EXPERIMENT_ID "${attempt.experimentId}" does not match any real, completed experiment this session actually ran`);
      supporting = null;
    }
  }
  for (const ref of [cited, supporting]) {
    if (ref?.kind === 'experiment' && track && ref.track !== track) {
      errors.push(`${ref.id} was run on ${ref.track}, not on this track (${track})`);
    }
  }
  const claimsCollision = ['statement', 'extrapolation'].some((f) => CLAIMS_FOUND_COLLISION_RE.test(attempt[f] || ''));
  if (claimsCollision) {
    const confirmed = (experiments || []).some((e) => e?.status === 'completed' && e.result?.kind === 'verify' && e.result.fullCollision === true
      && e.organizerCheck?.agrees === true && (!track || e.result.track === track));
    if (!confirmed) {
      errors.push('STATEMENT/EXTRAPOLATION says this session found an actual collision, but no VERIFY this session confirmed a genuine full collision with the organizer\'s own reference checker');
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Short human label for any citation findCitedReference returns. */
export function citationLabel(ref) {
  if (!ref) return 'nothing';
  if (ref.kind === 'peer-pr') return `competitor PR #${ref.number}`;
  if (ref.kind === 'experiment') return `this session's own experiment ${ref.id}`;
  return `ePrint ${ref.id}${ref.read ? ' (abstract read)' : ''}`;
}

/** One-line, plain description of a cited/supporting session experiment (restrictions, summaries). */
export function describeExperimentRef(ref) {
  const r = ref.result;
  const org = ref.organizerCheck;
  const orgText = org?.ran ? (org.agrees ? 'the organizer\'s own reference Python recomputed its reported pair and agreed' : 'no organizer recomputation agreement') : 'no pair needed organizer recomputation';
  if (r.kind === 'birthday') {
    return `${ref.id}: a real bounded birthday experiment on ${r.track} (${r.target.algorithm}, ${r.target.rounds} rounds) — ${r.samplesRun} samples actually hashed (seed "${r.params.seed}"), `
      + `${r.prefixCollisionPairs} distinct pair(s) agreeing on the first ${r.params.prefixBits} digest bits vs about ${Number(r.expectedPairsIfRandom).toPrecision(3)} expected for a random function; ${orgText}. A prefix match is not a collision.`;
  }
  if (r.kind === 'differential') {
    return `${ref.id}: a real bounded differential experiment on ${r.track} (${r.target.algorithm}, ${r.target.rounds} rounds) — ${r.samplesRun} message pairs differing by ${r.params.diffHex} at byte ${r.params.diffAt} (seed "${r.params.seed}"), `
      + `mean output-difference weight ${Number(r.meanOutputDiffWeight).toFixed(2)}/256, minimum ${r.minOutputDiffWeight}, ${r.significantlyBiasedBits} significantly biased output bit(s), ${r.zeroDifferencePairs} identical-digest pair(s); ${orgText}. A low-weight difference is not a collision.`;
  }
  return `${ref.id}: a real VERIFY of one message pair on ${r.track} — distinct ${r.distinct}, all 256 digest bits equal ${r.digestsEqual} (equal prefix ${r.equalPrefixBits} bits, Hamming distance ${r.hammingDistance}); ${org?.ran ? (org.agrees ? 'the organizer\'s own reference Python recomputed both digests and agreed' : 'the organizer recomputation did not agree') : 'the organizer\'s Python was not available to recompute it'}.`;
}

/** proof.md lines describing a session experiment exactly as it was recorded: parameters, real numbers, how to reproduce. */
function experimentEvidenceLines(ref, heading) {
  const r = ref.result;
  const lines = [heading, '', `- ${describeExperimentRef(ref)}`, ''];
  lines.push(`- Target: \`${r.target.profileId}\` (${r.target.algorithm}, prefix rounds ${r.target.rounds}), as defined by the organizer's target profile.`);
  if (r.kind === 'birthday' || r.kind === 'differential') {
    lines.push(`- Parameters: \`${JSON.stringify(r.params)}\`; samples requested ${r.samplesRequested}, actually run ${r.samplesRun}${r.stoppedEarly ? ' (stopped early at the per-call time cap)' : ''}; ${r.hashEvaluations} target hash evaluations in ${Math.round(r.elapsedMs)} ms.`);
    if (r.kind === 'birthday') {
      lines.push(`- Organizer-vocabulary event: \`digest-xor-mask\` with the top ${r.params.prefixBits} bits masked, expected 0. Repeated (identical) inputs excluded: ${r.repeatedInputs}. Full-collision pairs: ${r.fullCollisionPairs}.`);
    } else {
      lines.push(`- Output bits never flipped: ${r.bitsNeverFlipped}; always flipped: ${r.bitsAlwaysFlipped}; largest single-bit bias ${Number(r.maxBitBias).toFixed(4)} (Hoeffding/Bonferroni threshold ${r.biasThreshold === null ? 'n/a' : Number(r.biasThreshold).toFixed(4)}, alpha 0.01, assuming independent samples).`);
    }
    const pair = r.bestPair;
    if (pair) {
      lines.push(`- Closest recorded pair: equal prefix ${pair.equalPrefixBits} bits, Hamming distance ${pair.hammingDistance}.`);
      lines.push(`  - message_a: \`${pair.messageAHex}\``, `  - message_b: \`${pair.messageBHex}\``);
      lines.push(`  - digest_a: \`${pair.digestAHex}\``, `  - digest_b: \`${pair.digestBHex}\``);
    }
    lines.push('- Reproduction: messages are SHA-256(`ramherd-experiment-v1|<track>|<kind>|<seed>` ...) counter-stream bytes, fully determined by the recorded seed and parameters (server/lib/research-tools.js).');
  } else {
    lines.push(`- message_a: \`${r.messageAHex}\``, `- message_b: \`${r.messageBHex}\``);
    lines.push(`- digest_a: \`${r.digestAHex}\``, `- digest_b: \`${r.digestBHex}\``);
  }
  lines.push('- Computed by this harness on its own host with a JS port of the organizer\'s reference reduced-round function (pinned to the organizer\'s');
  lines.push('  test vectors). It is not an organizer-executed experiments report; the organizer\'s judge has not re-run it.');
  lines.push('- The organizer\'s target profile puts near-collisions and output truncation out of scope for an ordinary-collision claim:');
  lines.push('  a prefix match, a biased output bit or a low-weight difference is evidence about the target, not a collision.');
  return lines;
}

// ---------------------------------------------------------------------------
// Subprocess plumbing
// ---------------------------------------------------------------------------

function run(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = 2 * 1024 * 1024;
    child.stdout.on('data', (d) => { if (stdout.length < cap) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < cap) stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: null, stdout, stderr: `${stderr}${err.message}`, timedOut, durationMs: Date.now() - started, spawnError: err.code || err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
  });
}

function parseLastJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // intake prints exactly one JSON line; take the last parseable line.
    for (const line of trimmed.split('\n').reverse()) {
      try { return JSON.parse(line); } catch { /* keep looking */ }
    }
    return null;
  }
}

/**
 * Turns a raw pipeline process result into a stable outcome. The categories
 * mirror hashsmash_pipeline.py's own exit-code contract:
 *   0 -> ok, 2 -> rejected/draft (a verdict), 3 -> environment/infra (not a verdict).
 */
export function classifyStage(stage, raw) {
  const parsed = parseLastJson(raw.stdout);
  let outcome;
  if (raw.spawnError || raw.timedOut) outcome = 'environment-blocked';
  else if (raw.exitCode === 0) outcome = 'ok';
  else if (raw.exitCode === 2 && parsed?.status === 'draft_not_submitted') outcome = 'draft-not-submitted';
  else if (raw.exitCode === 2) outcome = 'rejected';
  else if (raw.exitCode === 3) outcome = 'environment-blocked';
  else outcome = 'error';
  const stderrLine = raw.stderr.trim().split('\n').filter(Boolean).at(-1) || '';
  return {
    stage,
    outcome,
    exitCode: raw.exitCode,
    status: parsed?.status ?? (Array.isArray(parsed) ? parsed[0]?.status : undefined) ?? null,
    parsed,
    detail: stderrLine,
    timedOut: raw.timedOut,
    durationMs: raw.durationMs,
  };
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   referenceRoot?: string,
 *   workspacesDir?: string,
 *   python?: string,
 *   judgeAllowed?: boolean,
 *   env?: NodeJS.ProcessEnv,
 *   timeoutMs?: number,
 * }} [opts]
 */
export function createHashSmashRunner({
  referenceRoot = DEFAULT_REFERENCE_ROOT,
  workspacesDir = DEFAULT_WORKSPACES_DIR,
  attributionDir = DEFAULT_ATTRIBUTION_DIR,
  python = 'python3',
  judgeAllowed = false,
  env = process.env,
  timeoutMs = 180_000,
} = {}) {
  const refRoot = resolve(referenceRoot);
  const wsRoot = resolve(workspacesDir);
  const attrRoot = resolve(attributionDir);
  const relToRef = relative(refRoot, wsRoot);
  if (relToRef === '' || (!relToRef.startsWith('..') && !isAbsolute(relToRef))) {
    throw new Error('workspacesDir must be outside the vendored HashSmash repo');
  }

  // Credential-free stages get only what Python needs to start. No provider
  // keys, no .env, nothing from the parent environment beyond PATH/HOME/locale.
  function baseEnv() {
    return {
      PATH: env.PATH || '/usr/bin:/bin',
      HOME: env.HOME || '',
      LANG: env.LANG || 'en_US.UTF-8',
      PYTHONDONTWRITEBYTECODE: '1',
    };
  }

  // Judge stage only: forward the provider key and HashSmash's own judge knobs.
  function judgeEnv() {
    const out = baseEnv();
    for (const [k, v] of Object.entries(env)) {
      if (k === 'OPENROUTER_API_KEY' || k === 'AWS_BEARER_TOKEN_BEDROCK' || k.startsWith('HASHSMASH_')) out[k] = v;
    }
    return out;
  }

  function py(cwd, args, stageEnv = baseEnv()) {
    return run(python, args, { cwd, env: stageEnv, timeoutMs });
  }

  function git(args, cwd) {
    return run('git', args, { cwd, env: baseEnv(), timeoutMs: 60_000 });
  }

  function assertTrack(track) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*-(?:exploratory|rigorous)$/.test(track)) throw new RangeError(`invalid track id: ${track}`);
  }

  function workspacePath(slotId) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(slotId) || slotId.startsWith('.')) throw new RangeError(`invalid slot id: ${slotId}`);
    return join(wsRoot, slotId);
  }

  /**
   * Records which RAM (slot id, model, track, approach) produced a candidate
   * package, in a file OUTSIDE the package and outside the workspace's git
   * clone (see DEFAULT_ATTRIBUTION_DIR). This repo has no real external
   * submission path yet (`submitLive` always refuses); this file carries
   * exactly the fields a real one would need for `--model`/`--harness`/a
   * note file, so attribution is ready the moment that path exists. Writing
   * it never touches claim.json, proof.md or certificates/manifest.json: the
   * package the organizer's own scripts see is unchanged.
   */
  function writeAttribution({ slotId, track, model = null, approach = null, modelSource = null, candidate, head }) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(slotId) || slotId.startsWith('.')) throw new RangeError(`invalid slot id: ${slotId}`);
    assertTrack(track);
    mkdirSync(attrRoot, { recursive: true });
    const record = {
      schema_version: 1,
      note: 'HashRammers internal attribution record. Not sent to HashSmash or part of the candidate package: this repo has no real external submission mechanism yet. Kept so a real submission step can honestly say which RAM produced this candidate.',
      slotId,
      track,
      approach,
      model,
      modelSource,
      referenceHead: head ?? null,
      candidateKind: candidate?.kind ?? null,
      submissionState: candidate?.submissionState ?? null,
      timeLog2: candidate?.timeLog2 ?? null,
      successProbability: candidate?.successProbability ?? null,
      producedAt: new Date().toISOString(),
    };
    const path = join(attrRoot, `${slotId}__${track}.json`);
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    return { path, record };
  }

  /** Is the environment able to run the pipeline at all? Never throws. */
  async function preflight() {
    const problems = [];
    if (!existsSync(join(refRoot, 'scripts', 'hashsmash_pipeline.py'))) problems.push(`vendored HashSmash repo not found at ${refRoot}`);
    const ver = await run(python, ['--version'], { cwd: PROJECT_ROOT, env: baseEnv(), timeoutMs: 10_000 });
    if (ver.exitCode !== 0) problems.push(`${python} is not runnable`);
    const head = problems.length ? null : (await git(['rev-parse', 'HEAD'], refRoot)).stdout.trim() || null;
    return { ok: problems.length === 0, problems, python: (ver.stdout || ver.stderr).trim() || null, referenceHead: head };
  }

  /** `scripts/local_tracks.py list`, parsed from its real table output. */
  async function listTracks(cwd = refRoot) {
    const raw = await py(cwd, ['scripts/local_tracks.py', 'list']);
    if (raw.exitCode !== 0) throw new Error(`local_tracks.py list failed (exit ${raw.exitCode}): ${raw.stderr.trim()}`);
    return raw.stdout.trim().split('\n').slice(1).map((line) => {
      const [track, fn, rounds, lane, nominal] = line.trim().split(/\s+/);
      return { track, function: fn, rounds: Number(rounds), lane, nominalSecurityBits: Number(nominal) };
    });
  }

  /**
   * Gives a slot its own fresh clone of the vendored repo (pinned to the same
   * commit). Re-preparing wipes the slot's previous workspace: each research
   * cycle starts from the organizer's exact tree.
   */
  async function prepareWorkspace(slotId) {
    const dir = workspacePath(slotId);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(wsRoot, { recursive: true });
    const clone = await git(['clone', '--quiet', refRoot, dir], wsRoot);
    if (clone.exitCode !== 0) throw new Error(`could not clone vendored HashSmash repo: ${clone.stderr.trim()}`);
    const [refHead, wsHead] = await Promise.all([git(['rev-parse', 'HEAD'], refRoot), git(['rev-parse', 'HEAD'], dir)]);
    if (refHead.stdout.trim() !== wsHead.stdout.trim()) throw new Error('workspace clone is not at the vendored repo HEAD');
    return { dir, head: wsHead.stdout.trim() };
  }

  function candidateDirFor(workspaceDir, track) {
    const m = /^(.*)-(exploratory|rigorous)$/.exec(track);
    return join(workspaceDir, 'lanes', m[2], 'candidates', m[1]);
  }

  /**
   * Replaces the slot workspace's candidate with an honestly-labeled harness
   * DRAFT. claim.json comes straight from the organizer's own
   * `LaneTrack.draft_claim()` template (every number is theirs, unmodified);
   * we only add two restriction strings saying what this package is.
   */
  async function writeHarnessDraft(workspaceDir, track, { slotId = 'unknown' } = {}) {
    assertTrack(track);
    const candidateDir = candidateDirFor(workspaceDir, track);
    if (relative(wsRoot, candidateDir).startsWith('..')) throw new Error('refusing to write outside the workspaces dir');
    const tpl = await py(workspaceDir, [
      '-c',
      'import json,sys; from verifier.frontier_tracks import get_frontier_track; print(json.dumps(get_frontier_track(sys.argv[1]).draft_claim()))',
      track,
    ]);
    if (tpl.exitCode !== 0) throw new Error(`could not load organizer draft template: ${tpl.stderr.trim()}`);
    const claim = JSON.parse(tpl.stdout);
    if (claim.submission_state !== 'draft') throw new Error('organizer template is not a draft; refusing to continue');
    claim.restrictions = [
      `${HARNESS_MARKER} (RAM slot ${slotId}). This is not a cryptanalysis claim: every numeric field is the HashSmash organizer's unmodified draft_claim() template, not a measured, argued, or improved bound.`,
      'submission_state is draft on purpose. HashSmash intake never forwards a draft to the judge, so this package cannot be judged, scored, ranked, or submitted.',
    ];

    rmSync(candidateDir, { recursive: true, force: true });
    mkdirSync(join(candidateDir, 'certificates'), { recursive: true });
    writeFileSync(join(candidateDir, 'claim.json'), `${JSON.stringify(claim, null, 2)}\n`);
    writeFileSync(join(candidateDir, 'certificates', 'manifest.json'), `${JSON.stringify({ schema_version: 2, certificates: [] }, null, 2)}\n`);
    writeFileSync(join(candidateDir, 'proof.md'), [
      `# ${HARNESS_MARKER}: ${track}`,
      '',
      `Written by HashRammers RAM slot \`${slotId}\` to check that the agent harness can drive`,
      "HashSmash's own local pipeline end to end. It is not research output.",
      '',
      '- **No attack is claimed.** There is no algorithm, characteristic, witness, or cost argument here.',
      "- **The numbers in claim.json are the organizer's draft template** (`draft_claim()`), copied",
      '  unchanged. They are placeholders, not bounds, and nobody should read them as a result.',
      '- **This package is a draft** and stays one. HashSmash intake stops drafts before the judge.',
      '',
      'What a passing intake on this package proves: the slot can clone the organizer repo, write a',
      'package in the required layout, and run `scripts/hashsmash_pipeline.py intake` to a real verdict.',
      'Nothing more.',
      '',
    ].join('\n'));
    return { candidateDir, claim };
  }

  /**
   * Replaces the slot workspace's candidate with a LOOP-AUTHORED draft: the
   * organizer's own draft_claim() template, with exactly three numbers
   * (time_log2, memory_log2_bytes, success_probability) and one heuristic
   * replaced by what the active research loop's own model actually proposed
   * this session (`attempt`, already passed through validateLoopAttempt by
   * the caller — this function trusts that gate ran, it does not re-run it).
   *
   * Deliberate, structural honesty limits (not prompt-level, enforced here
   * in code so nothing the model writes can bypass them):
   *   - submission_state is force-kept 'draft', always. This harness never
   *     lets an autonomous loop mark its own candidate 'ready'; HashSmash's
   *     real intake therefore still stops it before any judge call, exactly
   *     like every other harness draft.
   *   - the heuristic's `role` is force-kept 'supporting', never
   *     'score-critical': the loop's self-authored heuristic can never be
   *     the thing a score would actually turn on.
   *   - every structural field the loop did not genuinely originate
   *     (target_profile, rounds, lane, baseline_improved, time_unit,
   *     preprocessing_log2, nonuniform_advice_log2_bytes, ...) stays exactly
   *     the organizer's own template value.
   *   - `restrictions` always starts with a fixed, model-proof disclosure
   *     (LOOP_DRAFT_MARKER) saying plainly that these numbers are this RAM's
   *     own unverified estimate, and names the real reference it cited —
   *     either a real ePrint paper or a real competitor's open PR
   *     (`citedPaper.kind`, from findCitedReference; a plain `{id, title}`
   *     with no `kind` is treated as an ePrint result, for callers that
   *     predate this distinction).
   *   - evidence_ids are computed from the real proof.md this call writes,
   *     not trusted from the model's own line-number guess.
   */
  async function writeLoopDraftCandidate(workspaceDir, track, { slotId = 'unknown', attempt, citedPaper, verification = null, supportingExperiment = null }) {
    assertTrack(track);
    const candidateDir = candidateDirFor(workspaceDir, track);
    if (relative(wsRoot, candidateDir).startsWith('..')) throw new Error('refusing to write outside the workspaces dir');
    const tpl = await py(workspaceDir, [
      '-c',
      'import json,sys; from verifier.frontier_tracks import get_frontier_track; print(json.dumps(get_frontier_track(sys.argv[1]).draft_claim()))',
      track,
    ]);
    if (tpl.exitCode !== 0) throw new Error(`could not load organizer draft template: ${tpl.stderr.trim()}`);
    const claim = JSON.parse(tpl.stdout);
    if (claim.submission_state !== 'draft') throw new Error('organizer template is not a draft; refusing to continue');

    claim.claim = {
      ...claim.claim,
      time_log2: attempt.timeLog2,
      memory_log2_bytes: attempt.memoryLog2Bytes,
      success_probability: attempt.successProbability,
    };
    // 'ready' only when a real, independent second model call (slots.js
    // runLoopVerification, LOOP_VERIFY_SYSTEM) -- a different prompt than the
    // one that proposed this, explicitly asked to try to find a real problem
    // with it -- genuinely came back PASS. verification is null/not-pass
    // unless the caller actually ran that step; never assumed by omission. A
    // fail-to-verify (or no attempt at all) force-keeps 'draft', the same
    // safe default as before 2026-10-06 -- this changes WHICH checks a
    // candidate has to clear to ever reach 'ready', not that it clears none.
    const verified = verification?.pass === true;
    claim.submission_state = verified ? 'ready' : 'draft';
    const isPeerPr = citedPaper?.kind === 'peer-pr';
    const isExperiment = citedPaper?.kind === 'experiment';
    const isReadPaper = citedPaper?.kind !== 'peer-pr' && !isExperiment && citedPaper?.read === true;
    const citationRestriction = isPeerPr
      ? `This RAM cited an open, unverified pull request from a real competitor on the real HashSmash repository: PR #${citedPaper.number}${citedPaper.login ? ` by @${citedPaper.login}` : ''} ("${citedPaper.title}")${citedPaper.claimedScore ? `, which self-reports a claimed score of ${citedPaper.claimedScore}` : ''}. That is another competitor's own self-reported claim, not verified by Yukon or anyone else, and an open PR may still be rejected or wrong; citing it is not the same as having confirmed it. It was found by a text match on this track's name in the PR's own title/body, which is not a guarantee the PR is actually that track's own submission.`
      : isExperiment
        ? `This RAM cited its own real experiment this session as grounding — ${describeExperimentRef(citedPaper)} It was computed by this harness on its own host (a JS port of the organizer's reference function), not executed by the organizer, and what it measured is narrower than this claim: the extrapolation from it is this RAM's own, unverified.`
        : isReadPaper
          ? `This RAM cited IACR ePrint ${citedPaper.id} ("${citedPaper.title}"), whose title, authors and abstract it actually fetched and read from the paper's own ePrint page this session. The abstract is not the full paper: the body (PDF) was not read, and applying the paper to this exact target is this RAM's own, unverified step.`
          : `This RAM cited IACR ePrint ${citedPaper.id} ("${citedPaper.title}") from its own real literature search this session as grounding. Citing a paper's title is not the same as having verified its applicability to this exact target, and that distinction is deliberate, not an oversight.`;
    const verificationRestriction = verified
      ? `This candidate passed a second, independent model call (a different prompt, framed adversarially to find a problem with it, not to agree with it) before submission_state was allowed to leave 'draft'. A real, automated check, not a human one, and not a guarantee of correctness.${verification.reason ? ` Its own stated reason: "${verification.reason}"` : ''}`
      : `submission_state is forced to draft: ${verification ? `the independent verification call did not pass (${verification.reason || 'no reason given'})` : 'no independent verification was attempted'}, so HashSmash intake correctly refuses to forward it to the judge.`;
    claim.restrictions = [
      `${LOOP_DRAFT_MARKER} (RAM slot ${slotId}). The claim.claim numbers above and the one heuristic below were written by this RAM's own model this session from its own real research, not the organizer's empty template. ${verificationRestriction}`,
      citationRestriction,
      ...(supportingExperiment ? [`Supporting evidence named by this RAM: ${describeExperimentRef(supportingExperiment)} Host-side computation by this harness, not an organizer-executed experiments report.`] : []),
    ];

    const citedSection = isExperiment
      ? experimentEvidenceLines(citedPaper, '## Cited experiment (this session\'s own real computation)')
      : isReadPaper
        ? [
          '## Cited literature',
          '',
          `- IACR ePrint ${citedPaper.id}: "${citedPaper.title}"${citedPaper.authors?.length ? ` by ${citedPaper.authors.join(', ')}` : ''} — fetched`,
          '  and read this session from the paper\'s own ePrint page (title, authors and abstract). The paper\'s',
          '  body (PDF) was not read.',
          ...(citedPaper.abstract ? ['', `  Abstract as fetched: "${String(citedPaper.abstract).replace(/\s+/g, ' ').slice(0, 1200)}"`] : []),
        ]
        : isPeerPr
          ? [
            '## Cited competitor submission',
            '',
            `- PR #${citedPaper.number}${citedPaper.login ? ` by @${citedPaper.login}` : ''}: "${citedPaper.title}" — an open, unverified pull`,
            '  request on the real HashSmash repository, found via this session\'s real GitHub lookup.',
            citedPaper.claimedScore
              ? `  Self-reported claimed score: ${citedPaper.claimedScore} (their own claim, not independently verified;`
              : '  No claimed score was stated in it.',
            ...(citedPaper.claimedScore ? ['  an open PR can still be rejected or wrong).'] : []),
            ...(citedPaper.url ? [`  ${citedPaper.url}`] : []),
          ]
          : [
            '## Cited literature',
            '',
            `- IACR ePrint ${citedPaper.id}: "${citedPaper.title}" — found via this session's real ePrint`,
            '  search. Only the search result title was read; the paper itself was not fetched or read in',
            '  this session.',
          ];
    if (supportingExperiment) citedSection.push('', ...experimentEvidenceLines(supportingExperiment, '## Supporting experiment (this session\'s own real computation)'));

    const proofLines = [
      `# ${LOOP_DRAFT_MARKER}: ${track}`,
      '',
      `Written autonomously by RAM slot \`${slotId}\` during its always-on research loop, from its own`,
      'model, its own real literature search, and its own research so far this session.',
      verified
        ? 'No human has reviewed this. A second, independent model call, prompted adversarially to try'
          + ' to find a real problem with it, did -- and genuinely passed it.'
        : 'Nobody has reviewed, judged, or independently verified any of it.',
      '',
      ...citedSection,
      '',
      `## Disclosed heuristic: ${attempt.heuristicId}`,
      '',
      `**Statement.** ${attempt.statement}`,
      '',
      `**Scope.** ${attempt.scope}`,
      '',
      `**Extrapolation.** ${attempt.extrapolation}`,
      '',
      `**Limitations.** ${attempt.limitations}`,
      '',
      '## What this is not',
      '',
      verified
        ? 'No new collision or witness was produced this session. This passed this harness\'s own'
          + ' structural honesty check and a separate adversarial verification pass -- real, automated'
          + ' checks, neither of them a human, and neither a guarantee the underlying mathematics is'
          + ' actually right.'
        : 'No new collision, witness, or independently-reviewed proof was produced this session. This'
          + ' candidate stays a draft on purpose; HashSmash intake does not forward drafts to the judge,'
          + ' so nothing here is scored, ranked, or submitted.',
      '',
    ];
    const proofText = proofLines.join('\n');
    const proofLineCount = countProofLines(proofText);
    claim.heuristics = [{
      id: attempt.heuristicId,
      statement: attempt.statement,
      role: verified ? 'score-critical' : 'supporting',
      scope: attempt.scope,
      extrapolation: attempt.extrapolation,
      evidence_ids: [`proof:1-${proofLineCount}`],
      limitations: attempt.limitations,
    }];

    rmSync(candidateDir, { recursive: true, force: true });
    mkdirSync(join(candidateDir, 'certificates'), { recursive: true });
    writeFileSync(join(candidateDir, 'claim.json'), `${JSON.stringify(claim, null, 2)}\n`);
    writeFileSync(join(candidateDir, 'certificates', 'manifest.json'), `${JSON.stringify({ schema_version: 2, certificates: [] }, null, 2)}\n`);
    writeFileSync(join(candidateDir, 'proof.md'), proofText);
    return { candidateDir, claim };
  }

  /**
   * Replaces the slot workspace's candidate with the committed research
   * package for `track` (RESEARCH_CANDIDATES). Copies exactly the listed
   * files, byte for byte; refuses anything else.
   */
  function writeResearchCandidate(workspaceDir, track) {
    assertTrack(track);
    const research = RESEARCH_CANDIDATES[track];
    if (!research) throw new Error(`no research candidate for ${track}`);
    const candidateDir = candidateDirFor(workspaceDir, track);
    if (relative(wsRoot, candidateDir).startsWith('..')) throw new Error('refusing to write outside the workspaces dir');
    for (const f of research.files) {
      const src = join(research.dir, f);
      if (!existsSync(src) || !lstatSync(src).isFile()) throw new Error(`research package file missing: ${relative(PROJECT_ROOT, src)}`);
    }
    rmSync(candidateDir, { recursive: true, force: true });
    for (const f of research.files) {
      mkdirSync(dirname(join(candidateDir, f)), { recursive: true });
      writeFileSync(join(candidateDir, f), readFileSync(join(research.dir, f)));
    }
    const claim = JSON.parse(readFileSync(join(candidateDir, 'claim.json'), 'utf8'));
    return { candidateDir, claim };
  }

  /**
   * Recomputes digests with the ORGANIZER'S OWN reference checker, the exact
   * call its certificate verifier makes (verifier/certificates.py:
   * `digest(message, track.algorithm, track.rounds)` with the track from
   * `get_frontier_track`). Read-only, credential-free, against the vendored
   * repo itself (no workspace clone needed; PYTHONDONTWRITEBYTECODE keeps it
   * byte-for-byte untouched). This is the authority research-tools.js's JS
   * port is checked against at runtime: slots.js only reports an experiment
   * pair or a VERIFY verdict as confirmed when both agree. Never throws.
   *
   * @param {{ track: string, messagesHex: string[] }} p
   */
  async function organizerDigests({ track, messagesHex }) {
    try {
      assertTrack(track);
      if (!Array.isArray(messagesHex) || !messagesHex.length || messagesHex.length > 8 || !messagesHex.every((m) => typeof m === 'string' && /^(?:[0-9a-f]{2})*$/.test(m) && m.length <= 8192)) {
        return { ok: false, error: 'organizerDigests takes 1..8 lowercase hex messages of at most 4096 bytes' };
      }
      const code = [
        'import json,sys',
        'from verifier.frontier_tracks import get_frontier_track',
        'from verifier.hash_functions import digest',
        't=get_frontier_track(sys.argv[1])',
        'print(json.dumps({"algorithm":t.algorithm,"rounds":t.rounds,"profile_id":t.profile_id,"digests":[digest(bytes.fromhex(m),t.algorithm,t.rounds).hex() for m in sys.argv[2:]]}))',
      ].join('\n');
      const raw = await py(refRoot, ['-c', code, track, ...messagesHex]);
      if (raw.exitCode !== 0) return { ok: false, error: `organizer digest failed (exit ${raw.exitCode}): ${(raw.stderr.trim().split('\n').at(-1) || '').slice(0, 200)}` };
      const parsed = parseLastJson(raw.stdout);
      if (!parsed || !Array.isArray(parsed.digests) || parsed.digests.length !== messagesHex.length) return { ok: false, error: 'organizer digest returned no usable output' };
      return { ok: true, algorithm: parsed.algorithm, rounds: parsed.rounds, profileId: parsed.profile_id, digests: parsed.digests, checker: 'verifier/hash_functions.py:digest' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /** `scripts/local_tracks.py check <track>` — mechanical validation only. */
  async function check(workspaceDir, track) {
    assertTrack(track);
    return classifyStage('check', await py(workspaceDir, ['scripts/local_tracks.py', 'check', track]));
  }

  /** `scripts/hashsmash_pipeline.py intake --track <track>` — credential-free. */
  async function intake(workspaceDir, track) {
    assertTrack(track);
    const result = classifyStage('intake', await py(workspaceDir, ['scripts/hashsmash_pipeline.py', 'intake', '--track', track]));
    if (result.parsed?.evidence) result.evidencePath = join(workspaceDir, result.parsed.evidence);
    return result;
  }

  /** Paid model call via HashSmash's judge. Refused unless the gate is open. */
  async function judge(workspaceDir, track) {
    assertTrack(track);
    if (!judgeAllowed) {
      return { stage: 'judge', outcome: 'gated', exitCode: null, status: null, detail: 'judge stage is off: needs RAMHERD_PIPELINE=local, RAMHERD_LIVE=true, OPENROUTER_API_KEY and RAMHERD_HASHSMASH_JUDGE=true' };
    }
    return classifyStage('judge', await py(workspaceDir, ['scripts/hashsmash_pipeline.py', 'judge', '--track', track], judgeEnv()));
  }

  /** Deterministic scoring; only meaningful after a real judge run, so gated with it. */
  async function score(workspaceDir, track) {
    assertTrack(track);
    if (!judgeAllowed) return { stage: 'score', outcome: 'gated', exitCode: null, status: null, detail: 'score runs only after a gated judge stage' };
    return classifyStage('score', await py(workspaceDir, ['scripts/hashsmash_pipeline.py', 'score', '--track', track]));
  }

  /**
   * REAL live submission of one cycle's candidate to the HashSmash/Yukon
   * competition (see live-submit.js for the protocol and why it is `yukon
   * submit`, not a hand-opened PR). This function is the gatekeeper, not the
   * transport: it refuses (throws) unless RAMHERD_HASHSMASH_LIVE_SUBMIT=true
   * and a real YUKON_API_KEY are set, the track is a PIPELINE_TRACKS track,
   * and liveSubmitEligibility(cycle) holds (a 'ready' loop-draft, precheck ok,
   * real check ok, real intake ok, success probability >= 0.39). Then it
   * re-reads the package from disk (collectCandidateFiles also refuses a
   * claim.json that is not 'ready' or does not match the cycle's numbers) and
   * hands exactly those files to `submitter` -- in production slots.js's
   * runner for live-submit.js's runLiveSubmissionInSandbox inside the RAM's
   * own sandbox. Injected so tests never make a real external call.
   *
   * @param {any} cycle - a runCycle() result
   * @param {{ submitter: (payload: { track: string, files: Array<{path: string, content: string}>, packageSha256: string, candidate: any, checks: object }) => Promise<any> }} opts
   */
  async function submitLive(cycle, { submitter } = {}) {
    const policy = liveSubmitPolicy(env);
    if (!policy.enabled) throw new Error(`live submission refused: ${LIVE_SUBMIT_FLAG} is not "true"`);
    if (!policy.hasKey) throw new Error(`live submission refused: ${LIVE_SUBMIT_FLAG}=true but no real YUKON_API_KEY is set`);
    if (!PIPELINE_TRACKS.includes(cycle?.track)) throw new Error(`live submission refused: ${cycle?.track} is not a pipeline track`);
    const elig = liveSubmitEligibility(cycle);
    if (!elig.eligible) throw new Error(`live submission refused: ${elig.reasons.join('; ')}`);
    if (typeof submitter !== 'function') throw new Error('live submission refused: no submitter given');
    const pkg = collectCandidateFiles(cycle.candidateDir, cycle.candidate);
    const stage = (name) => cycle.stages.find((s) => s.stage === name);
    const checks = {
      precheck: cycle.precheck.ok ? 'ok' : 'failed',
      check: `${stage('check').outcome} (exit ${stage('check').exitCode}, status ${stage('check').status ?? 'none'})`,
      intake: `${stage('intake').outcome} (exit ${stage('intake').exitCode}, status ${stage('intake').status ?? 'none'})`,
      packageSha256: pkg.packageSha256,
    };
    const result = await submitter({ track: cycle.track, files: pkg.files, packageSha256: pkg.packageSha256, candidate: cycle.candidate, checks });
    return { ...result, packageSha256: pkg.packageSha256 };
  }

  /**
   * One full slot research cycle on a pipeline track: fresh workspace ->
   * research package (if the track has one) or harness draft or, if the
   * caller already has an active-loop draft attempt that passed
   * validateLoopAttempt (`loopDraft`), a loop-authored draft -> JS precheck
   * -> real `check` -> real `intake` -> (judge/score only if gated on AND the
   * package is `ready`; a harness draft or loop draft never is, and the
   * judge gate is off by default, so a ready research package stops at a
   * `gated` judge stage).
   *
   * `loopDraft`, when given, is `{ attempt, citedPaper }` — the caller
   * (slots.js) is expected to have already run validateLoopAttempt and only
   * pass a draft that passed. This function does not re-validate it; it
   * trusts the caller's gate the same way it trusts RESEARCH_CANDIDATES'
   * committed files. Ignored entirely for a track with a committed research
   * package (sha256-r32-exploratory): the loop never overwrites that one.
   */
  async function runCycle({ slotId, track, model = null, approach = null, modelSource = null, loopDraft = null }) {
    const ws = await prepareWorkspace(slotId);
    const research = RESEARCH_CANDIDATES[track];
    const { candidateDir, claim } = research
      ? writeResearchCandidate(ws.dir, track)
      : loopDraft
        ? await writeLoopDraftCandidate(ws.dir, track, { slotId, attempt: loopDraft.attempt, citedPaper: loopDraft.citedPaper, verification: loopDraft.verification, supportingExperiment: loopDraft.supportingExperiment ?? null })
        : await writeHarnessDraft(ws.dir, track, { slotId });
    const candidate = {
      kind: research ? 'research' : loopDraft ? 'loop-draft' : 'harness-draft',
      submissionState: claim.submission_state,
      timeLog2: claim.claim?.time_log2 ?? null,
      successProbability: claim.claim?.success_probability ?? null,
      heuristics: (claim.heuristics || []).map((h) => h.id),
      summary: research
        ? research.summary
        : loopDraft
          ? `this RAM's own disclosed heuristic ("${loopDraft.attempt.heuristicId}"), citing ${citationLabel(loopDraft.citedPaper)}${loopDraft.supportingExperiment ? ` (supporting experiment ${loopDraft.supportingExperiment.id})` : ''}, ${loopDraft.verification?.pass === true ? 'adversarially verified' : 'forced to stay a draft'}`
          : 'labeled harness draft (organizer template, no attack claimed)',
    };
    const attribution = writeAttribution({ slotId, track, model, approach, modelSource, candidate, head: ws.head });
    const precheck = precheckCandidate(candidateDir, ws.dir);
    const stages = [];
    if (!precheck.ok) return { track, workspace: ws.dir, workspaceRelative: relative(PROJECT_ROOT, ws.dir), head: ws.head, candidateDir, candidate, attribution, precheck, stages };
    stages.push(await check(ws.dir, track));
    stages.push(await intake(ws.dir, track));
    const intakeResult = stages.at(-1);
    if (intakeResult.outcome === 'ok') {
      const j = await judge(ws.dir, track);
      stages.push(j);
      if (j.outcome === 'ok') stages.push(await score(ws.dir, track));
    }
    return { track, workspace: ws.dir, workspaceRelative: relative(PROJECT_ROOT, ws.dir), head: ws.head, candidateDir, candidate, attribution, precheck, stages };
  }

  return Object.freeze({
    referenceRoot: refRoot,
    workspacesDir: wsRoot,
    attributionDir: attrRoot,
    judgeAllowed,
    supportsTrack: (track) => PIPELINE_TRACKS.includes(track),
    candidateKindFor: (track) => (RESEARCH_CANDIDATES[track] ? 'research' : 'harness-draft'),
    preflight,
    listTracks,
    prepareWorkspace,
    candidateDirFor,
    writeHarnessDraft,
    writeLoopDraftCandidate,
    writeResearchCandidate,
    writeAttribution,
    precheck: precheckCandidate,
    organizerDigests,
    check,
    intake,
    judge,
    score,
    submitLive,
    runCycle,
  });
}
