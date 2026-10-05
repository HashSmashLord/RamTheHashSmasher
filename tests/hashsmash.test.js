// Integration tests against the REAL vendored HashSmash repo and its REAL
// Python CLI. Nothing here mocks the Python: every pipeline verdict asserted
// below is produced by HashSmash's own organizer-owned scripts.
//
// `reference/` is git-ignored in this project, so a fresh clone of RAMherd
// won't have it. These tests skip (loudly) when the vendored repo or python3
// is missing rather than pretending to pass.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
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
} from '../server/lib/hashsmash.js';
import { createSlotManager } from '../server/lib/slots.js';
import { createMockLlmProvider } from '../server/lib/llm.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TRACK = 'sha256-r31-exploratory';
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

test('real intake on the accepted candidate: passes with Docker, fails closed as environment-blocked without it', { skip: SKIP }, async () => {
  // This candidate declares a python-message-pairs-v1 experiment, which
  // HashSmash only runs inside its pinned Docker sandbox (no host fallback).
  const r = runner();
  const ws = await r.prepareWorkspace('accepted-intake');
  const res = await r.intake(ws.dir, TRACK);
  let docker = false;
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    docker = true;
  } catch { /* no docker */ }
  if (docker) {
    // Docker present but pinned image may not be pulled; either way the
    // pipeline must give a real verdict, never a silent pass.
    assert.ok(['ok', 'environment-blocked'].includes(res.outcome), JSON.stringify(res));
  } else {
    assert.equal(res.outcome, 'environment-blocked');
    assert.equal(res.exitCode, 3);
    assert.match(res.detail, /Docker is unavailable/);
  }
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

test('a RAM slot on sha256-r31-exploratory drives the real pipeline through its lifecycle', { skip: SKIP }, async () => {
  const m = createSlotManager({ llmProvider: createMockLlmProvider(), pipelineRunner: runner(), idPrefix: 'itest' });
  m.setSlotCount(2); // index 0 -> sha256-r31-exploratory, index 1 -> sha256-r32-exploratory
  const [r31, r32] = m.getSlots();
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
  await m.advance(r32.id);
  await m.advance(r32.id);
  const mock = await m.advance(r32.id);
  assert.equal(mock.status, 'submitted');
  assert.equal(mock.pipeline, null);
});

test('the vendored repo and its real accepted candidate are never modified', { skip: SKIP }, () => {
  assert.equal(fingerprintRealCandidate(), before);
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: DEFAULT_REFERENCE_ROOT, encoding: 'utf8' });
  assert.equal(status.trim(), '');
});
