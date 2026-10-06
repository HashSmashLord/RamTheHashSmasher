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
  validateLoopAttempt,
  findCitedReference,
  classifyStage,
  DEFAULT_REFERENCE_ROOT,
  HARNESS_MARKER,
  LOOP_DRAFT_MARKER,
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

// ---------------------------------------------------------------------------
// The other four harness-draft tracks (sha3-256-r5/r6, blake3-r1/r2): the
// same honest, no-attack-claimed, organizer-template pattern as sha256-r31
// above, verified for real per track rather than assumed to transfer
// unchanged from SHA-256. get_frontier_track()/draft_claim() in the vendored
// repo's verifier/frontier_tracks.py is already generic across hash
// families, so this is the same code path as sha256-r31 (writeHarnessDraft
// in hashsmash.js is not SHA-256-specific); these tests prove that against
// the real Python, not just read the source and assume it.
// ---------------------------------------------------------------------------

const NEW_HARNESS_TRACKS = ['sha3-256-r5-exploratory', 'sha3-256-r6-exploratory', 'blake3-r1-exploratory', 'blake3-r2-exploratory'];

test('the four newly-wired tracks are harness-draft (not research) and are in PIPELINE_TRACKS', () => {
  for (const track of NEW_HARNESS_TRACKS) {
    assert.ok(PIPELINE_TRACKS.includes(track), `${track} must be a pipeline track`);
    assert.equal(RESEARCH_CANDIDATES[track], undefined, `${track} has no committed research content`);
    assert.equal(runner().candidateKindFor(track), 'harness-draft');
  }
  assert.equal(PIPELINE_TRACKS.length, 6, 'all six active manifest tracks should now be real pipeline tracks');
});

for (const track of NEW_HARNESS_TRACKS) {
  test(`harness draft on ${track}: organizer's own per-track template, labeled, passes real check and real intake stops it as a draft`, { skip: SKIP }, async () => {
    const r = runner();
    const res = await r.runCycle({ slotId: `cycle-${track}`, track });
    assert.equal(res.precheck.ok, true, res.precheck.errors.join('; '));
    assert.equal(res.candidate.kind, 'harness-draft');

    const claim = JSON.parse(readFileSync(join(res.candidateDir, 'claim.json'), 'utf8'));
    assert.equal(claim.submission_state, 'draft');
    assert.ok(claim.restrictions[0].includes(HARNESS_MARKER));
    assert.deepEqual(claim.heuristics, []);
    assert.match(readFileSync(join(res.candidateDir, 'proof.md'), 'utf8'), /No attack is claimed/);

    // Numbers are this track's own organizer draft_claim(), byte-for-byte —
    // not copy-pasted from sha256-r31: each family's digest_bits differ
    // (SHA3-256/BLAKE3 are 256-bit like SHA-256 here, but this reads the
    // real per-track value from the organizer's own code, not an assumption).
    const tpl = JSON.parse(execFileSync('python3', ['-c',
      'import json,sys; from verifier.frontier_tracks import get_frontier_track; print(json.dumps(get_frontier_track(sys.argv[1]).draft_claim()))',
      track,
    ], { cwd: res.workspace, encoding: 'utf8' }));
    assert.deepEqual(claim.claim, tpl.claim);
    assert.equal(claim.target_profile, tpl.target_profile);
    assert.equal(claim.baseline_improved, tpl.baseline_improved);

    const [check, intake, ...rest] = res.stages;
    assert.equal(check.outcome, 'ok');
    assert.equal(check.status, 'mechanically_valid');
    assert.equal(check.parsed[0].submission_state, 'draft');
    assert.equal(intake.outcome, 'draft-not-submitted');
    assert.equal(intake.exitCode, 2);
    assert.match(intake.parsed.package_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(rest, [], 'a draft never proceeds to judge or score');

    const evidence = JSON.parse(readFileSync(intake.evidencePath, 'utf8'));
    assert.equal(evidence.submission.intake_report.package_sha256, intake.parsed.package_sha256);
    assert.equal(evidence.submission.intake_report.submission_state, 'draft');
  });
}

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
  m.setSlotCount(3); // 0 -> sha256-r31, 1 -> sha256-r32 (research package), 2 -> sha3-256-r5 (harness draft)
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

  // sha3-256-r5 is now also a real pipeline track (harness draft), not the
  // mock lifecycle: every roster track runs the real pipeline today.
  assert.equal(r5.assignment.track, 'sha3-256-r5-exploratory');
  await m.advance(r5.id); // idle -> thinking (mock LLM)
  await m.advance(r5.id); // thinking -> running-experiment
  const r5Done = await m.advance(r5.id, { outcome: 'submitted' }); // real pipeline; caller outcome ignored
  assert.equal(r5Done.status, 'validated');
  assert.equal(r5Done.pipeline.candidate, 'harness-draft');
  assert.deepEqual(r5Done.pipeline.stages.map((s) => [s.stage, s.outcome]), [['check', 'ok'], ['intake', 'draft-not-submitted']]);
  assert.match(r5Done.feed.at(-1).message, /no attack is claimed/);
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

// ---------------------------------------------------------------------------
// Loop-authored drafts (slots.js's active loop drafting one of its own
// candidate claims instead of only ever resubmitting the organizer's empty
// template). validateLoopAttempt is the structural honesty gate; it runs
// in-process and needs no python. writeLoopDraftCandidate/runCycle(loopDraft)
// need the real vendored repo + python3, same as every other pipeline test.
// ---------------------------------------------------------------------------

const REAL_SEARCH_RESULTS = [
  { id: '2026/1120', title: 'Pushing Collision Attacks on SHA-2 to 39 Steps' },
  { id: '2026/1080', title: 'A 35-Step Collision Characteristic for Reduced SHA-256' },
];

/** A real-shaped GitHub PR lookup result (sandbox-activity.js's browsePeerSubmissions output), the same confirmed-real shape as PR #302. */
const REAL_PEER_RESULTS = [
  { number: 302, login: 'rickmanelius', title: 'Validate submission 7e5d9c2a-...', claimedScore: '1.5', note: 'claimed score: 1.5', url: 'https://github.com/Layr-Labs/hash-smash/pull/302' },
  { number: 288, login: 'someone-else', title: 'Validate submission 1a2b3c4d-...', claimedScore: null, note: 'no score stated', url: 'https://github.com/Layr-Labs/hash-smash/pull/288' },
];

/** A well-formed attempt that validateLoopAttempt should accept outright. */
function validAttempt(overrides = {}) {
  return {
    attempt: true,
    timeLog2: 131,
    memoryLog2Bytes: 40,
    successProbability: 0.42,
    heuristicId: 'loop-step-extension-1',
    citedPaperId: '2026/1120',
    statement: 'Extending the cited paper\'s filtering idea to this track\'s fixed table may raise its first-block acceptance rate.',
    scope: 'Applies only to the fixed first-block filter this harness draft template uses, not to the full reduced-round construction.',
    extrapolation: 'This session read the cited search result\'s title only and reasoned qualitatively about applicability; no new computation ran this session.',
    limitations: 'No collision was found or measured this session; this is an unverified estimate based only on a paper title, not its contents.',
    ...overrides,
  };
}

test('validateLoopAttempt accepts a well-formed attempt that cites a real search result', () => {
  const res = validateLoopAttempt(validAttempt(), { lastSearchResults: REAL_SEARCH_RESULTS });
  assert.deepEqual(res, { ok: true, errors: [] });
});

test('validateLoopAttempt rejects a non-attempt ("ATTEMPT: no" or malformed) outright', () => {
  assert.equal(validateLoopAttempt(null).ok, false);
  assert.equal(validateLoopAttempt({ attempt: false }).ok, false);
  assert.equal(validateLoopAttempt({}).ok, false);
});

test('validateLoopAttempt rejects a citation that is not a real result from this session\'s own search', () => {
  const res = validateLoopAttempt(validAttempt({ citedPaperId: '2099/9999' }), { lastSearchResults: REAL_SEARCH_RESULTS });
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /does not match any real result/);
});

test('validateLoopAttempt rejects a missing citation the same way as a fake one', () => {
  const res = validateLoopAttempt(validAttempt({ citedPaperId: null }), { lastSearchResults: REAL_SEARCH_RESULTS });
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /CITED_PAPER_ID is required/);
});

// ---------------------------------------------------------------------------
// findCitedReference / the PR-citation extension: a drafted claim may cite
// EITHER a real ePrint search result OR a real competitor's open PR this
// session actually looked at (sandbox-activity.js's browsePeerSubmissions),
// never anything neither of those two real sources actually produced.
// ---------------------------------------------------------------------------

test('findCitedReference resolves a real ePrint id to a tagged eprint record, and a real "PR#<n>" id to a tagged peer-pr record', () => {
  assert.deepEqual(
    findCitedReference('2026/1120', { lastSearchResults: REAL_SEARCH_RESULTS, lastPeerResults: REAL_PEER_RESULTS }),
    { kind: 'eprint', id: '2026/1120', title: 'Pushing Collision Attacks on SHA-2 to 39 Steps' },
  );
  assert.deepEqual(
    findCitedReference('PR#302', { lastSearchResults: REAL_SEARCH_RESULTS, lastPeerResults: REAL_PEER_RESULTS }),
    { kind: 'peer-pr', number: 302, login: 'rickmanelius', title: 'Validate submission 7e5d9c2a-...', url: 'https://github.com/Layr-Labs/hash-smash/pull/302', claimedScore: '1.5' },
  );
  // Case-insensitive on the "PR" marker, and a PR with no claimed score becomes null, not a guess.
  assert.deepEqual(
    findCitedReference('pr#288', { lastPeerResults: REAL_PEER_RESULTS }),
    { kind: 'peer-pr', number: 288, login: 'someone-else', title: 'Validate submission 1a2b3c4d-...', url: 'https://github.com/Layr-Labs/hash-smash/pull/288', claimedScore: null },
  );
});

test('findCitedReference returns null for anything neither real source actually produced', () => {
  assert.equal(findCitedReference(null), null);
  assert.equal(findCitedReference(''), null);
  assert.equal(findCitedReference('NONE'), null);
  assert.equal(findCitedReference('2099/9999', { lastSearchResults: REAL_SEARCH_RESULTS }), null, 'a fake ePrint id');
  assert.equal(findCitedReference('PR#999', { lastPeerResults: REAL_PEER_RESULTS }), null, 'a PR number that was never actually looked at this session');
  assert.equal(findCitedReference('PR#302', { lastPeerResults: [] }), null, 'the real PR list must come from this session, not be assumed');
});

test('validateLoopAttempt accepts a well-formed attempt that honestly cites a real competitor PR instead of an ePrint paper', () => {
  const res = validateLoopAttempt(validAttempt({ citedPaperId: 'PR#302' }), { lastPeerResults: REAL_PEER_RESULTS });
  assert.deepEqual(res, { ok: true, errors: [] });
});

test('validateLoopAttempt rejects a PR citation the real GitHub lookup this session never actually returned', () => {
  const res = validateLoopAttempt(validAttempt({ citedPaperId: 'PR#999' }), { lastPeerResults: REAL_PEER_RESULTS });
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /does not match any real result/);
});

test('validateLoopAttempt rejects numbers out of the schema\'s own range', () => {
  assert.equal(validateLoopAttempt(validAttempt({ successProbability: 0.1 }), { lastSearchResults: REAL_SEARCH_RESULTS }).ok, false);
  assert.equal(validateLoopAttempt(validAttempt({ successProbability: 1.5 }), { lastSearchResults: REAL_SEARCH_RESULTS }).ok, false);
  assert.equal(validateLoopAttempt(validAttempt({ timeLog2: null }), { lastSearchResults: REAL_SEARCH_RESULTS }).ok, false);
  assert.equal(validateLoopAttempt(validAttempt({ memoryLog2Bytes: -1 }), { lastSearchResults: REAL_SEARCH_RESULTS }).ok, false);
});

test('validateLoopAttempt rejects a heuristic id, or any disclosed field, that is missing or too thin', () => {
  assert.equal(validateLoopAttempt(validAttempt({ heuristicId: '' }), { lastSearchResults: REAL_SEARCH_RESULTS }).ok, false);
  assert.equal(validateLoopAttempt(validAttempt({ heuristicId: 'bad id with spaces' }), { lastSearchResults: REAL_SEARCH_RESULTS }).ok, false);
  for (const field of ['statement', 'scope', 'extrapolation', 'limitations']) {
    assert.equal(validateLoopAttempt(validAttempt({ [field]: 'too short' }), { lastSearchResults: REAL_SEARCH_RESULTS }).ok, false, field);
  }
});

test('validateLoopAttempt rejects limitations that claim more certainty than one session can honestly support', () => {
  const res = validateLoopAttempt(validAttempt({ limitations: 'This is proven and the collision is guaranteed to exist under the stated premise.' }), { lastSearchResults: REAL_SEARCH_RESULTS });
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /must not claim the bound is proven/);
  // "unverified" must not false-positive against the "verified" ban.
  assert.equal(validateLoopAttempt(validAttempt(), { lastSearchResults: REAL_SEARCH_RESULTS }).ok, true);
});

test('loop-authored draft: a genuinely valid attempt is written, passes real check, and real intake stops it as a draft', { skip: SKIP }, async () => {
  const r = runner();
  const attempt = validAttempt();
  const citedPaper = REAL_SEARCH_RESULTS[0];
  assert.equal(validateLoopAttempt(attempt, { lastSearchResults: REAL_SEARCH_RESULTS }).ok, true);

  const res = await r.runCycle({ slotId: 'loop-draft-ok', track: TRACK, loopDraft: { attempt, citedPaper } });
  assert.equal(res.precheck.ok, true, res.precheck.errors.join('; '));
  assert.equal(res.candidate.kind, 'loop-draft');

  const claim = JSON.parse(readFileSync(join(res.candidateDir, 'claim.json'), 'utf8'));
  // Forced honesty limits: a loop draft is never 'ready' and never 'score-critical',
  // no matter what the model proposed.
  assert.equal(claim.submission_state, 'draft');
  assert.equal(claim.heuristics.length, 1);
  assert.equal(claim.heuristics[0].role, 'supporting');
  assert.equal(claim.heuristics[0].id, attempt.heuristicId);
  assert.ok(claim.restrictions[0].includes(LOOP_DRAFT_MARKER));
  assert.ok(claim.restrictions.some((x) => x.includes(citedPaper.id)));
  // Exactly the model's three proposed numbers; everything else is the organizer's own template.
  assert.equal(claim.claim.time_log2, attempt.timeLog2);
  assert.equal(claim.claim.memory_log2_bytes, attempt.memoryLog2Bytes);
  assert.equal(claim.claim.success_probability, attempt.successProbability);
  const tpl = JSON.parse(execFileSync('python3', ['-c',
    `import json; from verifier.frontier_tracks import get_frontier_track; print(json.dumps(get_frontier_track("${TRACK}").draft_claim()))`,
  ], { cwd: res.workspace, encoding: 'utf8' }));
  assert.equal(claim.target_profile, tpl.target_profile);
  assert.equal(claim.rounds, tpl.rounds);
  assert.equal(claim.lane, tpl.lane);
  assert.equal(claim.baseline_improved, tpl.baseline_improved);
  assert.equal(claim.claim.preprocessing_log2, tpl.claim.preprocessing_log2);
  assert.equal(claim.claim.nonuniform_advice_log2_bytes, tpl.claim.nonuniform_advice_log2_bytes);

  const proof = readFileSync(join(res.candidateDir, 'proof.md'), 'utf8');
  assert.match(proof, new RegExp(citedPaper.id.replace('/', '\\/')));
  assert.match(proof, /No new collision, witness, or independently-reviewed proof/);

  const [check, intake, ...rest] = res.stages;
  assert.equal(check.status, 'mechanically_valid');
  assert.equal(check.parsed[0].submission_state, 'draft');
  assert.equal(intake.outcome, 'draft-not-submitted');
  assert.equal(intake.exitCode, 2);
  assert.match(intake.parsed.package_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(rest, [], 'a loop-authored draft never proceeds to judge or score either');
});

test('loop-authored draft: a genuine adversarial-verification PASS is the only thing that ever reaches submission_state "ready" -- real, end to end', { skip: SKIP }, async () => {
  const r = runner();
  const attempt = validAttempt();
  const citedPaper = REAL_SEARCH_RESULTS[0];
  const verification = { pass: true, reason: 'The extrapolation genuinely follows from the cited result and the scope matches this exact target.' };

  const res = await r.runCycle({ slotId: 'loop-draft-verified', track: TRACK, loopDraft: { attempt, citedPaper, verification } });
  assert.equal(res.precheck.ok, true, res.precheck.errors.join('; '));

  const claim = JSON.parse(readFileSync(join(res.candidateDir, 'claim.json'), 'utf8'));
  assert.equal(claim.submission_state, 'ready', 'a genuine verification PASS is the one thing that lets this leave draft state');
  assert.equal(claim.heuristics[0].role, 'score-critical');
  assert.ok(claim.restrictions[0].includes('passed a second, independent model call'));
  assert.ok(claim.restrictions[0].includes(verification.reason));

  const proof = readFileSync(join(res.candidateDir, 'proof.md'), 'utf8');
  assert.match(proof, /A second, independent model call.*genuinely passed it/);
  assert.equal(/Nobody has reviewed, judged, or independently verified/.test(proof), false, 'the old unconditional "nobody verified" line must not survive when it genuinely did');

  const [check, intake] = res.stages;
  assert.equal(check.status, 'mechanically_valid');
  assert.equal(check.parsed[0].submission_state, 'ready');
  // Real intake treats a ready, well-formed package as real-pipeline-valid, same as the committed
  // sha256-r32 research package -- this is what actually unlocks a later real Yukon submission.
  assert.notEqual(intake.outcome, 'draft-not-submitted');
});

test('loop-authored draft: a verification FAIL (or none attempted) stays exactly the old, forced-draft behavior', { skip: SKIP }, async () => {
  const r = runner();
  const attempt = validAttempt();
  const citedPaper = REAL_SEARCH_RESULTS[0];

  const failed = await r.runCycle({ slotId: 'loop-draft-failed-verify', track: TRACK, loopDraft: { attempt, citedPaper, verification: { pass: false, reason: 'A real problem was found.' } } });
  const failedClaim = JSON.parse(readFileSync(join(failed.candidateDir, 'claim.json'), 'utf8'));
  assert.equal(failedClaim.submission_state, 'draft');
  assert.equal(failedClaim.heuristics[0].role, 'supporting');
  assert.match(failedClaim.restrictions[0], /the independent verification call did not pass \(A real problem was found\.\)/);

  const none = await r.runCycle({ slotId: 'loop-draft-no-verify', track: TRACK, loopDraft: { attempt, citedPaper } });
  const noneClaim = JSON.parse(readFileSync(join(none.candidateDir, 'claim.json'), 'utf8'));
  assert.equal(noneClaim.submission_state, 'draft');
  assert.match(noneClaim.restrictions[0], /no independent verification was attempted/);
});

test('loop-authored draft: citing a real competitor PR instead of an ePrint paper is written honestly, and still only ever reaches a draft', { skip: SKIP }, async () => {
  const r = runner();
  const attempt = validAttempt({ citedPaperId: 'PR#302' });
  const citedPaper = findCitedReference('PR#302', { lastPeerResults: REAL_PEER_RESULTS });
  assert.equal(citedPaper.kind, 'peer-pr');
  assert.equal(validateLoopAttempt(attempt, { lastPeerResults: REAL_PEER_RESULTS }).ok, true);

  const res = await r.runCycle({ slotId: 'loop-draft-peer-pr', track: TRACK, loopDraft: { attempt, citedPaper } });
  assert.equal(res.precheck.ok, true, res.precheck.errors.join('; '));
  assert.equal(res.candidate.kind, 'loop-draft');

  const claim = JSON.parse(readFileSync(join(res.candidateDir, 'claim.json'), 'utf8'));
  // Same forced honesty limits as an ePrint-cited draft: never ready, never score-critical.
  assert.equal(claim.submission_state, 'draft');
  assert.equal(claim.heuristics[0].role, 'supporting');
  assert.ok(claim.restrictions[0].includes(LOOP_DRAFT_MARKER));
  // The restriction plainly says this is another competitor's own unverified, self-reported claim.
  assert.match(claim.restrictions[1], /real competitor on the real HashSmash repository: PR #302/);
  assert.match(claim.restrictions[1], /not verified by Yukon or anyone else/);
  assert.match(claim.restrictions[1], /claimed score of 1\.5/);

  const proof = readFileSync(join(res.candidateDir, 'proof.md'), 'utf8');
  assert.match(proof, /Cited competitor submission/);
  assert.match(proof, /PR #302 by @rickmanelius/);
  assert.match(proof, /Self-reported claimed score: 1\.5/);
  assert.match(proof, /No new collision, witness, or independently-reviewed proof/);

  const [check, intake, ...rest] = res.stages;
  assert.equal(check.status, 'mechanically_valid');
  assert.equal(intake.outcome, 'draft-not-submitted');
  assert.deepEqual(rest, [], 'a loop-authored draft citing a competitor PR never proceeds to judge or score either');
});

test('loop-authored draft: the committed sha256-r32 research package is never touched by a draft attempt', { skip: SKIP }, async () => {
  const r = runner();
  const attempt = validAttempt();
  const res = await r.runCycle({ slotId: 'loop-draft-r32-noop', track: R32, loopDraft: { attempt, citedPaper: REAL_SEARCH_RESULTS[0] } });
  // RESEARCH_CANDIDATES wins over loopDraft: the real committed package is used, unmodified.
  assert.equal(res.candidate.kind, 'research');
  assert.deepEqual(readFileSync(join(res.candidateDir, 'claim.json')), readFileSync(join(R32_PACKAGE, 'claim.json')));
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
