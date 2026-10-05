// The real external Yukon/HashSmash submission CLI, wrapped as a gated
// action. EVERY test here uses a FAKE `run`: nothing in this suite ever
// spawns a real `yukon` process, logs in, clones, or submits anything real,
// the same discipline tests/sandbox.test.js uses for the E2B SDK.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  yukonSubmitPolicy, yukonArgs, formatYukonCommand, buildSubmissionNote, createYukonSubmitter,
} from '../server/lib/yukon-submit.js';

const TRACK = 'blake3-r1-exploratory';

/** Records every call; never does anything real. */
function fakeRun(result = { exitCode: 0, stdout: 'ok\n', stderr: '', timedOut: false }) {
  const calls = [];
  return { calls, run: async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return result; } };
}

// ---- policy: off by default, needs BOTH the flag and a real-looking key ----

test('yukonSubmitPolicy is off by default and needs exactly RAMHERD_YUKON_SUBMIT=true plus a real key', () => {
  assert.deepEqual(yukonSubmitPolicy({}), { enabled: false, hasKey: false, allowed: false });
  assert.equal(yukonSubmitPolicy({ RAMHERD_YUKON_SUBMIT: '1' }).enabled, false, 'must be exactly "true"');
  assert.equal(yukonSubmitPolicy({ YUKON_API_KEY: 'yk_fake' }).allowed, false, 'the flag alone is not enough');
  assert.equal(yukonSubmitPolicy({ RAMHERD_YUKON_SUBMIT: 'true' }).allowed, false, 'the flag without a key is not enough');
  assert.equal(yukonSubmitPolicy({ RAMHERD_YUKON_SUBMIT: 'true', YUKON_API_KEY: '  ' }).allowed, false, 'a blank key does not count');
  const on = yukonSubmitPolicy({ RAMHERD_YUKON_SUBMIT: 'true', YUKON_API_KEY: 'yk_fake' });
  assert.deepEqual(on, { enabled: true, hasKey: true, allowed: true });
});

// ---- pure argv / formatting / note-content builders ----

test('yukonArgs builds the exact documented argv for each step and refuses empty fields', () => {
  assert.deepEqual(yukonArgs.login('yk_fake'), ['login', 'yk_fake']);
  assert.deepEqual(yukonArgs.clone('86d5040e-d37d-4f41-bab6-1f2cd57e7398'), ['clone', '86d5040e-d37d-4f41-bab6-1f2cd57e7398']);
  assert.deepEqual(yukonArgs.setup(TRACK), ['setup', '--track', TRACK]);
  assert.deepEqual(yukonArgs.run(TRACK), ['run', '--track', TRACK]);
  assert.deepEqual(
    yukonArgs.submit({ track: TRACK, model: 'deepseek/deepseek-v4-pro', harness: 'HashRammers', noteFile: 'submission-note.md' }),
    ['submit', '--track', TRACK, '--model', 'deepseek/deepseek-v4-pro', '--harness', 'HashRammers', '--note-file', 'submission-note.md'],
  );
  assert.throws(() => yukonArgs.setup('not a track!'), /invalid track/);
  assert.throws(() => yukonArgs.login(''), /apiKey/);
  assert.throws(() => yukonArgs.submit({ track: TRACK, model: '', harness: 'h', noteFile: 'n.md' }), /model/);
  assert.throws(() => yukonArgs.submit({ track: TRACK, model: 'm', harness: '  ', noteFile: 'n.md' }), /harness/);
});

test('formatYukonCommand previews the real command, quoting only where needed', () => {
  assert.equal(formatYukonCommand(['setup', '--track', TRACK]), `yukon setup --track ${TRACK}`);
  assert.equal(
    formatYukonCommand(['submit', '--track', TRACK, '--model', 'anthropic/claude-opus-5.5', '--harness', 'HashRammers RAM slot-2']),
    `yukon submit --track ${TRACK} --model anthropic/claude-opus-5.5 --harness 'HashRammers RAM slot-2'`,
  );
});

test('buildSubmissionNote is built only from real candidate/attribution fields, never invents a result', () => {
  const note = buildSubmissionNote({
    track: TRACK,
    candidate: { kind: 'research', submissionState: 'ready', timeLog2: 86, successProbability: 0.9, summary: 'extends an existing package' },
    attribution: { slotId: 'ram-2', model: 'deepseek/deepseek-v4-pro', approach: 'structural-shortcut' },
  });
  assert.match(note, /# HashRammers submission note — blake3-r1-exploratory/);
  assert.match(note, /RAM slot `ram-2`/);
  assert.match(note, /model `deepseek\/deepseek-v4-pro`/);
  assert.match(note, /approach `structural-shortcut`/);
  assert.match(note, /time 2\^86, success probability 0\.9/);
  assert.match(note, /has not been judged or scored by anyone/);
  assert.equal(/\bcollision found\b|\baccepted\b|\bwon\b/i.test(note), false, 'never claims an outcome nobody gave it');

  const draftNote = buildSubmissionNote({ track: TRACK, candidate: { kind: 'harness-draft', submissionState: 'draft' }, attribution: null });
  assert.match(draftNote, /unmodified `draft_claim\(\)` template/);
  assert.match(draftNote, /RAM slot `unknown`/);
});

// ---- the gated submitter: refuses without BOTH the flag and a key, and never touches `run` until then ----

test('every gated step refuses with the gate off, and the fake run() is never called', async () => {
  const fake = fakeRun();
  const sub = createYukonSubmitter({ env: {}, run: fake.run });
  assert.equal(sub.policy.allowed, false);
  await assert.rejects(sub.login(), /RAMHERD_YUKON_SUBMIT/);
  await assert.rejects(sub.clone('some-id'), /RAMHERD_YUKON_SUBMIT/);
  await assert.rejects(sub.setup(TRACK), /RAMHERD_YUKON_SUBMIT/);
  await assert.rejects(sub.run(TRACK), /RAMHERD_YUKON_SUBMIT/);
  await assert.rejects(sub.submit({ track: TRACK, model: 'm', harness: 'HashRammers', noteFile: 'n.md' }), /RAMHERD_YUKON_SUBMIT/);
  assert.equal(fake.calls.length, 0, 'nothing real (or fake-real) ever ran');
});

test('the flag alone, without a real key, still refuses submit and never calls run()', async () => {
  const fake = fakeRun();
  const sub = createYukonSubmitter({ env: { RAMHERD_YUKON_SUBMIT: 'true' }, run: fake.run });
  assert.equal(sub.policy.allowed, false);
  await assert.rejects(sub.submit({ track: TRACK, model: 'm', harness: 'HashRammers', noteFile: 'n.md' }), /YUKON_API_KEY/);
  assert.equal(fake.calls.length, 0);
});

test('with the flag AND a key, submit() calls the (fake) CLI with the real attribution as --model/--harness', async () => {
  const fake = fakeRun({ exitCode: 0, stdout: 'submission received\n', stderr: '', timedOut: false });
  const sub = createYukonSubmitter({ env: { RAMHERD_YUKON_SUBMIT: 'true', YUKON_API_KEY: 'yk_fake', PATH: '/usr/bin' }, run: fake.run, cwd: '/tmp/fake-clone' });
  assert.equal(sub.policy.allowed, true);
  const res = await sub.submit({ track: TRACK, model: 'deepseek/deepseek-v4-pro', harness: 'HashRammers RAM slot-4', noteFile: 'submission-note.md' });
  assert.equal(res.exitCode, 0);
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.equal(call.cmd, 'yukon');
  assert.deepEqual(call.args, ['submit', '--track', TRACK, '--model', 'deepseek/deepseek-v4-pro', '--harness', 'HashRammers RAM slot-4', '--note-file', 'submission-note.md']);
  assert.equal(call.opts.cwd, '/tmp/fake-clone');
  // The real key is never put in argv or env beyond what login itself needs.
  assert.equal(JSON.stringify(call.args).includes('yk_fake'), false);
  assert.equal(call.opts.env.YUKON_API_KEY, undefined);
});

test('login() sends the real key only as yukon\'s own argv, never logged elsewhere; clone/setup/run follow the documented steps', async () => {
  const fake = fakeRun();
  const env = { RAMHERD_YUKON_SUBMIT: 'true', YUKON_API_KEY: 'yk_fake', PATH: '/usr/bin' };
  const sub = createYukonSubmitter({ env, run: fake.run, cwd: '/tmp/fake-clone' });
  await sub.login();
  await sub.clone('86d5040e-d37d-4f41-bab6-1f2cd57e7398');
  await sub.setup(TRACK, { workspaceDir: '/tmp/fake-clone/blake3-r1' });
  await sub.run(TRACK, { workspaceDir: '/tmp/fake-clone/blake3-r1' });
  assert.deepEqual(fake.calls.map((c) => c.args), [
    ['login', 'yk_fake'],
    ['clone', '86d5040e-d37d-4f41-bab6-1f2cd57e7398'],
    ['setup', '--track', TRACK],
    ['run', '--track', TRACK],
  ]);
  assert.equal(fake.calls[2].opts.cwd, '/tmp/fake-clone/blake3-r1');
});

// ---- writeSubmissionNote: a real, local, safe write (no network) ----

test('writeSubmissionNote writes the honest note to disk and returns exactly what it wrote', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yukon-note-'));
  try {
    const sub = createYukonSubmitter({ env: {}, run: fakeRun().run });
    const path = join(dir, 'nested', 'submission-note.md');
    const content = sub.writeSubmissionNote({
      track: TRACK,
      candidate: { kind: 'research', timeLog2: 86, successProbability: 0.9, submissionState: 'ready' },
      attribution: { slotId: 'ram-5', model: 'qwen/qwen3.8-max-prime', approach: 'trail-search-heuristics' },
      path,
    });
    assert.equal(readFileSync(path, 'utf8'), content);
    assert.match(content, /RAM slot `ram-5`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- commandFor: a safe preview, never runs anything ----

test('commandFor previews the real command without running anything, even with the gate off', () => {
  const fake = fakeRun();
  const sub = createYukonSubmitter({ env: {}, run: fake.run });
  assert.equal(sub.commandFor('setup', TRACK), `yukon setup --track ${TRACK}`);
  assert.equal(
    sub.commandFor('submit', { track: TRACK, model: 'm', harness: 'HashRammers', noteFile: 'n.md' }),
    `yukon submit --track ${TRACK} --model m --harness HashRammers --note-file n.md`,
  );
  assert.equal(fake.calls.length, 0);
});
