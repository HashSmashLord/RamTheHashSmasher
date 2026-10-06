// REAL live submission of a RAM's own verified candidate to the HashSmash
// competition, for every track in hashsmash.js's PIPELINE_TRACKS.
//
// The real protocol (read, not assumed -- reference/hash-smash/TASK.md,
// "Ranked Yukon submissions"): a solver submits with `yukon submit --track
// <full track id>` plus a public note and the actual model and harness. "Yukon
// creates and promotes its submission PRs. Do not push candidate changes
// directly to the benchmark branch, open a replacement submission PR manually,
// or merge a Yukon submission PR yourself." So this is NOT a GitHub PR opened
// by this harness; it is the same Yukon CLI yukon-submit.js already wraps,
// with the candidate package written into a fresh `yukon clone` of the
// benchmark first. HashSmash is ONE Yukon benchmark with six tracks
// (reference/hash-smash/benchmark.json, schema v2, name "hashsmash";
// docs/YUKON_PROD_SETUP.md "Import repository-root benchmark.json"), and
// `--track` selects the track. Which benchmark id that clone uses is checked,
// not assumed, inside the sandbox: the cloned tree's own benchmark.json must
// list the track, or nothing is submitted.
//
// Gate (off by default, like every other real integration here):
//   - RAMHERD_HASHSMASH_LIVE_SUBMIT=true (exactly that string), AND
//   - a real YUKON_API_KEY (the same key yukon-submit.js uses), AND
//   - RAMHERD_PIPELINE=local (no pipeline runner exists otherwise), AND
//   - E2B sandboxes on (the CLI runs inside the RAM's own running sandbox,
//     never on the host; same channel as yukon-sandbox.js).
// Nothing in this repo sets the flag. With it unset, nothing in this file is
// ever reached from slots.js (see slots.js runRealPipeline).
//
// What may be submitted (liveSubmitEligibility, re-checked from disk):
//   - candidate.kind === 'loop-draft' only: a RAM's own loop-authored claim
//     that passed validateLoopAttempt AND the independent adversarial
//     verification call (slots.js runLoopVerification) -- the only thing that
//     ever makes writeLoopDraftCandidate write submission_state 'ready'.
//     Harness drafts (organizer template) and the committed sha256-r32
//     research package are never auto-submitted by this path.
//   - submission_state 'ready' in the claim.json actually on disk, with the
//     same numbers the cycle reported;
//   - precheck ok, real `local_tracks.py check` outcome ok, real
//     `hashsmash_pipeline.py intake` outcome ok;
//   - success_probability >= 0.39 (TASK.md's required minimum).
// And, inside the sandbox, before anything is uploaded:
//   - the cloned benchmark lists this track;
//   - the organizer's own `local_tracks.py check <track>` passes again on the
//     clone with our package in it (the real upstream tree, not only our
//     pinned vendored copy);
//   - decideLiveSubmission: strictly lower time_log2 than BOTH the track's
//     current incumbent package in the clone AND anything this harness has
//     already submitted on this track (per-track ledger, persisted under
//     RAMHERD_DATA_DIR so a restart cannot cause a duplicate). Same
//     "resubmit only on genuine improvement" rule as yukon-sandbox.js's
//     decideYukonSubmission, which this reuses.

import { readdirSync, readFileSync, lstatSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { readJsonFile, writeJsonFileAtomic } from './persist.js';
import { yukonArgs } from './yukon-submit.js';
import { shQuote } from './sandbox-task.js';
import {
  YUKON_BENCHMARK_ID, YUKON_HARNESS, createSandboxRun, baseSandboxEnv, parseCloneWorkspace,
  decideYukonSubmission, installYukonCli, sandboxLogin,
} from './yukon-sandbox.js';

export const LIVE_SUBMIT_FLAG = 'RAMHERD_HASHSMASH_LIVE_SUBMIT';
/** Organizer's required minimum algorithmic success probability (TASK.md). */
export const MIN_SUCCESS_PROBABILITY = 0.39;
/** benchmark.json's maxSubmissionBytes for every track. */
export const MAX_PACKAGE_BYTES = 4_194_304;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function liveSubmitPolicy(env = process.env) {
  const enabled = env[LIVE_SUBMIT_FLAG] === 'true';
  const hasKey = typeof env.YUKON_API_KEY === 'string' && env.YUKON_API_KEY.trim().length > 0;
  return Object.freeze({ enabled, hasKey, allowed: enabled && hasKey });
}

/** The benchmark id to `yukon clone`. Overridable; verified against the clone's own benchmark.json either way. */
export function liveSubmitBenchmarkId(env = process.env) {
  const v = typeof env.RAMHERD_YUKON_BENCHMARK_ID === 'string' ? env.RAMHERD_YUKON_BENCHMARK_ID.trim() : '';
  return v || YUKON_BENCHMARK_ID;
}

/**
 * Candidate kinds this harness will ever live-submit. `loop-draft`: a RAM's
 * own claim, eligible only once it is genuinely `submission_state: 'ready'`
 * (the structural validator plus an independent adversarial verification
 * PASS; checked below, not re-derived here). `research`: hashsmash.js's
 * RESEARCH_CANDIDATES -- today exactly sha256-r32-exploratory's committed
 * package -- a prepared, already-checked-in research artifact, not a raw
 * model guess; the operator explicitly asked (2026-10-07) for it to be
 * live-submittable too, after being told it skips the adversarial-verify
 * gate loop-drafts go through. `harness-draft` (the organizer's empty
 * template, no RAM-authored claim at all) is never eligible, for either
 * kind: there is nothing real to submit.
 */
const LIVE_SUBMIT_CANDIDATE_KINDS = Object.freeze(['loop-draft', 'research']);

/**
 * Pure gate over a hashsmash.js runCycle result. Never weaker than the
 * pipeline's own verdicts: every listed condition must hold.
 *
 * @param {any} cycle
 * @returns {{ eligible: boolean, reasons: string[] }}
 */
export function liveSubmitEligibility(cycle) {
  const reasons = [];
  const c = cycle?.candidate;
  if (!c) return { eligible: false, reasons: ['no candidate in this cycle'] };
  if (!LIVE_SUBMIT_CANDIDATE_KINDS.includes(c.kind)) {
    reasons.push(`candidate kind is "${c.kind}", and only ${LIVE_SUBMIT_CANDIDATE_KINDS.map((k) => `"${k}"`).join(' or ')} is ever live-submitted`);
  }
  if (c.submissionState !== 'ready') reasons.push(`submission_state is "${c.submissionState}", not "ready"`);
  if (!cycle.precheck?.ok) reasons.push('precheck did not pass');
  const stage = (name) => (cycle.stages || []).find((s) => s.stage === name);
  if (stage('check')?.outcome !== 'ok') reasons.push(`organizer check outcome is "${stage('check')?.outcome ?? 'not run'}", not "ok"`);
  if (stage('intake')?.outcome !== 'ok') reasons.push(`organizer intake outcome is "${stage('intake')?.outcome ?? 'not run'}", not "ok"`);
  if (typeof c.timeLog2 !== 'number' || !Number.isFinite(c.timeLog2)) reasons.push('time_log2 is not a real number');
  if (typeof c.successProbability !== 'number' || !(c.successProbability >= MIN_SUCCESS_PROBABILITY)) {
    reasons.push(`success_probability ${c.successProbability} is below the organizer's required ${MIN_SUCCESS_PROBABILITY}`);
  }
  if (!cycle.candidateDir) reasons.push('no candidate directory recorded');
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Reads every file in the candidate package (claim.json, proof.md,
 * certificates/...) exactly as written and checked. Refuses symlinks,
 * anything over the organizer's size cap, and a claim.json on disk that does
 * not match what the cycle reported (or is not 'ready').
 *
 * @returns {{ files: Array<{ path: string, content: string }>, packageSha256: string, totalBytes: number }}
 */
export function collectCandidateFiles(candidateDir, candidate) {
  if (!candidateDir || !existsSync(candidateDir)) throw new Error('candidate directory does not exist');
  const files = [];
  let totalBytes = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`refusing a symlink in the candidate package: ${relative(candidateDir, p)}`);
      if (st.isDirectory()) { walk(p); continue; }
      if (!st.isFile()) throw new Error(`refusing a non-regular file in the candidate package: ${relative(candidateDir, p)}`);
      const content = readFileSync(p, 'utf8');
      totalBytes += Buffer.byteLength(content);
      files.push({ path: relative(candidateDir, p).split('\\').join('/'), content });
    }
  };
  walk(candidateDir);
  if (totalBytes > MAX_PACKAGE_BYTES) throw new Error(`candidate package is ${totalBytes} bytes, over the organizer's ${MAX_PACKAGE_BYTES}-byte cap`);
  const claimFile = files.find((f) => f.path === 'claim.json');
  if (!claimFile) throw new Error('candidate package has no claim.json');
  const claim = JSON.parse(claimFile.content);
  if (claim.submission_state !== 'ready') throw new Error(`claim.json on disk says submission_state "${claim.submission_state}", not "ready"`);
  if (candidate && (claim.claim?.time_log2 !== candidate.timeLog2 || claim.claim?.success_probability !== candidate.successProbability)) {
    throw new Error('claim.json on disk does not match the numbers this cycle reported; refusing');
  }
  const h = createHash('sha256');
  for (const f of files) h.update(`${f.path}\0${f.content}\0`);
  return { files, packageSha256: h.digest('hex'), totalBytes };
}

/**
 * Cheap pre-check, using only this harness's own ledger -- no sandbox, no
 * clone. Real reason this exists: a `research` candidate (sha256-r32's
 * committed package) reports the exact same numbers on every single
 * pipeline cycle, unlike a loop-draft (produced once per session); without
 * this, maybeLiveSubmit (slots.js) would pay for a real `yukon clone` inside
 * the sandbox on every cycle just to re-decide "no improvement," burning
 * real sandbox time for nothing new. This is the same base rule
 * decideLiveSubmission applies (via decideYukonSubmission) once a clone
 * actually happens; checking it first is a pure optimization, never a
 * looser gate -- decideLiveSubmission still re-checks everything for real
 * once inside the sandbox.
 *
 * @param {{ timeLog2: number, successProbability: number }} candidate
 * @param {{ timeLog2: number }|null} lastSubmitted
 * @returns {{ shouldSubmit: boolean, reason: string }}
 */
export function canPossiblyImprove(candidate, lastSubmitted) {
  return decideYukonSubmission({ bestResult: candidate, lastSubmitted });
}

/**
 * The resubmit discipline. Reuses decideYukonSubmission (strictly lower
 * time_log2 than what was last really submitted, positive success
 * probability), then adds one more real bar: strictly lower time_log2 than
 * the track's current incumbent package in the real cloned benchmark. A
 * candidate that does not beat the incumbent is not news to a judge.
 *
 * @param {{ candidate: { timeLog2: number, successProbability: number }, lastSubmitted?: { timeLog2: number }|null, incumbentTimeLog2?: number|null }} p
 */
export function decideLiveSubmission({ candidate, lastSubmitted = null, incumbentTimeLog2 = null }) {
  const base = decideYukonSubmission({ bestResult: candidate, lastSubmitted });
  if (!base.shouldSubmit) return base;
  if (typeof incumbentTimeLog2 !== 'number' || !Number.isFinite(incumbentTimeLog2)) {
    return { shouldSubmit: false, reason: 'could not read a real time_log2 from the track\'s current incumbent package in the cloned benchmark, so there is no honest basis to call this an improvement' };
  }
  if (!(candidate.timeLog2 < incumbentTimeLog2)) {
    return { shouldSubmit: false, reason: `time 2^${candidate.timeLog2} does not beat the track's current incumbent package (2^${incumbentTimeLog2}), so there is nothing new to submit` };
  }
  return { shouldSubmit: true, reason: `${base.reason}; also beats the current incumbent package (2^${incumbentTimeLog2})` };
}

/**
 * Per-track record of what this harness has REALLY submitted (only written
 * after a real `yukon submit` exited 0). Keyed by track, not slot: two RAMs
 * on one track never send the same or a worse claim twice. Persisted when
 * `persistPath` is given (RAMHERD_DATA_DIR), so a restart cannot reset it.
 * Also holds an in-flight lock per track.
 *
 * @param {{ persistPath?: string|null, log?: (line: string) => void }} [opts]
 */
export function createLiveSubmissionLedger({ persistPath = null, log = () => {} } = {}) {
  const byTrack = new Map();
  const inflight = new Set();
  if (persistPath) {
    const loaded = readJsonFile(persistPath, { log });
    if (loaded && typeof loaded === 'object' && loaded.tracks && typeof loaded.tracks === 'object') {
      for (const [track, rec] of Object.entries(loaded.tracks)) {
        if (rec && typeof rec.timeLog2 === 'number') byTrack.set(track, rec);
      }
    }
  }
  function persist() {
    if (!persistPath) return;
    writeJsonFileAtomic(persistPath, { schema_version: 1, tracks: Object.fromEntries(byTrack) }, { log });
  }
  return Object.freeze({
    get: (track) => byTrack.get(track) ?? null,
    record(track, rec) { byTrack.set(track, { ...rec }); persist(); return byTrack.get(track); },
    tryLock(track) { if (inflight.has(track)) return false; inflight.add(track); return true; },
    unlock(track) { inflight.delete(track); },
    snapshot: () => Object.fromEntries(byTrack),
  });
}

/** Yukon CLI's own minimum (SUBMISSION_NOTE_MIN_BYTES = 5 * 1024, read from the real bundle), measured on "Model: ..\nHarness: ..\n\n<note>". */
export const NOTE_MIN_BYTES = 5 * 1024;

/**
 * The public submission note, built only from real data: what this package
 * is, who produced it, every check it actually passed (with real outcomes and
 * the package hash), the incumbent comparison, the exact commands run, and
 * the full proof.md and claim.json restrictions verbatim. Yukon requires at
 * least 5 KiB and asks for a complete, reproducible narrative; this never
 * pads with filler -- if the real content is shorter, the caller refuses to
 * submit instead (see runLiveSubmissionInSandbox).
 */
export function buildLiveSubmissionNote({ track, candidate, attribution = null, files = [], checks = {}, incumbentTimeLog2 = null, lastSubmitted = null }) {
  const proof = files.find((f) => f.path === 'proof.md')?.content ?? '';
  let claim = null;
  try { claim = JSON.parse(files.find((f) => f.path === 'claim.json')?.content ?? 'null'); } catch { claim = null; }
  const slot = attribution?.slotId ?? 'unknown';
  const model = attribution?.model ?? 'unknown';
  const approach = attribution?.approach ?? 'unknown';
  const isResearchPackage = candidate.kind === 'research';
  const lines = [
    `# HashRammers submission note: ${track}`,
    '',
    '## What this is',
    '',
    isResearchPackage
      // Honest for sha256-r32's real provenance: a prepared, already-checked-in research
      // package (not a model's own single-session draft), included in live submission at
      // the operator's explicit instruction (2026-10-07) after being told it skips the
      // adversarial-verify gate a RAM's own loop-draft goes through -- never claim an
      // "autonomous RAM produced this" story this candidate kind does not have.
      ? `This package is prepared, written content committed to the HashRammers harness's own repository (not a model's single-session draft): \`${track}\`'s research package, RAM slot \`${slot}\`. It did not go through this harness's adversarial-verification gate (that gate only applies to a RAM's own loop-authored claims); it is included in live submission by the operator's explicit instruction. Its own disclosed heuristics, scope and limitations are below, verbatim from claim.json.`
      : `An autonomous AI research agent ("RAM") in the HashRammers harness produced this package: RAM slot \`${slot}\`, model \`${model}\`, approach \`${approach}\`. No human wrote or reviewed the claim, the proof text, or this note. The harness submitted it automatically with no human checkpoint, at its operator's explicit instruction.`,
    '',
    `Claimed bound: time_log2 ${candidate.timeLog2}, success probability ${candidate.successProbability}, memory_log2_bytes ${claim?.claim?.memory_log2_bytes ?? 'n/a'}, submission_state ${candidate.submissionState}.`,
    `Comparison: the track's current incumbent package in the cloned benchmark declares time_log2 ${incumbentTimeLog2 ?? 'unknown'}; ${lastSubmitted ? `this harness last submitted time_log2 ${lastSubmitted.timeLog2} on this track` : 'this harness has not submitted on this track before'}.`,
    '',
    '## How it was produced (environment, method, commands)',
    '',
    ...(isResearchPackage
      ? [
        '1. This package was written and committed to the harness\'s repository ahead of time, not drafted by a model in this session; see proof.md below for its own full methodology and sourcing.',
        '2. It still had to pass, for real, the same organizer checks every submission here does (outcomes below) before this harness would submit it.',
        '3. Organizer checks actually run, with real outcomes:',
        `   - harness precheck (schema and layout): ${checks.precheck ?? 'n/a'}`,
        `   - \`python3 scripts/local_tracks.py check ${track}\` on the harness's pinned copy of the benchmark: ${checks.check ?? 'n/a'}`,
        `   - \`python3 scripts/hashsmash_pipeline.py intake --track ${track}\` on the same copy: ${checks.intake ?? 'n/a'}`,
        `   - \`python3 scripts/local_tracks.py check ${track}\` again on this exact \`yukon clone\`, with this package written in: passed (otherwise nothing is submitted)`,
        `   - package sha256 (this harness's own hash over path and content of every file): ${checks.packageSha256 ?? 'n/a'}`,
        '4. The live AI judge was not run locally. No provider credentials are used by this harness for that, and `yukon run` was not used. Judging is left to Yukon\'s isolated judge job.',
      ]
      : [
        '1. During its research loop the RAM ran a real IACR ePrint search and/or a real GitHub lookup of other competitors\' open pull requests for this track. The claim must cite one of those real results; the citation is checked in code against what that session actually fetched.',
        '2. A dedicated drafting call proposed exactly three numbers (time_log2, memory_log2_bytes, success_probability) and one disclosed heuristic (statement, scope, extrapolation, limitations). A structural validator rejected out-of-range values, success probability below 0.39, overclaiming language in the limitations, and uncited or invented references.',
        '3. A second, independent model call, prompted adversarially to find a real reason not to trust the claim, had to return PASS. Only then may the package leave `draft`. That verdict and its stated reason are recorded verbatim in claim.json\'s restrictions below.',
        '4. Every structural field not originated by the RAM (target profile, rounds, lane, baseline reference, time unit, preprocessing, advice) is the organizer\'s unmodified `draft_claim()` template value.',
        '5. Organizer checks actually run, with real outcomes:',
        `   - harness precheck (schema and layout): ${checks.precheck ?? 'n/a'}`,
        `   - \`python3 scripts/local_tracks.py check ${track}\` on the harness's pinned copy of the benchmark: ${checks.check ?? 'n/a'}`,
        `   - \`python3 scripts/hashsmash_pipeline.py intake --track ${track}\` on the same copy: ${checks.intake ?? 'n/a'}`,
        `   - \`python3 scripts/local_tracks.py check ${track}\` again on this exact \`yukon clone\`, with this package written in: passed (otherwise nothing is submitted)`,
        `   - package sha256 (this harness's own hash over path and content of every file): ${checks.packageSha256 ?? 'n/a'}`,
        '6. The live AI judge was not run locally. No provider credentials are used by this harness for that, and `yukon run` was not used. Judging is left to Yukon\'s isolated judge job.',
      ]),
    '',
    '## Limitations, stated plainly',
    '',
    ...(isResearchPackage
      ? [
        '- This is prepared, written content, not a model-drafted estimate -- its own stated limitations (claim.json\'s heuristics and restrictions, below) are the real ones to weigh, not a generic disclaimer.',
        '- It did not pass through this harness\'s adversarial-verification model call; that check does not apply to a prepared package the way it does to a RAM\'s own draft.',
        '- No new collision, witness or certificate is claimed. The certificate manifest is empty.',
      ]
      : [
        '- No new collision, witness or certificate is claimed. The certificate manifest is empty.',
        '- The bound is an AI agent\'s own estimate under the single disclosed heuristic below, grounded in a short literature or competitor read. Usually only the cited paper\'s title or the competitor PR\'s own text was read, not the full paper.',
        '- The adversarial verification is another model call. It is not a human review and not a proof. Passing local check and intake is mechanical validity only, not qualification.',
        '- Treat the claim with the skepticism appropriate to a single-session, unreviewed, model-authored estimate.',
      ]),
    '',
    '## claim.json restrictions (verbatim)',
    '',
    ...((claim?.restrictions ?? []).map((r) => `- ${r}`)),
    '',
    '## Disclosed heuristics (verbatim from claim.json)',
    '',
    ...((claim?.heuristics ?? []).flatMap((h) => [`- id \`${h.id}\`, role ${h.role}`, `  - statement: ${h.statement}`, `  - scope: ${h.scope}`, `  - extrapolation: ${h.extrapolation}`, `  - limitations: ${h.limitations}`])),
    '',
    '## proof.md (verbatim)',
    '',
    proof.trim(),
    '',
    '## Next steps',
    '',
    'If a reviewer finds a flaw, the RAM\'s next cycle starts from that finding. The harness resubmits on a track only after a later candidate passes every check above again and strictly lowers time_log2 below both the incumbent and its own previous submission.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

/** Byte size of the note exactly as the Yukon CLI measures it (its own "Model/Harness" prefix included). */
export function noteBytesAsSubmitted(note, model, harness) {
  return Buffer.byteLength(`Model: ${String(model).trim()}\nHarness: ${String(harness).trim()}\n\n${note}`);
}

function candidatePathFor(track) {
  const m = /^(.*)-(exploratory|rigorous)$/.exec(track);
  if (!m) throw new RangeError(`invalid track id: ${track}`);
  return `lanes/${m[2]}/candidates/${m[1]}`;
}

/**
 * The real sequence, inside the RAM's own running sandbox. Never throws:
 * every outcome is `{ ok, submitted, failedStep?, reason, steps, ... }`.
 * Reaching `yukon submit` requires every step before it to succeed for real.
 *
 * @param {any} sbx
 * @param {{
 *   track: string,
 *   files: Array<{ path: string, content: string }>,
 *   candidate: { kind?: string, timeLog2: number, successProbability: number, submissionState: string },
 *   model: string,
 *   attribution?: object|null,
 *   lastSubmitted?: { timeLog2: number }|null,
 *   checks?: { precheck?: string, check?: string, intake?: string, packageSha256?: string },
 *   env?: NodeJS.ProcessEnv,
 * }} p
 */
export async function runLiveSubmissionInSandbox(sbx, { track, files, candidate, model, attribution = null, lastSubmitted = null, checks = {}, env = process.env }) {
  const policy = liveSubmitPolicy(env);
  if (!policy.allowed) {
    return { ok: false, submitted: false, skipped: true, reason: !policy.enabled ? `${LIVE_SUBMIT_FLAG} is not "true"` : `${LIVE_SUBMIT_FLAG}=true but no real YUKON_API_KEY is set`, steps: [] };
  }
  const apiKey = env.YUKON_API_KEY;
  const run = createSandboxRun(sbx, { apiKey });
  const baseEnv = baseSandboxEnv(env);
  const steps = [];
  const record = (id, res) => { const s = { id, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr }; steps.push(s); return s; };
  const stop = (failedStep, reason, extra = {}) => ({ ok: false, submitted: false, failedStep, reason, steps, ...extra });
  const editable = candidatePathFor(track);

  const installed = await installYukonCli(run, baseEnv);
  steps.push(...installed.steps);
  if (!installed.ok) return stop(installed.failedStep, installed.reason);

  const login = record('login', await sandboxLogin(run, apiKey, baseEnv));
  if (login.exitCode !== 0) return stop('login', 'yukon login exited non-zero');

  // A fresh, private directory per attempt so a previous attempt's clone can never leak into this one.
  const parent = `/home/user/ramherd-live/${track}-${Date.now()}`;
  const mk = record('mkdir', await run('mkdir', ['-p', parent], { env: baseEnv }));
  if (mk.exitCode !== 0) return stop('mkdir', 'could not create a working directory in the sandbox');
  const clone = record('clone', await run('yukon', yukonArgs.clone(liveSubmitBenchmarkId(env)), { env: baseEnv, cwd: parent, timeoutMs: 180_000 }));
  if (clone.exitCode !== 0) return stop('clone', 'yukon clone exited non-zero');
  const cd = parseCloneWorkspace(clone.stdout);
  if (!cd) return stop('clone', 'could not find a "cd <dir>" instruction in yukon clone\'s real output');
  const workspaceDir = cd.startsWith('/') || cd.startsWith('~') ? cd : `${parent}/${cd}`;
  const ws = workspaceDir.startsWith('~') ? `/home/user${workspaceDir.slice(1)}` : workspaceDir;

  // The clone must really be the HashSmash benchmark and list this exact track.
  const manifest = record('verify-track', await run('cat', [`${ws}/benchmark.json`], { env: baseEnv }));
  let listed = false;
  try { listed = (JSON.parse(manifest.stdout).tracks || []).some((t) => t?.name === track); } catch { listed = false; }
  if (manifest.exitCode !== 0 || !listed) return stop('verify-track', `the cloned benchmark's own benchmark.json does not list ${track}; refusing to submit to a benchmark this track is not part of`, { workspaceDir: ws });

  // `yukon switch <track>` (local git config only): fails with "track not found" unless this
  // clone's own challenge config really contains the track, so `submit --track` can resolve it.
  const sw = record('switch', await run('yukon', ['switch', track], { env: baseEnv, cwd: ws, timeoutMs: 60_000 }));
  if (sw.exitCode !== 0) return stop('switch', `yukon switch ${track} failed in the cloned challenge; the track is not selectable there`, { workspaceDir: ws });

  // The real current incumbent package for this track, read before anything is overwritten.
  const inc = record('read-incumbent', await run('cat', [`${ws}/${editable}/claim.json`], { env: baseEnv }));
  let incumbentTimeLog2 = null;
  try { const v = JSON.parse(inc.stdout)?.claim?.time_log2; incumbentTimeLog2 = typeof v === 'number' ? v : null; } catch { incumbentTimeLog2 = null; }

  const decision = decideLiveSubmission({ candidate, lastSubmitted, incumbentTimeLog2 });
  if (!decision.shouldSubmit) return { ok: true, submitted: false, decision, reason: decision.reason, steps, workspaceDir: ws, incumbentTimeLog2 };

  // Replace the editable candidate path with exactly our checked package.
  const clear = record('write-package', await run('bash', ['-lc', `rm -rf ${shQuote(`${ws}/${editable}`)} && mkdir -p ${shQuote(`${ws}/${editable}`)}`], { env: baseEnv }));
  if (clear.exitCode !== 0) return stop('write-package', 'could not clear the candidate directory in the clone', { workspaceDir: ws, decision });
  for (const f of files) await sbx.files.write(`${ws}/${editable}/${f.path}`, f.content);

  // The organizer's own mechanical check, again, on the real upstream tree with our package in it.
  const chk = record('check', await run('python3', ['scripts/local_tracks.py', 'check', track], { env: baseEnv, cwd: ws, timeoutMs: 120_000 }));
  if (chk.exitCode !== 0) return stop('check', 'the organizer\'s own check failed on the real cloned benchmark with this package in it; not submitting', { workspaceDir: ws, decision });

  // Note lives outside the clone entirely (TASK.md: keep it out of the editable candidate tree).
  const harness = attribution?.slotId ? `${YUKON_HARNESS} RAM ${attribution.slotId}` : YUKON_HARNESS;
  const noteContent = buildLiveSubmissionNote({ track, candidate, attribution, files, checks, incumbentTimeLog2, lastSubmitted });
  const noteBytes = noteBytesAsSubmitted(noteContent, model, harness);
  if (noteBytes < NOTE_MIN_BYTES) {
    return stop('note', `the honest submission note is ${noteBytes} bytes, under Yukon's ${NOTE_MIN_BYTES}-byte minimum; refusing to pad it with filler, so not submitting`, { workspaceDir: ws, decision });
  }
  const notePath = `${parent}/submission-note.md`;
  await sbx.files.write(notePath, noteContent);

  const sub = record('submit', await run('yukon', yukonArgs.submit({ track, model, harness, noteFile: notePath }), { env: baseEnv, cwd: ws, timeoutMs: 300_000 }));
  return {
    ok: sub.exitCode === 0,
    submitted: sub.exitCode === 0,
    failedStep: sub.exitCode === 0 ? null : 'submit',
    reason: sub.exitCode === 0 ? 'yukon submit exited 0' : 'yukon submit exited non-zero',
    decision,
    steps,
    workspaceDir: ws,
    incumbentTimeLog2,
    model,
    harness,
    noteContent,
  };
}
