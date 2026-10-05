// Integration tests against the REAL vendored HashSmash repo and its REAL
// Python CLI. Nothing here mocks the Python: every pipeline verdict asserted
// below is produced by HashSmash's own organizer-owned scripts.
//
// `reference/` is git-ignored in this project, so a fresh clone of HashRammers
// won't have it. These tests skip (loudly) when the vendored repo or python3
// is missing rather than pretending to pass.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHashSmashRunner,
  pipelinePolicy,
  precheckCandidate,
  validateAgainstSchema,
  classifyStage,
  DEFAULT_REFERENCE_ROOT,
  HARNESS_MARKER,
  PIPELINE_TRACKS,
  RESEARCH_CANDIDATES,
} from '../server/lib/hashsmash.js';
import { createSlotManager } from '../server/lib/slots.js';
import { createMockLlmProvider } from '../server/lib/llm.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TRACK = 'sha256-r31-exploratory';
const R32 = 'sha256-r32-exploratory';
const R32_PACKAGE = join(ROOT, 'research', 'sha256-r32', 'package');
const VENDORED_R32 = join(DEFAULT_REFERENCE_ROOT, 'lanes', 'exploratory', 'candidates', 'sha256-r32');
const WS = join(ROOT, '.ramherd', `test-workspaces-${process.pid}`);

function pythonOk() {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const SKIP = !existsSync(join(DEFAULT_REFERENCE_ROOT, 'scripts', 'hashsmash_pipeline.py'))
  ? 'vendored HashSmash repo not present at reference/hash-smash (it is git-ignored)'
  : !pythonOk() ? 'python3 not available' : false;

after(() => rmSync(WS, { recursive: true, force: true }));

function runner(opts = {}) {
  return createHashSmashRunner({ workspacesDir: WS, ...opts });
}

// Fingerprint of the vendored repo's real accepted sha256-r31 candidate, used
// to prove the harness never writes into the vendored repo.
function fingerprintRealCandidate() {
  const dir = join(DEFAULT_REFERENCE_ROOT, 'lanes', 'exploratory', 'candidates', 'sha256-r31');
  const h = createHash('sha256');
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(p).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}
const before = SKIP ? null : fingerprintRealCandidate();

// ---------------------------------------------------------------------------
// Policy / gating (pure, always run)
// ---------------------------------------------------------------------------

test('pipelinePolicy is fully off by default', () => {
  const p = pipelinePolicy({});
  assert.deepEqual({ ...p }, { enabled: false, judgeAllowed: false, liveSubmitRequested: false, liveSubmitAllowed: false });
});

test('pipelinePolicy: RAMHERD_PIPELINE=local enables local stages only', () => {
  const p = pipelinePolicy({ RAMHERD_PIPELINE: 'local', OPENROUTER_API_KEY: 'x' });
  assert.equal(p.enabled, true);
  assert.equal(p.judgeAllowed, false);
});

test('pipelinePolicy: judge needs pipeline + RAMHERD_LIVE + key + its own flag, all together', () => {
  const full = { RAMHERD_PIPELINE: 'local', RAMHERD_LIVE: 'true', OPENROUTER_API_KEY: 'x', RAMHERD_HASHSMASH_JUDGE: 'true' };
  assert.equal(pipelinePolicy(full).judgeAllowed, true);
  for (const missing of Object.keys(full)) {
    const env = { ...full };
    delete env[missing];
    assert.equal(pipelinePolicy(env).judgeAllowed, false, `judge must stay off without ${missing}`);
  }
});

test('pipelinePolicy: live submission is never allowed, even when its flag is set', () => {
  const p = pipelinePolicy({ RAMHERD_PIPELINE: 'local', RAMHERD_LIVE: 'true', OPENROUTER_API_KEY: 'x', RAMHERD_HASHSMASH_JUDGE: 'true', RAMHERD_HASHSMASH_SUBMIT: 'true' });
  assert.equal(p.liveSubmitRequested, true);
  assert.equal(p.liveSubmitAllowed, false);
});

test('runner refuses a workspaces dir inside the vendored repo', () => {
  assert.throws(() => createHashSmashRunner({ workspacesDir: join(DEFAULT_REFERENCE_ROOT, 'ws') }), /outside the vendored/);
});

test('validateAgainstSchema enforces required, const, enum, minimum and additionalProperties', () => {
  const schema = {
    type: 'object', additionalProperties: false, required: ['a', 'b'],
    properties: { a: { const: 3 }, b: { enum: ['x', 'y'] }, c: { type: 'number', minimum: 0.39 } },
  };
  assert.deepEqual(validateAgainstSchema(schema, { a: 3, b: 'x', c: 0.5 }), []);
  const errs = validateAgainstSchema(schema, { a: 4, c: 0.1, extra: 1 });
  assert.equal(errs.length, 4);
});

test('classifyStage maps the pipeline exit-code contract', () => {
  assert.equal(classifyStage('intake', { exitCode: 0, stdout: '{"status":"mechanically_valid"}', stderr: '' }).outcome, 'ok');
  assert.equal(classifyStage('intake', { exitCode: 2, stdout: '{"status":"draft_not_submitted"}', stderr: '' }).outcome, 'draft-not-submitted');
  assert.equal(classifyStage('intake', { exitCode: 2, stdout: '', stderr: 'verification failed: x' }).outcome, 'rejected');
  assert.equal(classifyStage('intake', { exitCode: 3, stdout: '', stderr: 'experiment dev setup unavailable' }).outcome, 'environment-blocked');
});

// ---------------------------------------------------------------------------
// Real Python, real repo
// ---------------------------------------------------------------------------

test('preflight finds the vendored repo and a runnable python3', { skip: SKIP }, async () => {
  const pf = await runner().preflight();
  assert.equal(pf.ok, true, pf.problems.join('; '));
  assert.match(pf.python, /^Python 3\./);
  assert.match(pf.referenceHead, /^[0-9a-f]{40}$/);
});

test('real `local_tracks.py list` includes the sha256-r31-exploratory track', { skip: SKIP }, async () => {
  const tracks = await runner().listTracks();
  assert.ok(tracks.length >= 6);
  const t = tracks.find((x) => x.track === TRACK);
  assert.deepEqual(t, { track: TRACK, function: 'sha256', rounds: 31, lane: 'exploratory', nominalSecurityBits: 128 });
  for (const id of PIPELINE_TRACKS) assert.ok(tracks.some((x) => x.track === id), `${id} must exist in the real repo`);
});

test('the real accepted sha256-r31 candidate passes our precheck and the real `check`', { skip: SKIP }, async () => {
  const r = runner();
  const ws = await r.prepareWorkspace('accepted-check');
  const cand = r.candidateDirFor(ws.dir, TRACK);
  const pre = precheckCandidate(cand, ws.dir);
  assert.equal(pre.ok, true, pre.errors.join('; '));
  assert.equal(pre.claim.submission_state, 'ready');
  const res = await r.check(ws.dir, TRACK);
  assert.equal(res.outcome, 'ok');
  assert.equal(res.status, 'mechanically_valid');
  assert.equal(res.parsed[0].submission_state, 'ready');
});

test('real intake on the accepted candidate succeeds (unconditional analytic construction, no experiment, no Docker needed)', { skip: SKIP }, async () => {
  // As of the real organizer repo (Layr-Labs/hash-smash, corrected from the
  // stale mooselumph mirror this was originally written against): the
  // sha256-r31-exploratory accepted candidate declares heuristics: [] and no
  // experiments/manifest.json, so intake never touches Docker at all. If the
  // organizer ever swaps in a heuristic candidate that DOES declare a
  // python-message-pairs-v1 experiment, this would need the Docker-gated
  // branch back (see git history for that version of this test).
  const r = runner();
  const ws = await r.prepareWorkspace('accepted-intake');
  const res = await r.intake(ws.dir, TRACK);
  assert.equal(res.outcome, 'ok', JSON.stringify(res));
  assert.equal(res.status, 'mechanically_valid');
});

test('harness draft: organizer template, labeled, passes real check and real intake stops it as a draft', { skip: SKIP }, async () => {
  const r = runner();
  const res = await r.runCycle({ slotId: 'cycle-0', track: TRACK });
  assert.equal(res.precheck.ok, true, res.precheck.errors.join('; '));

  const claim = JSON.parse(readFileSync(join(res.candidateDir, 'claim.json'), 'utf8'));
  assert.equal(claim.submission_state, 'draft');
  assert.ok(claim.restrictions[0].includes(HARNESS_MARKER));
  assert.deepEqual(claim.heuristics, []);
  assert.match(readFileSync(join(res.candidateDir, 'proof.md'), 'utf8'), /No attack is claimed/);

  // Numbers are the organizer's own draft_claim(), byte-for-byte.
  const tpl = JSON.parse(execFileSync('python3', ['-c',
    'import json; from verifier.frontier_tracks import get_frontier_track; print(json.dumps(get_frontier_track("sha256-r31-exploratory").draft_claim()))',
  ], { cwd: res.workspace, encoding: 'utf8' }));
  assert.deepEqual(claim.claim, tpl.claim);

  const [check, intake, ...rest] = res.stages;
  assert.equal(check.status, 'mechanically_valid');
  assert.equal(check.parsed[0].submission_state, 'draft');
  assert.equal(intake.outcome, 'draft-not-submitted');
  assert.equal(intake.exitCode, 2);
  assert.match(intake.parsed.package_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(rest, [], 'a draft never proceeds to judge or score');

  // The evidence file intake wrote is real and binds this exact package.
  const evidence = JSON.parse(readFileSync(intake.evidencePath, 'utf8'));
  assert.equal(evidence.submission.intake_report.package_sha256, intake.parsed.package_sha256);
  assert.equal(evidence.submission.intake_report.submission_state, 'draft');
});

test('real intake genuinely rejects a broken package (it is not a rubber stamp)', { skip: SKIP }, async () => {
  const r = runner();
  const ws = await r.prepareWorkspace('broken');
  const { candidateDir } = await r.writeHarnessDraft(ws.dir, TRACK, { slotId: 'broken' });
  const claimPath = join(candidateDir, 'claim.json');
  const claim = JSON.parse(readFileSync(claimPath, 'utf8'));
  claim.claim.success_probability = 0.1; // below the schema's 0.39 floor
  writeFileSync(claimPath, JSON.stringify(claim));

  const pre = precheckCandidate(candidateDir, ws.dir);
  assert.equal(pre.ok, false);
  assert.ok(pre.errors.some((e) => e.includes('success_probability')));

  const res = await r.intake(ws.dir, TRACK);
  assert.equal(res.outcome, 'rejected');
  assert.equal(res.exitCode, 2);
  assert.match(res.detail, /verification failed/);
});

test('real intake rejects an unexpected file at the package root', { skip: SKIP }, async () => {
  const r = runner();
  const ws = await r.prepareWorkspace('extra-file');
  const { candidateDir } = await r.writeHarnessDraft(ws.dir, TRACK, { slotId: 'extra-file' });
  writeFileSync(join(candidateDir, 'notes.txt'), 'not allowed here\n');
  assert.equal(precheckCandidate(candidateDir, ws.dir).ok, false);
  const res = await r.intake(ws.dir, TRACK);
  assert.equal(res.outcome, 'rejected');
});

test('judge is gated off by default and never spawns the pipeline', { skip: SKIP }, async () => {
  const r = runner();
  const res = await r.judge('/nonexistent', TRACK);
  assert.equal(res.outcome, 'gated');
  assert.equal((await r.score('/nonexistent', TRACK)).outcome, 'gated');
});

test('even with the judge gate forced open, the real pipeline refuses to judge a draft (no key passed)', { skip: SKIP }, async () => {
  const r = runner({ judgeAllowed: true, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const ws = await r.prepareWorkspace('judge-draft');
  await r.writeHarnessDraft(ws.dir, TRACK, { slotId: 'judge-draft' });
  await r.intake(ws.dir, TRACK);
  const res = await r.judge(ws.dir, TRACK);
  assert.equal(res.outcome, 'rejected');
  assert.match(res.detail, /draft templates are not submitted to the judge/);
});

test('submitLive always refuses', async () => {
  await assert.rejects(() => runner().submitLive(), /not implemented/);
});

// ---------------------------------------------------------------------------
// Attribution: which RAM (slot id, model, track, approach) produced a
// candidate, recorded OUTSIDE the package and outside the vendored repo
// clone. Pure fs code (no python/git), so unlike most of this file it does
// not need the vendored repo and is never SKIP-gated.
// ---------------------------------------------------------------------------

test('writeAttribution records which RAM produced a candidate, outside the package, never touching claim.json', () => {
  const attrDir = join(WS, 'attr-test-basic');
  const r = runner({ attributionDir: attrDir });
  const candidate = { kind: 'research', submissionState: 'ready', timeLog2: 86, successProbability: 0.9 };
  const { path, record } = r.writeAttribution({
    slotId: 'ram-3', track: R32, model: 'anthropic/claude-fable-5.1', approach: 'literature-replication', modelSource: 'roster', candidate, head: 'deadbeef',
  });
  assert.equal(path, join(attrDir, `ram-3__${R32}.json`));
  assert.equal(record.slotId, 'ram-3');
  assert.equal(record.track, R32);
  assert.equal(record.model, 'anthropic/claude-fable-5.1');
  assert.equal(record.approach, 'literature-replication');
  assert.equal(record.modelSource, 'roster');
  assert.equal(record.referenceHead, 'deadbeef');
  assert.equal(record.candidateKind, 'research');
  assert.equal(record.submissionState, 'ready');
  assert.equal(record.timeLog2, 86);
  assert.equal(record.successProbability, 0.9);
  assert.match(record.note, /internal attribution record/i);
  assert.match(record.note, /no real external submission mechanism yet/i);
  assert.match(record.producedAt, /^\d{4}-\d{2}-\d{2}T/);
  // Written to disk exactly as returned, and nowhere near the candidate package.
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), record);
  assert.equal(dirname(path), resolve(attrDir));
});

test('writeAttribution tolerates an unknown model/approach (defaults to null) and refuses a bad slot id or track', () => {
  const attrDir = join(WS, 'attr-test-defaults');
  const r = runner({ attributionDir: attrDir });
  const { record } = r.writeAttribution({ slotId: 'ram-4', track: TRACK, candidate: { kind: 'harness-draft' } });
  assert.equal(record.model, null);
  assert.equal(record.approach, null);
  assert.equal(record.modelSource, null);
  assert.equal(record.successProbability, null);
  assert.throws(() => r.writeAttribution({ slotId: '../evil', track: TRACK, candidate: {} }), /invalid slot id/);
  assert.throws(() => r.writeAttribution({ slotId: 'ok', track: 'not-a-real-track', candidate: {} }), /invalid track/);
});

test('a RAM slot on sha256-r31-exploratory drives the real pipeline through its lifecycle', { skip: SKIP }, async () => {
  const m = createSlotManager({ llmProvider: createMockLlmProvider(), pipelineRunner: runner(), idPrefix: 'itest' });
  m.setSlotCount(3); // 0 -> sha256-r31, 1 -> sha256-r32 (research package), 2 -> sha3-256-r5 (mock)
  const [r31, , r5] = m.getSlots();
  assert.equal(r31.assignment.track, TRACK);

  await m.advance(r31.id); // idle -> thinking (mock LLM)
  await m.advance(r31.id); // thinking -> running-experiment
  const done = await m.advance(r31.id, { outcome: 'submitted' }); // real pipeline; caller outcome ignored
  assert.equal(done.status, 'validated');
  assert.equal(done.pipeline.candidate, 'harness-draft');
  assert.deepEqual(done.pipeline.stages.map((s) => [s.stage, s.outcome]), [['check', 'ok'], ['intake', 'draft-not-submitted']]);
  assert.match(done.pipeline.stages[1].packageSha256, /^[0-9a-f]{64}$/);
  const types = done.feed.map((f) => f.type);
  assert.ok(types.includes('pipeline-check') && types.includes('pipeline-intake') && types.includes('validated'));
  assert.match(done.feed.at(-1).message, /no attack is claimed/);
  assert.equal((await m.advance(r31.id)).status, 'idle');

  // Unsupported track keeps the mock lifecycle (no pipeline run).
  assert.equal(r5.assignment.track, 'sha3-256-r5-exploratory');
  await m.advance(r5.id);
  await m.advance(r5.id);
  const mock = await m.advance(r5.id);
  assert.equal(mock.status, 'submitted');
  assert.equal(mock.pipeline, null);
});


// ---------------------------------------------------------------------------
// sha256-r32 research package (research/sha256-r32/package)
// ---------------------------------------------------------------------------

test('sha256-r32 is a pipeline track with a committed research package', () => {
  assert.ok(PIPELINE_TRACKS.includes(R32));
  assert.equal(RESEARCH_CANDIDATES[R32].dir, R32_PACKAGE);
  for (const f of RESEARCH_CANDIDATES[R32].files) assert.ok(existsSync(join(R32_PACKAGE, f)), `${f} must be committed`);
  assert.equal(runner().candidateKindFor(R32), 'research');
  assert.equal(runner().candidateKindFor(TRACK), 'harness-draft');
});

test('research package: honest boundary statements are present and the claim is not rounded up', { skip: SKIP }, () => {
  const proof = readFileSync(join(R32_PACKAGE, 'proof.md'), 'utf8');
  const claim = JSON.parse(readFileSync(join(R32_PACKAGE, 'claim.json'), 'utf8'));
  const vendored = JSON.parse(readFileSync(join(VENDORED_R32, 'claim.json'), 'utf8'));
  // No better bound than the package it extends: same resource vector, same success.
  assert.deepEqual(claim.claim, vendored.claim);
  assert.equal(claim.target_profile, 'sha256-r32-prefix-v1');
  assert.equal(claim.submission_state, 'ready');
  // Still says plainly that no collision exists and the yield premise is not a theorem.
  assert.match(proof, /No complete standard-IV r32 collision was computed/);
  assert.match(proof, /## 12\. Independent reproduction and staged tail-yield measurement/);
  assert.match(proof, /no full C32 second-block collision was observed/i);
  // Original sections 1-11 are kept byte-for-byte, so every original proof:<line>
  // evidence reference still points at the same text.
  const original = readFileSync(join(VENDORED_R32, 'proof.md'), 'utf8');
  assert.ok(proof.startsWith(original.trimEnd()), 'sections 1-11 must be the unchanged original text');
  // Every heuristic keeps its id; the yield heuristic now cites the new section.
  assert.deepEqual(claim.heuristics.map((h) => h.id), vendored.heuristics.map((h) => h.id));
  const yieldH = claim.heuristics.find((h) => h.id === 'fixed-slice-average-tail-yield');
  const lines = proof.split('\n').length;
  const newRefs = yieldH.evidence_ids.filter((r) => Number(/^proof:(\d+)/.exec(r)?.[1]) > original.split('\n').length);
  assert.ok(newRefs.length >= 1, 'yield heuristic must cite the new measurement section');
  for (const r of newRefs) assert.ok(Number(/-(\d+)$/.exec(r)?.[1] ?? /:(\d+)$/.exec(r)[1]) <= lines);
});

test('research cycle on sha256-r32: real check and real intake on the committed package', { skip: SKIP }, async () => {
  const r = runner();
  const res = await r.runCycle({ slotId: 'r32-research', track: R32 });
  assert.equal(res.precheck.ok, true, res.precheck.errors.join('; '));
  assert.equal(res.candidate.kind, 'research');
  assert.equal(res.candidate.submissionState, 'ready');
  assert.equal(res.candidate.timeLog2, 86);
  // What the pipeline saw is byte-for-byte the committed package.
  for (const f of RESEARCH_CANDIDATES[R32].files) {
    assert.deepEqual(readFileSync(join(res.candidateDir, f)), readFileSync(join(R32_PACKAGE, f)), f);
  }
  const [check, intake, judge, ...rest] = res.stages;
  assert.equal(check.outcome, 'ok');
  assert.equal(check.status, 'mechanically_valid');
  assert.equal(check.parsed[0].submission_state, 'ready');
  assert.equal(intake.outcome, 'ok');
  assert.equal(intake.exitCode, 0);
  assert.equal(intake.status, 'mechanically_valid');
  assert.match(intake.parsed.package_sha256, /^[0-9a-f]{64}$/);
  // The paid judge stays gated by default; score never runs after a gated judge.
  assert.equal(judge.stage, 'judge');
  assert.equal(judge.outcome, 'gated');
  assert.deepEqual(rest, []);
  const evidence = JSON.parse(readFileSync(intake.evidencePath, 'utf8'));
  assert.equal(evidence.submission.intake_report.package_sha256, intake.parsed.package_sha256);
  assert.equal(evidence.submission.intake_report.submission_state, 'ready');

  // It is genuinely a different package from the vendored one.
  const ws = await r.prepareWorkspace('r32-vendored');
  const vendoredIntake = await r.intake(ws.dir, R32);
  assert.equal(vendoredIntake.outcome, 'ok');
  assert.notEqual(vendoredIntake.parsed.package_sha256, intake.parsed.package_sha256);
});

test('a RAM slot on sha256-r32-exploratory runs the research package, not the empty template', { skip: SKIP }, async () => {
  const m = createSlotManager({ llmProvider: createMockLlmProvider(), pipelineRunner: runner(), idPrefix: 'r32test' });
  m.setSlotCount(2);
  const r32 = m.getSlots()[1];
  assert.equal(r32.assignment.track, R32);
  await m.advance(r32.id);
  const running = await m.advance(r32.id);
  assert.match(running.feed.at(-1).message, /committed research package/);
  const done = await m.advance(r32.id);
  assert.equal(done.status, 'validated');
  assert.equal(done.pipeline.candidate, 'research');
  assert.equal(done.pipeline.candidateDetail.timeLog2, 86);
  assert.deepEqual(done.pipeline.stages.map((s) => [s.stage, s.outcome]), [['check', 'ok'], ['intake', 'ok'], ['judge', 'gated']]);
  const last = done.feed.at(-1).message;
  assert.match(last, /mechanical checks only/);
  assert.match(last, /not a verdict/);
  assert.doesNotMatch(last, /accepted|broken|collision found/i);
});

function compilerOk() {
  try {
    execFileSync('clang', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('r32.c independently reproduces every finite fact the package states', { skip: compilerOk() ? false : 'clang not available' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ramherd-r32-'));
  try {
    execFileSync('clang', ['-O2', '-o', join(dir, 'r32'), join(ROOT, 'research', 'sha256-r32', 'r32.c'), '-lpthread'], { stdio: 'pipe' });
    const out = execFileSync(join(dir, 'r32'), ['selftest'], { cwd: dir, encoding: 'utf8' });
    const expect = {
      'admissible W7': 524288, 'admissible W8': 1048576, 'surviving (W8,E4,A0)': 44,
      'table records': 593920, 'distinct A(-1) keys': 408576, 'max records per key': 4,
      'admissible W14': 12, tails: 196608, 'published record present': 1, 'published tail present': 1,
      'tails with the printed (uncorrected) equalities:': 0,
    };
    for (const [k, v] of Object.entries(expect)) assert.match(out, new RegExp(`^${k.replace(/[()]/g, '\\$&')} ${v}$`, 'm'), k);
    assert.match(out, /regression accepted 1 record f3b8f7ae ab9c6465 6e417236 d68fa526 29b2d81b acb11ef2 replay 1/);
    assert.match(out, /published-CV exhaustive tail scan: C32 collisions 1, C35 collisions 1/);
    const sha = (f) => createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
    // The hashes printed in the package's proof.md sections 4 and 6.
    assert.equal(sha('table_be.bin'), '3cd961f8e0efe18027ec7192b4f0fa9f449659fdae14a5969fe3f6b821c8ebc7');
    assert.equal(sha('tails_be.bin'), '25fb017b0432d0848acb9c08e238220b66277ab987c2a9ff1ada3a8f463fc7b6');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Runs last so it covers every test above, including the r32 research cycles.
test('the vendored repo and its real accepted candidate are never modified', { skip: SKIP }, () => {
  assert.equal(fingerprintRealCandidate(), before);
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: DEFAULT_REFERENCE_ROOT, encoding: 'utf8' });
  assert.equal(status.trim(), '');
});
