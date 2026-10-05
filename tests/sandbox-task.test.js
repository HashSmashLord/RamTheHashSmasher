// Sandbox workbench task (server/lib/sandbox-task.js). Every test uses a FAKE
// desktop: no real sandbox is created here (each would bill real E2B time).
// The real end-to-end run is scripts/prove-sandbox-task.mjs, opt-in only.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runWorkbenchTask, workbenchSteps, checkAssignment, shQuote, bashRc, waitForExitsCommand,
  HASHSMASH_REPO_URL, EXITS_FILE,
} from '../server/lib/sandbox-task.js';
import { ACTIVE_TRACKS, assignmentForIndex } from '../server/lib/targets.js';
import { createSandboxManager } from '../server/lib/sandbox.js';
import { createSlotManager } from '../server/lib/slots.js';
import { createMockLlmProvider } from '../server/lib/llm.js';

const HEAD = '86f1102ff2d6873db29d992599412ae9eb23bda2';
const CLAIM = {
  schema_version: 3, submission_state: 'ready', target_profile: 'sha256-r31-prefix-v1', attack_class: 'ordinary-collision',
  claim: { time_log2: 136, memory_log2_bytes: 138, success_probability: 0.6 },
};

/**
 * A fake desktop that behaves like the real one where the task depends on it:
 * a terminal window appears once launched, typed text accumulates until Return,
 * Return "runs" the line and appends its exit status to the exits file (as the
 * real PROMPT_COMMAND does), and the wait loop answers from that file.
 */
function fakeDesktop({ exitFor = () => 0, noWindow = false, hangOn = null, check = [{ track: 'sha256-r31-exploratory', status: 'mechanically_valid', qualified: false }] } = {}) {
  const log = [];
  const state = { launched: false, typedLine: '', ran: [], exits: [], focused: null, rc: null };
  const sbx = {
    sandboxId: 'fake1',
    commands: {
      run: async (cmd, opts = {}) => {
        log.push({ cmd, opts });
        const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
        if (cmd.includes("<<'RAMTASK_RC'")) { state.rc = cmd; return ok(); }
        if (cmd.startsWith('xfce4-terminal')) {
          state.launched = true;
          state.exits.push(0); // the shell's first prompt
          return ok();
        }
        if (cmd.includes('xdotool search')) return ok(state.launched && !noWindow ? '4194307\n' : '');
        if (cmd.startsWith('xdotool windowactivate')) { state.focused = cmd.match(/--sync (\d+)/)?.[1]; return ok(); }
        if (cmd.startsWith('xdotool type')) {
          const m = cmd.match(/ -- '((?:[^']|'\\'')*)' && xdotool key Return$/);
          assert.ok(m, `unexpected type command: ${cmd}`);
          const line = m[1].replace(/'\\''/g, "'");
          if (state.focused !== '4194307') throw new Error('typed into an unfocused window');
          state.ran.push(line);
          if (line !== hangOn) state.exits.push(exitFor(line));
          return ok();
        }
        if (cmd.includes(`wc -l < ${EXITS_FILE}`)) {
          const want = Number(cmd.match(/-ge (\d+)/)[1]);
          return ok(state.exits.length >= want ? `${state.exits.at(-1)}\n` : 'TIMEOUT\n');
        }
        if (cmd.includes('git rev-parse HEAD')) return ok(`${HEAD}\n${HASHSMASH_REPO_URL}\n`);
        if (cmd.includes('claim.json')) return ok(JSON.stringify(CLAIM));
        if (cmd.includes('check.json')) return ok(JSON.stringify(check));
        return ok();
      },
    },
  };
  return { sbx, log, state };
}

const r31 = () => ({ ...ACTIVE_TRACKS[0], approach: 'literature-replication' });

test('the step list is the real repo, the track\'s real paths, in order', () => {
  const steps = workbenchSteps(r31());
  assert.deepEqual(steps.map((s) => s.id), ['clone', 'head', 'task', 'cd', 'claim', 'check']);
  assert.equal(steps[0].command, 'git clone --depth 1 https://github.com/Layr-Labs/hash-smash ~/hash-smash');
  assert.equal(steps[2].command, 'cat tracks/sha256-r31-exploratory/TASK.md');
  assert.equal(steps[3].command, 'cd lanes/exploratory/candidates/sha256-r31 && ls -la . certificates');
  assert.equal(steps[4].command, 'cat claim.json');
  assert.match(steps[5].command, /local_tracks\.py check sha256-r31-exploratory/);
  assert.equal(steps[5].required, false);
});

test('every active track yields a valid step list', () => {
  for (let i = 0; i < ACTIVE_TRACKS.length; i++) {
    const a = assignmentForIndex(i);
    const steps = workbenchSteps(a);
    assert.ok(steps[3].command.startsWith(`cd ${a.editablePath} `));
  }
});

test('assignments that could inject shell are refused before anything runs', async () => {
  for (const bad of [
    { track: 'sha256-r31-exploratory; rm -rf ~', editablePath: 'lanes/exploratory/candidates/sha256-r31' },
    { track: 'sha256-r31-exploratory', editablePath: 'lanes/exploratory/candidates/sha256-r31 && curl x' },
    { track: 'sha256-r31-exploratory', editablePath: '../../etc' },
    { track: 'sha256-r31-exploratory', editablePath: 'lanes/exploratory/candidates/sha256-r32' },
    { track: 'sha256-r31-rigorous', editablePath: 'lanes/rigorous/candidates/sha256-r31' },
    {},
  ]) {
    assert.throws(() => checkAssignment(bad), RangeError);
    const { sbx, log } = fakeDesktop();
    await assert.rejects(runWorkbenchTask(sbx, bad), RangeError);
    assert.equal(log.length, 0);
  }
});

test('shQuote survives single quotes', () => {
  assert.equal(shQuote("git log -1 --format='%h'"), `'git log -1 --format='\\''%h'\\'''`);
});

test('the rc file logs every exit status and uses pipefail', () => {
  const rc = bashRc();
  assert.match(rc, /PROMPT_COMMAND='echo \$\? >> \/tmp\/ramtask\/exits'/);
  assert.match(rc, /set -o pipefail/);
  assert.match(waitForExitsCommand(3, 10, 1), /-ge 3\b/);
});

test('opens a terminal, types each command into it and waits for each to finish', async () => {
  const { sbx, log, state } = fakeDesktop();
  const seen = [];
  const res = await runWorkbenchTask(sbx, r31(), { onStep: (s) => seen.push(s) });
  assert.equal(res.ok, true);
  assert.deepEqual(state.ran, workbenchSteps(r31()).map((s) => s.command));
  assert.deepEqual(seen.map((s) => [s.id, s.exitCode]), [['clone', 0], ['head', 0], ['task', 0], ['cd', 0], ['claim', 0], ['check', 0]]);
  // the terminal is launched in the background with the rc file, titled for the track
  const launch = log.find((l) => l.cmd.startsWith('xfce4-terminal'));
  assert.match(launch.cmd, /--rcfile \/tmp\/ramtask\/bashrc/);
  assert.match(launch.cmd, /-T 'RAM workbench - sha256-r31-exploratory'/);
  assert.equal(launch.opts.background, true);
  // every type is preceded by activating the terminal window
  const kinds = log.map((l) => l.cmd.split(' ').slice(0, 2).join(' ')).filter((k) => k === 'xdotool windowactivate' || k === 'xdotool type');
  assert.deepEqual(kinds, Array(6).fill(['xdotool windowactivate', 'xdotool type']).flat());
  // results are read back from real state, not from what was typed
  assert.deepEqual(res.repo, { head: HEAD, origin: HASHSMASH_REPO_URL });
  assert.deepEqual(res.claim, {
    targetProfile: 'sha256-r31-prefix-v1', attackClass: 'ordinary-collision', submissionState: 'ready',
    timeLog2: 136, memoryLog2Bytes: 138, successProbability: 0.6,
  });
  assert.deepEqual(res.check, { status: 'mechanically_valid', qualified: false });
});

test('a failing clone stops the sequence and reports which step failed', async () => {
  const { sbx, state } = fakeDesktop({ exitFor: (line) => (line.startsWith('git clone') ? 128 : 0) });
  const res = await runWorkbenchTask(sbx, r31());
  assert.equal(res.ok, false);
  assert.equal(res.failedStep, 'clone');
  assert.equal(state.ran.length, 1);
});

test('a non-zero organizer check is a verdict, not a task failure', async () => {
  const { sbx } = fakeDesktop({ exitFor: (line) => (line.includes('local_tracks.py') ? 1 : 0), check: [{ track: 'sha256-r31-exploratory', status: 'invalid' }] });
  const res = await runWorkbenchTask(sbx, r31());
  assert.equal(res.ok, true);
  assert.equal(res.steps.at(-1).exitCode, 1);
  assert.equal(res.check.status, 'invalid');
});

test('no terminal window -> error, nothing typed', async () => {
  const { sbx, state } = fakeDesktop({ noWindow: true });
  await assert.rejects(runWorkbenchTask(sbx, r31()), /terminal window did not appear/);
  assert.equal(state.ran.length, 0);
});

test('a command that never finishes -> error naming it', async () => {
  const { sbx } = fakeDesktop({ hangOn: 'cat claim.json' });
  await assert.rejects(runWorkbenchTask(sbx, r31()), /did not finish.*cat claim\.json/);
});

test('stops typing once the sandbox is no longer live', async () => {
  const { sbx, state } = fakeDesktop();
  let n = 0;
  await assert.rejects(runWorkbenchTask(sbx, r31(), { isLive: () => n++ < 2 }), /sandbox stopped/);
  assert.equal(state.ran.length, 2);
});

// ---- wired into the slot manager through the real sandbox manager ----

function fakeSdkWithDesktop(desktopOpts) {
  const desks = [];
  class Sandbox {
    static async create() {
      const d = fakeDesktop(desktopOpts);
      const sbx = d.sbx;
      const base = sbx.commands.run;
      let x11 = [];
      sbx.sandboxId = `sbx${desks.length + 1}`;
      sbx.display = ':0';
      sbx.getHost = (p) => `${p}-${sbx.sandboxId}.e2b.app`;
      sbx.kill = async () => true;
      sbx.commands = {
        run: async (cmd, opts) => {
          if (cmd.startsWith('x11vnc -bg')) { x11.push(cmd); return { exitCode: 0, stdout: '', stderr: '' }; }
          if (cmd.startsWith('pkill -x x11vnc')) { x11 = []; return { exitCode: 0, stdout: '', stderr: '' }; }
          if (cmd.startsWith('ps -C x11vnc')) return { exitCode: 0, stdout: `${x11.join('\n')}\n`, stderr: '' };
          return base(cmd, opts);
        },
      };
      desks.push(d);
      return sbx;
    }
    static async kill() { return true; }
  }
  return { desks, loadSdk: async () => ({ Sandbox }) };
}

function slotsWithTask(sdk) {
  const sandboxManager = createSandboxManager({ apiKey: 'e2b_fakekeyfortests0123456789', loadSdk: sdk.loadSdk });
  return createSlotManager({ llmProvider: createMockLlmProvider(), sandboxManager, sandboxTask: runWorkbenchTask });
}

test('startSandbox runs the task in the background and logs each typed command to the feed', async () => {
  const sdk = fakeSdkWithDesktop();
  const m = slotsWithTask(sdk);
  m.setSlotCount(1);
  const id = m.getSlots()[0].id;
  const snap = await m.startSandbox(id);
  assert.equal(snap.feed.at(-1).type, 'sandbox-started'); // returns before the task
  await m.waitForSandboxTask(id);
  const feed = m.getSlot(id).feed;
  const types = feed.map((f) => f.type);
  assert.deepEqual(types.slice(types.indexOf('sandbox-started') + 1), [
    'sandbox-task-started', ...Array(6).fill('sandbox-task-step'), 'sandbox-task-done',
  ]);
  assert.match(feed.find((f) => f.type === 'sandbox-task-step').message, /git clone --depth 1 https:\/\/github\.com\/Layr-Labs\/hash-smash/);
  const done = feed.at(-1).message;
  assert.match(done, /86f1102ff2d6/);
  assert.match(done, /ordinary-collision, time 2\^136/);
  assert.match(done, /organizer check: mechanically_valid/);
  assert.equal(sdk.desks[0].state.ran.length, 6);
});

test('a task failure lands in the feed and never fails the start', async () => {
  const sdk = fakeSdkWithDesktop({ noWindow: true });
  const m = slotsWithTask(sdk);
  m.setSlotCount(1);
  const id = m.getSlots()[0].id;
  const snap = await m.startSandbox(id);
  assert.equal(snap.sandbox.status, 'running');
  await m.waitForSandboxTask(id);
  assert.equal(m.getSlot(id).feed.at(-1).type, 'sandbox-task-error');
  assert.match(m.getSlot(id).feed.at(-1).message, /terminal window did not appear/);
});

test('without sandboxTask, starting a sandbox types nothing (opt-in wiring)', async () => {
  const sdk = fakeSdkWithDesktop();
  const sandboxManager = createSandboxManager({ apiKey: 'e2b_fakekeyfortests0123456789', loadSdk: sdk.loadSdk });
  const m = createSlotManager({ llmProvider: createMockLlmProvider(), sandboxManager });
  m.setSlotCount(1);
  const id = m.getSlots()[0].id;
  await m.startSandbox(id);
  await m.waitForSandboxTask(id);
  assert.equal(sdk.desks[0].state.launched, false);
  assert.equal(m.getSlot(id).feed.at(-1).type, 'sandbox-started');
});
