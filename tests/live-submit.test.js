// REAL live submission to the HashSmash competition (server/lib/live-submit.js,
// hashsmash.js submitLive, slots.js maybeLiveSubmit). Every test here uses a
// FAKE sandbox (`sbx.commands.run` / `sbx.files.write`) and fake runners:
// nothing in this suite ever spawns a real `yukon` process, installs anything,
// logs in with a real key, or submits anything real.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  LIVE_SUBMIT_FLAG, NOTE_MIN_BYTES, liveSubmitPolicy, liveSubmitEligibility, collectCandidateFiles, decideLiveSubmission,
  createLiveSubmissionLedger, runLiveSubmissionInSandbox, buildLiveSubmissionNote, noteBytesAsSubmitted, liveSubmitBenchmarkId,
} from '../server/lib/live-submit.js';
import { createHashSmashRunner, pipelinePolicy, PIPELINE_TRACKS } from '../server/lib/hashsmash.js';
import { YUKON_BENCHMARK_ID, YUKON_PREREQ_COMMAND, YUKON_INSTALL_COMMAND } from '../server/lib/yukon-sandbox.js';
import { createSlotManager } from '../server/lib/slots.js';
import { createMockLlmProvider } from '../server/lib/llm.js';

const KEY = 'yk_fake_real_looking_key_0123456789';
const ON_ENV = { [LIVE_SUBMIT_FLAG]: 'true', YUKON_API_KEY: KEY, HOME: '/home/user', PATH: '/usr/bin:/bin' };
const TRACK = 'sha256-r31-exploratory';
const TMP = mkdtempSync(join(tmpdir(), 'ramherd-live-submit-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
/** A real on-disk candidate package, shaped like writeLoopDraftCandidate's output. */
function writePackage({ state = 'ready', timeLog2 = 131, successProbability = 0.42 } = {}) {
  const dir = join(TMP, `pkg-${seq += 1}`);
  mkdirSync(join(dir, 'certificates'), { recursive: true });
  writeFileSync(join(dir, 'claim.json'), `${JSON.stringify({
    schema_version: 3,
    submission_state: state,
    claim: { time_log2: timeLog2, memory_log2_bytes: 40, success_probability: successProbability },
    restrictions: ['HashRammers loop-authored draft (RAM slot slot-1). This candidate passed a second, independent model call.', 'This RAM cited IACR ePrint 2026/1120.'],
    heuristics: [{ id: 'loop-step-extension-1', role: 'score-critical', statement: 's'.repeat(40), scope: 'c'.repeat(40), extrapolation: 'e'.repeat(40), limitations: 'l'.repeat(40) }],
  }, null, 2)}\n`);
  writeFileSync(join(dir, 'certificates', 'manifest.json'), '{"schema_version":2,"certificates":[]}\n');
  writeFileSync(join(dir, 'proof.md'), `# HashRammers loop-authored draft: ${TRACK}\n\n${'A disclosed, model-authored estimate under one heuristic. '.repeat(40)}\n`);
  return dir;
}

/** A runCycle()-shaped result. */
function cycleFor({ kind = 'loop-draft', state = 'ready', check = 'ok', intake = 'ok', timeLog2 = 131, successProbability = 0.42, precheckOk = true, track = TRACK } = {}) {
  const candidateDir = writePackage({ state, timeLog2, successProbability });
  return {
    track,
    candidateDir,
    head: 'abc',
    workspace: '/ws',
    candidate: { kind, submissionState: state, timeLog2, successProbability, heuristics: ['loop-step-extension-1'], summary: 'test' },
    precheck: { ok: precheckOk, errors: [] },
    stages: [
      { stage: 'check', outcome: check, exitCode: check === 'ok' ? 0 : 2, status: 'mechanically_valid', detail: '' },
      { stage: 'intake', outcome: intake, exitCode: intake === 'ok' ? 0 : 2, status: 'mechanically_valid', detail: '', parsed: { package_sha256: 'f'.repeat(64) } },
      { stage: 'judge', outcome: 'gated', exitCode: null, status: null, detail: '' },
    ],
  };
}

const ESC = '\x1b';
const WS = '/home/user/ramherd-live/hash-smash';

/**
 * A fake sandbox answering the real CLI sequence. `cloneOut` defaults to the
 * REAL format (ANSI-dimmed "$", single-quoted path; read from the real bundle).
 */
function fakeSbx({ failAt = null, tracks = PIPELINE_TRACKS, incumbentTimeLog2 = 136, cloneOut = null } = {}) {
  const calls = [];
  const files = [];
  const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
  const fail = () => ({ exitCode: 1, stdout: '', stderr: 'failed' });
  const sbx = {
    commands: {
      run: async (cmd, opts) => {
        calls.push({ cmd, opts });
        const step = cmd.includes(YUKON_PREREQ_COMMAND) ? 'prereq'
          : cmd.includes(YUKON_INSTALL_COMMAND) ? 'install'
            : cmd.includes('yukon login') ? 'login'
              : cmd.startsWith('mkdir') ? 'mkdir'
                : cmd.startsWith('yukon clone') ? 'clone'
                  : cmd.startsWith('cat') && cmd.includes('benchmark.json') ? 'verify-track'
                    : cmd.startsWith('yukon switch') ? 'switch'
                      : cmd.startsWith('cat') && cmd.includes('claim.json') ? 'read-incumbent'
                        : cmd.includes('rm -rf') ? 'write-package'
                          : cmd.startsWith('python3 scripts/local_tracks.py check') ? 'check'
                            : cmd.startsWith('yukon submit') ? 'submit' : 'other';
        if (step === failAt) return fail();
        if (step === 'clone') return ok(cloneOut ?? `Challenge cloned\nbenchmark  hashsmash\n\nNext steps\n${ESC}[2m$${ESC}[22m cd '${WS}'\n`);
        if (step === 'verify-track') return ok(JSON.stringify({ schemaVersion: 2, name: 'hashsmash', tracks: tracks.map((name) => ({ name })) }));
        if (step === 'read-incumbent') return ok(JSON.stringify({ submission_state: 'ready', claim: { time_log2: incumbentTimeLog2 } }));
        if (step === 'submit') return ok('Submission created\nsubmission 1234-abcd\nstatus queued\n');
        return ok();
      },
    },
    files: { write: async (path, data) => { files.push({ path, data }); } },
  };
  return { sbx, calls, files };
}

function pkgFiles(timeLog2 = 131) {
  return collectCandidateFiles(writePackage({ timeLog2 }), { timeLog2, successProbability: 0.42 }).files;
}
const READY = { kind: 'loop-draft', submissionState: 'ready', timeLog2: 131, successProbability: 0.42 };

// ---- the gate ----

test('THE default: the live-submit gate is off unless BOTH the exact flag and a real key are set', () => {
  assert.equal(liveSubmitPolicy({}).allowed, false);
  assert.equal(liveSubmitPolicy({ [LIVE_SUBMIT_FLAG]: 'true' }).allowed, false, 'flag alone is not enough');
  assert.equal(liveSubmitPolicy({ YUKON_API_KEY: KEY }).allowed, false, 'key alone is not enough');
  assert.equal(liveSubmitPolicy({ [LIVE_SUBMIT_FLAG]: '1', YUKON_API_KEY: KEY }).allowed, false, 'only the exact string "true"');
  assert.equal(liveSubmitPolicy({ [LIVE_SUBMIT_FLAG]: 'true', YUKON_API_KEY: '  ' }).allowed, false, 'a blank key is no key');
  assert.equal(liveSubmitPolicy(ON_ENV).allowed, true);
  // The older RAMHERD_YUKON_SUBMIT / RAMHERD_HASHSMASH_SUBMIT flags never open this gate.
  assert.equal(liveSubmitPolicy({ RAMHERD_YUKON_SUBMIT: 'true', RAMHERD_HASHSMASH_SUBMIT: 'true', YUKON_API_KEY: KEY }).allowed, false);
});

test('pipelinePolicy().liveSubmitAllowed: false by default, true only with the pipeline on AND the flag AND a key', () => {
  assert.equal(pipelinePolicy({}).liveSubmitAllowed, false);
  assert.equal(pipelinePolicy({ RAMHERD_PIPELINE: 'local' }).liveSubmitAllowed, false);
  assert.equal(pipelinePolicy({ ...ON_ENV }).liveSubmitAllowed, false, 'pipeline off -> no runner -> no submission');
  assert.equal(pipelinePolicy({ ...ON_ENV, RAMHERD_PIPELINE: 'local' }).liveSubmitAllowed, true);
});

test('the default benchmark id is the one real id this codebase has, and is overridable (still verified in the clone)', () => {
  assert.equal(liveSubmitBenchmarkId({}), YUKON_BENCHMARK_ID);
  assert.equal(liveSubmitBenchmarkId({ RAMHERD_YUKON_BENCHMARK_ID: ' other-id ' }), 'other-id');
});

// ---- eligibility: never weaker than the pipeline's own verdicts ----

test('liveSubmitEligibility: only a ready loop-draft with precheck ok, real check ok and real intake ok', () => {
  assert.equal(liveSubmitEligibility(cycleFor()).eligible, true);
  const no = (over, re) => {
    const e = liveSubmitEligibility(cycleFor(over));
    assert.equal(e.eligible, false, JSON.stringify(over));
    assert.match(e.reasons.join('; '), re);
  };
  no({ kind: 'harness-draft' }, /only a RAM's own adversarially verified loop-draft/);
  no({ kind: 'research' }, /candidate kind is "research"/);
  no({ state: 'draft' }, /submission_state is "draft"/);
  no({ check: 'rejected' }, /organizer check outcome is "rejected"/);
  no({ intake: 'draft-not-submitted' }, /organizer intake outcome is "draft-not-submitted"/);
  no({ intake: 'environment-blocked' }, /intake outcome is "environment-blocked"/);
  no({ precheckOk: false }, /precheck did not pass/);
  no({ successProbability: 0.2 }, /below the organizer's required 0.39/);
  assert.equal(liveSubmitEligibility(null).eligible, false);
});

test('collectCandidateFiles: reads the real package, refuses a non-ready or mismatched claim.json and symlinks', () => {
  const pkg = collectCandidateFiles(writePackage(), { timeLog2: 131, successProbability: 0.42 });
  assert.deepEqual(pkg.files.map((f) => f.path), ['certificates/manifest.json', 'claim.json', 'proof.md']);
  assert.match(pkg.packageSha256, /^[0-9a-f]{64}$/);
  assert.throws(() => collectCandidateFiles(writePackage({ state: 'draft' }), null), /not "ready"/);
  assert.throws(() => collectCandidateFiles(writePackage({ timeLog2: 131 }), { timeLog2: 120, successProbability: 0.42 }), /does not match/);
  const withLink = writePackage();
  symlinkSync('/etc/passwd', join(withLink, 'certificates', 'leak'));
  assert.throws(() => collectCandidateFiles(withLink, { timeLog2: 131, successProbability: 0.42 }), /symlink/);
});

// ---- resubmit only on genuine improvement ----

test('decideLiveSubmission: must strictly beat the incumbent AND anything this harness already submitted on the track', () => {
  assert.equal(decideLiveSubmission({ candidate: { timeLog2: 131, successProbability: 0.42 }, incumbentTimeLog2: 136 }).shouldSubmit, true);
  assert.match(decideLiveSubmission({ candidate: { timeLog2: 136, successProbability: 0.42 }, incumbentTimeLog2: 136 }).reason, /does not beat the track's current incumbent/);
  assert.equal(decideLiveSubmission({ candidate: { timeLog2: 140, successProbability: 0.42 }, incumbentTimeLog2: 136 }).shouldSubmit, false);
  assert.match(decideLiveSubmission({ candidate: { timeLog2: 131, successProbability: 0.42 }, incumbentTimeLog2: null }).reason, /no honest basis/);
  // Same/worse than our own last real submission: never resubmitted.
  const last = { timeLog2: 131, successProbability: 0.42 };
  assert.match(decideLiveSubmission({ candidate: { timeLog2: 131, successProbability: 0.9 }, lastSubmitted: last, incumbentTimeLog2: 136 }).reason, /not a genuine improvement/);
  assert.equal(decideLiveSubmission({ candidate: { timeLog2: 133, successProbability: 0.42 }, lastSubmitted: last, incumbentTimeLog2: 136 }).shouldSubmit, false);
  // A genuine improvement over both: yes again.
  assert.equal(decideLiveSubmission({ candidate: { timeLog2: 129, successProbability: 0.42 }, lastSubmitted: last, incumbentTimeLog2: 136 }).shouldSubmit, true);
});

test('the per-track ledger persists across a restart and locks one in-flight submission per track', () => {
  const path = join(TMP, 'data', 'live-submissions.json');
  const a = createLiveSubmissionLedger({ persistPath: path });
  assert.equal(a.get(TRACK), null);
  a.record(TRACK, { timeLog2: 131, successProbability: 0.42, slotId: 'slot-1' });
  assert.ok(existsSync(path));
  const b = createLiveSubmissionLedger({ persistPath: path }); // "after a restart"
  assert.equal(b.get(TRACK).timeLog2, 131);
  assert.equal(b.tryLock(TRACK), true);
  assert.equal(b.tryLock(TRACK), false, 'a second concurrent submission on the same track is refused');
  b.unlock(TRACK);
  assert.equal(b.tryLock(TRACK), true);
  const mem = createLiveSubmissionLedger();
  mem.record(TRACK, { timeLog2: 1 });
  assert.equal(mem.get(TRACK).timeLog2, 1);
});

// ---- the in-sandbox sequence ----

test('runLiveSubmissionInSandbox with the gate off touches the sandbox not at all', async () => {
  const { sbx, calls, files } = fakeSbx();
  for (const env of [{}, { [LIVE_SUBMIT_FLAG]: 'true' }, { YUKON_API_KEY: KEY }, { RAMHERD_YUKON_SUBMIT: 'true', YUKON_API_KEY: KEY }]) {
    const r = await runLiveSubmissionInSandbox(sbx, { track: TRACK, files: pkgFiles(), candidate: READY, model: 'm', env });
    assert.equal(r.submitted, false);
    assert.equal(r.skipped, true);
  }
  assert.equal(calls.length, 0);
  assert.equal(files.length, 0);
});

test('full real sequence (fake CLI): installs, logs in without the key in the command, verifies the track, writes the exact package, re-checks, then `yukon submit --track`', async () => {
  const { sbx, calls, files } = fakeSbx({ incumbentTimeLog2: 136 });
  const pkg = pkgFiles();
  const r = await runLiveSubmissionInSandbox(sbx, {
    track: TRACK, files: pkg, candidate: READY, model: 'deepseek/deepseek-v4-pro',
    attribution: { slotId: 'slot-1', model: 'deepseek/deepseek-v4-pro', approach: 'differential' },
    checks: { precheck: 'ok', check: 'ok (exit 0)', intake: 'ok (exit 0)', packageSha256: 'f'.repeat(64) },
    env: ON_ENV,
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.submitted, true);
  assert.deepEqual(r.steps.map((s) => s.id), ['prereq', 'install', 'login', 'mkdir', 'clone', 'verify-track', 'switch', 'read-incumbent', 'write-package', 'check', 'submit']);
  assert.equal(r.workspaceDir, WS, 'the REAL clone output format is parsed');
  assert.equal(r.incumbentTimeLog2, 136);
  // Key: only ever in the sandbox env, never in any command text.
  assert.equal(calls.some((c) => c.cmd.includes(KEY)), false);
  assert.equal(calls.find((c) => c.cmd.includes('yukon login')).opts.envs.YUKON_API_KEY, KEY);
  // Clone uses the real benchmark id.
  assert.equal(calls.find((c) => c.cmd.startsWith('yukon clone')).cmd, `yukon clone ${YUKON_BENCHMARK_ID}`);
  // Exactly our package, into exactly the track's editable path; the note OUTSIDE the clone.
  const pkgWrites = files.filter((f) => f.path.startsWith(`${WS}/lanes/exploratory/candidates/sha256-r31/`));
  assert.deepEqual(pkgWrites.map((f) => f.path.split('/sha256-r31/')[1]).sort(), ['certificates/manifest.json', 'claim.json', 'proof.md']);
  for (const f of pkg) assert.equal(pkgWrites.find((w) => w.path.endsWith(`/${f.path}`)).data, f.content, 'byte-for-byte the checked package');
  const note = files.find((f) => f.path.endsWith('submission-note.md'));
  assert.equal(note.path.startsWith(WS), false, 'the note is never inside the clone');
  assert.ok(noteBytesAsSubmitted(note.data, 'deepseek/deepseek-v4-pro', 'HashRammers RAM slot-1') >= NOTE_MIN_BYTES);
  assert.match(note.data, /No human wrote or reviewed/);
  assert.match(note.data, /No new collision, witness or certificate is claimed/);
  // The real submit call.
  const submit = calls.find((c) => c.cmd.startsWith('yukon submit'));
  assert.match(submit.cmd, /^yukon submit --track sha256-r31-exploratory --model deepseek\/deepseek-v4-pro --harness 'HashRammers RAM slot-1' --note-file \S+submission-note\.md$/);
  assert.equal(submit.opts.cwd, WS);
  // The in-clone check ran BEFORE submit, inside the clone.
  const order = calls.map((c) => c.cmd);
  assert.ok(order.findIndex((c) => c.startsWith('python3 scripts/local_tracks.py check')) < order.findIndex((c) => c.startsWith('yukon submit')));
});

test('a failure at any step before submit stops there and never runs `yukon submit`', async () => {
  for (const failAt of ['prereq', 'install', 'login', 'mkdir', 'clone', 'verify-track', 'switch', 'write-package', 'check']) {
    const { sbx, calls } = fakeSbx({ failAt });
    const r = await runLiveSubmissionInSandbox(sbx, { track: TRACK, files: pkgFiles(), candidate: READY, model: 'm', env: ON_ENV });
    assert.equal(r.submitted, false, failAt);
    assert.equal(r.failedStep, failAt);
    assert.equal(calls.some((c) => c.cmd.startsWith('yukon submit')), false, failAt);
  }
});

test('a clone whose benchmark.json does not list the track is refused, not guessed', async () => {
  const { sbx, calls } = fakeSbx({ tracks: ['blake3-r1-exploratory'] });
  const r = await runLiveSubmissionInSandbox(sbx, { track: TRACK, files: pkgFiles(), candidate: READY, model: 'm', env: ON_ENV });
  assert.equal(r.failedStep, 'verify-track');
  assert.equal(calls.some((c) => c.cmd.startsWith('yukon submit')), false);
});

test('not beating the incumbent, or not beating our own last real submission: honest skip, nothing written, no submit', async () => {
  const a = fakeSbx({ incumbentTimeLog2: 131 });
  const r1 = await runLiveSubmissionInSandbox(a.sbx, { track: TRACK, files: pkgFiles(), candidate: READY, model: 'm', env: ON_ENV });
  assert.equal(r1.ok, true);
  assert.equal(r1.submitted, false);
  assert.match(r1.reason, /does not beat the track's current incumbent/);
  assert.equal(a.files.length, 0);
  assert.equal(a.calls.some((c) => c.cmd.startsWith('yukon submit')), false);

  const b = fakeSbx({ incumbentTimeLog2: 136 });
  const r2 = await runLiveSubmissionInSandbox(b.sbx, { track: TRACK, files: pkgFiles(), candidate: READY, model: 'm', lastSubmitted: { timeLog2: 131, successProbability: 0.42 }, env: ON_ENV });
  assert.equal(r2.submitted, false);
  assert.match(r2.reason, /not a genuine improvement/);
  assert.equal(b.calls.some((c) => c.cmd.startsWith('yukon submit')), false);
});

test('a note under Yukon\'s 5 KiB minimum is refused, never padded with filler', async () => {
  const { sbx, calls } = fakeSbx();
  const tiny = [{ path: 'claim.json', content: '{}' }, { path: 'proof.md', content: 'short' }];
  const r = await runLiveSubmissionInSandbox(sbx, { track: TRACK, files: tiny, candidate: READY, model: 'm', env: ON_ENV });
  assert.equal(r.failedStep, 'note');
  assert.match(r.reason, /refusing to pad/);
  assert.equal(calls.some((c) => c.cmd.startsWith('yukon submit')), false);
  assert.ok(buildLiveSubmissionNote({ track: TRACK, candidate: READY, files: tiny }).length < NOTE_MIN_BYTES);
});

test('a real non-zero `yukon submit` is reported as not submitted', async () => {
  const { sbx } = fakeSbx({ failAt: 'submit' });
  const r = await runLiveSubmissionInSandbox(sbx, { track: TRACK, files: pkgFiles(), candidate: READY, model: 'm', env: ON_ENV });
  assert.equal(r.submitted, false);
  assert.equal(r.failedStep, 'submit');
});

// ---- hashsmash.js submitLive: the gatekeeper ----

test('submitLive (flag off, the default) never calls the submitter, whatever the candidate', async () => {
  let called = 0;
  const r = createHashSmashRunner({ workspacesDir: join(TMP, 'ws-off'), attributionDir: join(TMP, 'attr'), env: {} });
  await assert.rejects(() => r.submitLive(cycleFor(), { submitter: async () => { called += 1; } }), /is not "true"/);
  const keyOnly = createHashSmashRunner({ workspacesDir: join(TMP, 'ws-off'), attributionDir: join(TMP, 'attr'), env: { YUKON_API_KEY: KEY } });
  await assert.rejects(() => keyOnly.submitLive(cycleFor(), { submitter: async () => { called += 1; } }), /is not "true"/);
  assert.equal(called, 0);
});

test('submitLive (flag on): a ready, ok/ok loop-draft reaches the submitter with the exact package; anything else never does', async () => {
  const r = createHashSmashRunner({ workspacesDir: join(TMP, 'ws-on'), attributionDir: join(TMP, 'attr'), env: ON_ENV });
  const seen = [];
  const submitter = async (payload) => { seen.push(payload); return { ok: true, submitted: true, steps: [] }; };
  const res = await r.submitLive(cycleFor(), { submitter });
  assert.equal(res.submitted, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].track, TRACK);
  assert.deepEqual(seen[0].files.map((f) => f.path), ['certificates/manifest.json', 'claim.json', 'proof.md']);
  assert.match(seen[0].checks.intake, /^ok/);
  assert.match(res.packageSha256, /^[0-9a-f]{64}$/);

  for (const over of [{ state: 'draft' }, { kind: 'harness-draft' }, { kind: 'research' }, { check: 'rejected' }, { intake: 'draft-not-submitted' }, { successProbability: 0.1 }, { track: 'md5-r64-exploratory' }]) {
    await assert.rejects(() => r.submitLive(cycleFor(over), { submitter }), /live submission refused/, JSON.stringify(over));
  }
  assert.equal(seen.length, 1, 'no non-eligible candidate ever reached the submitter');
});

// ---- slots.js wiring ----

function fakeSandboxManager(sbx) {
  const runTaskCalls = [];
  return {
    runTaskCalls,
    manager: {
      provider: 'e2b',
      start: async () => ({ sessionId: 'sess-1', template: 'desktop', expiresAt: '2099-01-01T00:00:00Z' }),
      stop: async () => true,
      runTask: async (slotId, fn) => { runTaskCalls.push(slotId); return fn(sbx, { isLive: () => true }); },
      get: () => null,
      count: () => 1,
    },
  };
}

async function runOneCycle({ cycle, liveSubmit, env = ON_ENV, sbx = fakeSbx().sbx }) {
  const real = createHashSmashRunner({ workspacesDir: join(TMP, 'ws-slots'), attributionDir: join(TMP, 'attr'), env });
  const pipelineRunner = { supportsTrack: (t) => t === TRACK, candidateKindFor: () => 'harness-draft', runCycle: async () => cycle, submitLive: real.submitLive };
  const sm = fakeSandboxManager(sbx);
  const m = createSlotManager({ llmProvider: createMockLlmProvider(), pipelineRunner, sandboxManager: sm.manager, liveSubmit });
  m.setSlotCount(1);
  const [{ id }] = m.getSlots();
  await m.startSandbox(id);
  await m.advance(id);
  await m.advance(id);
  const slot = await m.advance(id);
  return { slot, runTaskCalls: sm.runTaskCalls };
}

test('slots.js, flag off (no liveSubmit wired, the default): an eligible cycle never reaches the sandbox or submitLive', async () => {
  const { slot, runTaskCalls } = await runOneCycle({ cycle: cycleFor(), liveSubmit: null, env: {} });
  assert.equal(slot.status, 'validated');
  assert.equal(runTaskCalls.length, 0);
  assert.equal(slot.feed.some((f) => f.type.startsWith('live-submit')), false);
});

test('slots.js, liveSubmit wired but its policy not allowed: still never submits', async () => {
  const ledger = createLiveSubmissionLedger();
  const { slot, runTaskCalls } = await runOneCycle({ cycle: cycleFor(), liveSubmit: { policy: { allowed: false }, ledger, env: {} } });
  assert.equal(runTaskCalls.length, 0);
  assert.equal(slot.feed.some((f) => f.type.startsWith('live-submit')), false);
});

test('slots.js, flag on: a genuinely ready, verified, ok/ok candidate is submitted for real (fake CLI) and recorded in the per-track ledger', async () => {
  const ledger = createLiveSubmissionLedger();
  const { sbx, calls } = fakeSbx({ incumbentTimeLog2: 136 });
  const { slot, runTaskCalls } = await runOneCycle({ cycle: cycleFor(), sbx, liveSubmit: { policy: liveSubmitPolicy(ON_ENV), ledger, env: ON_ENV } });
  assert.equal(runTaskCalls.length, 1);
  assert.equal(calls.filter((c) => c.cmd.startsWith('yukon submit')).length, 1);
  const types = slot.feed.map((f) => f.type);
  assert.ok(types.includes('live-submit-started'));
  assert.equal(slot.feed.at(-1).type, 'live-submit-done');
  assert.match(slot.feed.at(-1).message, /nothing is qualified or scored yet/);
  assert.equal(ledger.get(TRACK).timeLog2, 131);
  assert.equal(ledger.get(TRACK).slotId, slot.id);
  assert.match(ledger.get(TRACK).packageSha256, /^[0-9a-f]{64}$/);
});

test('slots.js, flag on: the same claim is never sent twice; only a genuine improvement goes again', async () => {
  const ledger = createLiveSubmissionLedger();
  const live = { policy: liveSubmitPolicy(ON_ENV), ledger, env: ON_ENV };
  const first = fakeSbx({ incumbentTimeLog2: 136 });
  await runOneCycle({ cycle: cycleFor({ timeLog2: 131 }), sbx: first.sbx, liveSubmit: live });
  assert.equal(first.calls.filter((c) => c.cmd.startsWith('yukon submit')).length, 1);

  const same = fakeSbx({ incumbentTimeLog2: 136 });
  const s2 = await runOneCycle({ cycle: cycleFor({ timeLog2: 131 }), sbx: same.sbx, liveSubmit: live });
  assert.equal(same.calls.some((c) => c.cmd.startsWith('yukon submit')), false);
  assert.equal(s2.slot.feed.at(-1).type, 'live-submit-skipped');
  assert.match(s2.slot.feed.at(-1).message, /not a genuine improvement/);

  const better = fakeSbx({ incumbentTimeLog2: 136 });
  await runOneCycle({ cycle: cycleFor({ timeLog2: 128 }), sbx: better.sbx, liveSubmit: live });
  assert.equal(better.calls.filter((c) => c.cmd.startsWith('yukon submit')).length, 1);
  assert.equal(ledger.get(TRACK).timeLog2, 128);
});

test('slots.js, flag on: a draft, a non-ok intake, a harness draft or the research package never triggers it', async () => {
  for (const over of [{ state: 'draft', intake: 'draft-not-submitted' }, { kind: 'harness-draft', state: 'draft', intake: 'draft-not-submitted' }, { kind: 'research' }, { check: 'rejected' }]) {
    const ledger = createLiveSubmissionLedger();
    const { sbx, calls } = fakeSbx();
    const { slot, runTaskCalls } = await runOneCycle({ cycle: cycleFor(over), sbx, liveSubmit: { policy: liveSubmitPolicy(ON_ENV), ledger, env: ON_ENV } });
    assert.equal(runTaskCalls.length, 0, JSON.stringify(over));
    assert.equal(calls.length, 0, JSON.stringify(over));
    assert.equal(ledger.get(TRACK), null);
    assert.equal(slot.feed.some((f) => f.type === 'live-submit-done'), false);
  }
});

test('slots.js, flag on: a failed real submit is reported and never recorded as submitted', async () => {
  const ledger = createLiveSubmissionLedger();
  const { sbx } = fakeSbx({ failAt: 'submit' });
  const { slot } = await runOneCycle({ cycle: cycleFor(), sbx, liveSubmit: { policy: liveSubmitPolicy(ON_ENV), ledger, env: ON_ENV } });
  assert.equal(slot.feed.at(-1).type, 'live-submit-error');
  assert.equal(ledger.get(TRACK), null, 'a failed attempt must never look like "already submitted this number"');
  assert.equal(ledger.tryLock(TRACK), true, 'the in-flight lock is always released');
});

test('nothing in the repo turns the flag on by default', () => {
  for (const f of ['fly.toml', 'Dockerfile', 'package.json']) {
    const p = join(process.cwd(), f);
    if (existsSync(p)) assert.equal(readFileSync(p, 'utf8').includes(LIVE_SUBMIT_FLAG), false, f);
  }
});
