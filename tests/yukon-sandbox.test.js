// The real Yukon CLI run INSIDE a sandbox (server/lib/yukon-sandbox.js) and
// its wiring into the slot manager (server/lib/slots.js). Every test here
// uses a FAKE sandbox (`sbx.commands.run` / `sbx.files.write`): nothing in
// this suite ever spawns a real `yukon` process, installs anything, logs in
// with a real key, or submits anything real — same discipline as
// tests/yukon-submit.test.js and tests/sandbox.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  YUKON_TRACK, YUKON_BENCHMARK_ID, YUKON_INSTALL_COMMAND,
  isYukonSandboxTrack, parseCloneWorkspace, decideYukonSubmission, yukonStepMessage,
  createSandboxRun, runYukonSandboxCycle, runYukonSandboxSubmit,
} from '../server/lib/yukon-sandbox.js';
import { createSandboxManager } from '../server/lib/sandbox.js';
import { createSlotManager } from '../server/lib/slots.js';
import { createMockLlmProvider } from '../server/lib/llm.js';
import { assignmentForIndex } from '../server/lib/targets.js';

const KEY = 'yk_fake_real_looking_key_0123456789';
const ON_ENV = { RAMHERD_YUKON_SUBMIT: 'true', YUKON_API_KEY: KEY, HOME: '/home/user', PATH: '/usr/bin:/bin' };
const CLONE_OUT = `Cloning benchmark 86d5040e-d37d-4f41-bab6-1f2cd57e7398...\nDone. Now run:\n  cd ~/yukon-work/blake3-r1\n`;

// ---- pure helpers ----

test('isYukonSandboxTrack is true only for blake3-r1-exploratory', () => {
  assert.equal(isYukonSandboxTrack(YUKON_TRACK), true);
  assert.equal(isYukonSandboxTrack('blake3-r2-exploratory'), false);
  assert.equal(isYukonSandboxTrack('sha256-r31-exploratory'), false);
  assert.equal(isYukonSandboxTrack(undefined), false);
});

test('parseCloneWorkspace finds the real "cd <dir>" line and never guesses one that is not there', () => {
  assert.equal(parseCloneWorkspace(CLONE_OUT), '~/yukon-work/blake3-r1');
  assert.equal(parseCloneWorkspace('cd /home/user/benchmarks/xyz\n'), '/home/user/benchmarks/xyz');
  assert.equal(parseCloneWorkspace('no cd instruction here at all'), null);
  assert.equal(parseCloneWorkspace(''), null);
  assert.equal(parseCloneWorkspace(undefined), null);
});

test('decideYukonSubmission never says yes without a real numeric, genuinely positive measurement', () => {
  assert.equal(decideYukonSubmission({}).shouldSubmit, false);
  assert.equal(decideYukonSubmission({ bestResult: null }).shouldSubmit, false);
  assert.match(decideYukonSubmission({ bestResult: null }).reason, /no real measured result/);
  assert.equal(decideYukonSubmission({ bestResult: { timeLog2: null, successProbability: null } }).shouldSubmit, false);
  assert.equal(decideYukonSubmission({ bestResult: { timeLog2: 86, successProbability: 0 } }).shouldSubmit, false);
  assert.match(decideYukonSubmission({ bestResult: { timeLog2: 86, successProbability: 0 } }).reason, /not a genuine positive result/);
  const yes = decideYukonSubmission({ bestResult: { timeLog2: 86, successProbability: 0.3 } });
  assert.equal(yes.shouldSubmit, true);
  assert.match(yes.reason, /time 2\^86, success probability 0\.3/);
});

test('yukonStepMessage is a short, real, one-line summary', () => {
  assert.equal(yukonStepMessage({ id: 'setup', exitCode: 0, stdout: 'Track ready.\n' }), 'yukon setup: exit 0 — Track ready.');
  assert.equal(yukonStepMessage({ id: 'run', exitCode: 1, stdout: '', stderr: 'boom' }), 'yukon run: exit 1 — boom');
  const long = yukonStepMessage({ id: 'run', exitCode: 0, stdout: 'x'.repeat(1000) });
  assert.ok(long.length < 350);
});

// ---- createSandboxRun: the (cmd, args, opts) -> sbx.commands.run adapter ----

test('createSandboxRun builds the shell string, forwards env/cwd/timeout, and maps the result back', async () => {
  const calls = [];
  const sbx = { commands: { run: async (cmd, opts) => { calls.push({ cmd, opts }); return { exitCode: 0, stdout: 'ok\n', stderr: '' }; } } };
  const run = createSandboxRun(sbx, {});
  const res = await run('yukon', ['clone', YUKON_BENCHMARK_ID], { env: { PATH: '/usr/bin' }, cwd: '/home/user', timeoutMs: 5000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, `yukon clone ${YUKON_BENCHMARK_ID}`);
  assert.deepEqual(calls[0].opts, { envs: { PATH: '/usr/bin' }, cwd: '/home/user', timeoutMs: 5000 });
  assert.deepEqual(res, { exitCode: 0, stdout: 'ok\n', stderr: '', timedOut: false });
});

test('createSandboxRun quotes arguments with spaces/quotes and never 2x-escapes plain ones', async () => {
  const calls = [];
  const sbx = { commands: { run: async (cmd) => { calls.push(cmd); return { exitCode: 0, stdout: '', stderr: '' }; } } };
  const run = createSandboxRun(sbx, {});
  await run('bash', ['-lc', 'yukon login "$YUKON_API_KEY"'], { env: {} });
  assert.equal(calls[0], `bash -lc 'yukon login "$YUKON_API_KEY"'`);
});

test('createSandboxRun scrubs a real key out of a thrown error message', async () => {
  const sbx = { commands: { run: async () => { throw new Error(`auth failed for key ${KEY}`); } } };
  const run = createSandboxRun(sbx, { apiKey: KEY });
  const res = await run('yukon', ['login', 'x'], { env: {} });
  assert.equal(res.exitCode, null);
  assert.equal(res.stderr.includes(KEY), false);
  assert.match(res.stderr, /\[redacted\]/);
});

// ---- runYukonSandboxCycle: the full sequence, and the gate ----

/** A fake sandbox whose `commands.run` answers per-step and records every call. */
function fakeYukonSandbox({ failAt = null, cloneOut = CLONE_OUT } = {}) {
  const calls = [];
  const files = [];
  const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
  const fail = (stdout = '') => ({ exitCode: 1, stdout, stderr: 'failed' });
  const sbx = {
    commands: {
      run: async (cmd, opts) => {
        calls.push({ cmd, opts });
        if (cmd.includes(YUKON_INSTALL_COMMAND)) return failAt === 'install' ? fail() : ok('yukon installed\n');
        if (cmd.includes('yukon login')) return failAt === 'login' ? fail() : ok('logged in\n');
        if (cmd.startsWith('yukon clone')) return failAt === 'clone' ? fail() : ok(cloneOut);
        if (cmd.startsWith('yukon setup')) return failAt === 'setup' ? fail() : ok('setup complete\n');
        if (cmd.startsWith('yukon run')) return failAt === 'run' ? fail() : ok('run complete, no result yet\n');
        if (cmd.startsWith('yukon submit')) return failAt === 'submit' ? fail() : ok('submission received\n');
        return ok();
      },
    },
    files: { write: async (path, data) => { files.push({ path, data }); } },
  };
  return { sbx, calls, files };
}

const blake3Assignment = () => assignmentForIndex(4); // ACTIVE_TRACKS[4] = blake3-r1-exploratory

test('runYukonSandboxCycle is scoped to blake3-r1-exploratory only: wrong track touches the sandbox not at all', async () => {
  const { sbx, calls } = fakeYukonSandbox();
  const result = await runYukonSandboxCycle(sbx, { assignment: assignmentForIndex(0), env: ON_ENV });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /scoped to blake3-r1-exploratory/);
  assert.equal(calls.length, 0);
});

test('THE important test: with the gate off, the real CLI is never invoked — not with no env, not with the flag alone, not with the key alone', async () => {
  const { sbx, calls } = fakeYukonSandbox();
  for (const env of [{}, { RAMHERD_YUKON_SUBMIT: 'true' }, { YUKON_API_KEY: KEY }, { RAMHERD_YUKON_SUBMIT: '1', YUKON_API_KEY: KEY }, { RAMHERD_YUKON_SUBMIT: 'true', YUKON_API_KEY: '   ' }]) {
    const result = await runYukonSandboxCycle(sbx, { assignment: blake3Assignment(), env });
    assert.equal(result.skipped, true, JSON.stringify(env));
  }
  assert.equal(calls.length, 0, 'not one real (or fake-real) command ever reached the sandbox while the gate was off');
});

test('a failure at any step stops the sequence there and never runs the later steps', async () => {
  for (const failAt of ['install', 'login', 'clone', 'setup', 'run']) {
    const { sbx, calls } = fakeYukonSandbox({ failAt });
    const result = await runYukonSandboxCycle(sbx, { assignment: blake3Assignment(), env: ON_ENV });
    assert.equal(result.ok, false);
    assert.equal(result.failedStep, failAt);
    const order = ['install', 'login', 'clone', 'setup', 'run'];
    const idx = order.indexOf(failAt);
    assert.equal(result.steps.length, idx + 1, `expected exactly the steps up to and including ${failAt}`);
    assert.equal(calls.length, idx + 1);
  }
});

test('clone succeeding without a parseable "cd <dir>" line is reported honestly, not guessed', async () => {
  const { sbx } = fakeYukonSandbox({ cloneOut: 'cloned, but no instructions printed\n' });
  const result = await runYukonSandboxCycle(sbx, { assignment: blake3Assignment(), env: ON_ENV });
  assert.equal(result.ok, false);
  assert.equal(result.failedStep, 'clone');
  assert.match(result.reason, /could not find a "cd <dir>" instruction/);
});

test('login never puts the real key in the command text, only in the sandbox env', async () => {
  const { sbx, calls } = fakeYukonSandbox();
  await runYukonSandboxCycle(sbx, { assignment: blake3Assignment(), env: ON_ENV });
  const login = calls.find((c) => c.cmd.includes('yukon login'));
  assert.ok(login);
  assert.equal(login.cmd.includes(KEY), false);
  assert.equal(login.opts.envs.YUKON_API_KEY, KEY);
});

test('a full success with no real measured result yet: ok, not submitted, honest reason, never calls yukon submit', async () => {
  const { sbx, calls } = fakeYukonSandbox();
  const result = await runYukonSandboxCycle(sbx, { assignment: blake3Assignment(), env: ON_ENV, bestResult: null });
  assert.equal(result.ok, true);
  assert.equal(result.submitted, false);
  assert.match(result.decision.reason, /no real measured result/);
  assert.equal(result.workspaceDir, '~/yukon-work/blake3-r1');
  assert.equal(calls.some((c) => c.cmd.startsWith('yukon submit')), false);
});

test('a full success with a genuine real measured result: submits for real (fake CLI), with the right model/harness and an honest note', async () => {
  const { sbx, calls, files } = fakeYukonSandbox();
  const bestResult = { timeLog2: 86, successProbability: 0.2 };
  const result = await runYukonSandboxCycle(sbx, { assignment: blake3Assignment(), env: ON_ENV, bestResult });
  assert.equal(result.ok, true);
  assert.equal(result.submitted, true);
  assert.equal(result.submitResult.ok, true);
  assert.equal(result.submitResult.model, 'deepseek/deepseek-v4-pro'); // this track's real roster model
  assert.equal(result.submitResult.harness, 'HashRammers');
  const submitCall = calls.find((c) => c.cmd.startsWith('yukon submit'));
  assert.match(submitCall.cmd, /--model deepseek\/deepseek-v4-pro/);
  assert.match(submitCall.cmd, /--harness HashRammers/);
  assert.match(submitCall.cmd, /--note-file submission-note\.md/);
  assert.equal(files.length, 1);
  assert.match(files[0].path, /submission-note\.md$/);
  assert.match(files[0].data, /time 2\^86, success probability 0\.2/);
  assert.equal(/\bcollision found\b|\baccepted\b|\bwon\b/i.test(files[0].data), false);
});

test('runYukonSandboxSubmit prefers a real attribution model/harness over the assignment default', async () => {
  const { sbx, calls } = fakeYukonSandbox();
  const result = await runYukonSandboxSubmit(sbx, {
    assignment: blake3Assignment(),
    workspaceDir: '/home/user/yukon-work/blake3-r1',
    bestResult: { timeLog2: 90, successProbability: 0.1 },
    attribution: { slotId: 'slot-4', model: 'anthropic/claude-opus-5.5', approach: 'structural-shortcut' },
    env: ON_ENV,
  });
  assert.equal(result.model, 'anthropic/claude-opus-5.5');
  assert.equal(result.harness, 'HashRammers RAM slot-4');
  assert.equal(calls.some((c) => c.cmd.includes('--model anthropic/claude-opus-5.5')), true);
});

// ---- wired into the slot manager (server/lib/slots.js) ----

function fakeDesktopSdk() {
  const desks = [];
  class Sandbox {
    static async create() {
      let x11 = [];
      const calls = [];
      const sbx = {
        sandboxId: `sbx${desks.length + 1}`,
        getHost: (p) => `${p}-sbx.e2b.app`,
        kill: async () => true,
        commands: {
          run: async (cmd) => {
            calls.push(cmd);
            if (cmd.startsWith('x11vnc -bg')) { x11.push(cmd); return { exitCode: 0, stdout: '', stderr: '' }; }
            if (cmd.startsWith('pkill -x x11vnc')) { x11 = []; return { exitCode: 0, stdout: '', stderr: '' }; }
            if (cmd.startsWith('ps -C x11vnc')) return { exitCode: 0, stdout: `${x11.join('\n')}\n`, stderr: '' };
            if (cmd.includes('yukon') || cmd.includes('curl -fsSL https://api.yukon.org')) {
              throw new Error(`TEST FAILURE: real-looking yukon command reached the sandbox while the gate was off: ${cmd}`);
            }
            return { exitCode: 0, stdout: '', stderr: '' };
          },
        },
        files: { write: async () => {} },
      };
      desks.push({ sbx, calls });
      return sbx;
    }
    static async kill() { return true; }
  }
  return { desks, loadSdk: async () => ({ Sandbox }) };
}

function fakeYukonModule() {
  const calls = [];
  return {
    calls,
    module: {
      isYukonSandboxTrack: (track) => track === YUKON_TRACK,
      runYukonSandboxCycle: async (sbx, opts) => { calls.push({ sbxId: sbx.sandboxId, opts }); return { skipped: true, reason: 'test stub: gate off', steps: [] }; },
      yukonStepMessage: (s) => `yukon ${s.id}: exit ${s.exitCode}`,
    },
  };
}

function slotsWithYukon({ yukonSandbox } = {}) {
  const sdk = fakeDesktopSdk();
  const sandboxManager = createSandboxManager({ apiKey: 'e2b_fakekeyfortests0123456789', loadSdk: sdk.loadSdk });
  const m = createSlotManager({
    llmProvider: createMockLlmProvider(),
    sandboxManager,
    sandboxTask: async () => ({ ok: true, repo: null, claim: null, check: null }),
    yukonSandbox,
  });
  return { sdk, m };
}

test('slots.js only calls into yukon-sandbox.js for the blake3-r1-exploratory slot, never for any other track', async () => {
  const fake = fakeYukonModule();
  const { m } = slotsWithYukon({ yukonSandbox: fake.module });
  m.setSlotCount(5); // ACTIVE_TRACKS[0..4]: the 5th (index 4) is blake3-r1-exploratory
  const slots = m.getSlots();
  assert.equal(slots[4].assignment.track, YUKON_TRACK);

  await m.startSandbox(slots[0].id); // sha256-r31-exploratory
  await m.waitForSandboxTask(slots[0].id);
  assert.equal(fake.calls.length, 0, 'not called for a non-blake3-r1 slot');
  assert.equal(m.getSlot(slots[0].id).feed.some((f) => f.type.startsWith('yukon-')), false);

  await m.startSandbox(slots[4].id); // blake3-r1-exploratory
  await m.waitForSandboxTask(slots[4].id);
  assert.equal(fake.calls.length, 1, 'called exactly once for the blake3-r1-exploratory slot');
  const feed = m.getSlot(slots[4].id).feed;
  assert.equal(feed.at(-1).type, 'yukon-setup-skipped');
  assert.match(feed.at(-1).message, /test stub: gate off/);
});

test('without a yukonSandbox dependency, the blake3-r1-exploratory slot behaves exactly as before (no-op, no yukon-* feed)', async () => {
  const { m } = slotsWithYukon({ yukonSandbox: null });
  m.setSlotCount(5);
  const id = m.getSlots()[4].id;
  await m.startSandbox(id);
  await m.waitForSandboxTask(id);
  const feed = m.getSlot(id).feed;
  assert.equal(feed.some((f) => f.type.startsWith('yukon-')), false);
  assert.equal(feed.at(-1).type, 'sandbox-task-done');
});

test('end-to-end through the REAL yukon-sandbox.js module (not a stub): with the gate off, nothing resembling a real yukon or install command ever reaches the sandbox\'s command channel', async () => {
  const realYukonSandbox = await import('../server/lib/yukon-sandbox.js');
  const { sdk, m } = slotsWithYukon({ yukonSandbox: realYukonSandbox });
  m.setSlotCount(5);
  const id = m.getSlots()[4].id;
  // No RAMHERD_YUKON_SUBMIT, no YUKON_API_KEY in process.env in this test run (the harness never sets them).
  assert.notEqual(process.env.RAMHERD_YUKON_SUBMIT, 'true');
  await m.startSandbox(id);
  await m.waitForSandboxTask(id);
  const feed = m.getSlot(id).feed;
  assert.equal(feed.at(-1).type, 'yukon-setup-skipped');
  assert.match(feed.at(-1).message, /RAMHERD_YUKON_SUBMIT/);
  const desk = sdk.desks[0];
  assert.equal(desk.calls.some((c) => c.includes('yukon') || c.includes('curl -fsSL https://api.yukon.org')), false);
});
