// The always-on research loop (server/lib/slots.js "Active loop") and its
// desktop side (server/lib/sandbox-activity.js). FAKE SDK, FAKE timers, FAKE
// LLM and a fake desktop: no real sandbox, no real model call, no real time.
// The real-E2B + real-model proof is scripts/prove-active-loop.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createSandboxManager, sandboxPolicy } from '../server/lib/sandbox.js';
import { createSlotManager, LOOP_THINKING_SYSTEM, LOOP_DRAFT_SYSTEM, LOOP_VERIFY_SYSTEM, emptyReplyNote } from '../server/lib/slots.js';
import { createMockLlmProvider } from '../server/lib/llm.js';
import { createStore } from '../server/store.js';
import { loadConfig } from '../server/config.js';
import {
  parseThinking, parseDraftAttempt, asciiText, noteBlock, eprintSearchUrl, notesFile, ensureNotepad, typeIntoNotepad,
  repoInspectSteps, researchTerminalTitle, ensureResearchTerminal, inspectRepoFile,
  peerSubmissionsUrl, peerSubmissionsCommand, parsePeerSubmissions, browsePeerSubmissions, PARSE_PEERS_PY,
  MAX_IDLE_MS, MAX_TYPED_CHARS, MAX_PEER_RESULTS, HASHSMASH_GITHUB_REPO,
  eprintIdFrom, eprintPaperUrl, parseEprintPaperPage, paperPageCommand, readPaper, desktopActivity,
  LOOP_THINKING_MAX_TOKENS, LOOP_DRAFT_MAX_TOKENS, LOOP_VERIFY_MAX_TOKENS, LOOP_REASONING,
} from '../server/lib/sandbox-activity.js';
import { readFileSync } from 'node:fs';
import { realResearchTools, runExperiment, parseExperimentRequest } from '../server/lib/research-tools.js';
import { digestForTrack } from '../server/lib/reduced-hashes.js';
import { ACTIVE_TRACKS } from '../server/lib/targets.js';

const FAKE_KEY = 'e2b_fakekeyfortests0123456789';
/** Real IACR ePrint pages, recorded 2026-10-07 (see the comment at the top of each file). */
const EPRINT_1080_HTML = readFileSync(new URL('./helpers/eprint-2026-1080.html', import.meta.url), 'utf8');
const EPRINT_404_HTML = readFileSync(new URL('./helpers/eprint-404.html', import.meta.url), 'utf8');

function fakeSdk() {
  const gone = new Set();
  let seq = 0;
  class Sandbox {
    constructor(id) {
      this.sandboxId = id;
      this.x11vnc = [];
      this.commands = {
        run: async (cmd) => {
          if (cmd.startsWith('x11vnc -bg')) this.x11vnc.push(cmd);
          if (cmd.startsWith('ps -C x11vnc')) return { exitCode: 0, stdout: this.x11vnc.join('\n') + '\n', stderr: '' };
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      };
    }
    getHost(port) { return `${port}-${this.sandboxId}.e2b.app`; }
    async kill() { return true; }
    static async getInfo(id) {
      if (gone.has(id)) { const e = new Error(`Sandbox ${id} not found`); e.name = 'SandboxNotFoundError'; throw e; }
      return { sandboxId: id, state: 'running' };
    }
    static async create() { return new Sandbox(`sbx${++seq}`); }
    static async kill() { return true; }
  }
  return { loadSdk: async () => ({ Sandbox }), vanish: (id) => gone.add(id) };
}

function fakeTimers() {
  const pending = new Map();
  let n = 0;
  return {
    pending,
    setTimer: (fn, ms) => { const h = { id: ++n, fn, ms }; pending.set(h.id, h); return h; },
    clearTimer: (h) => { pending.delete(h.id); h.cleared = true; },
    fire() {
      assert.equal(pending.size, 1, `expected exactly one pending timer, found ${pending.size}`);
      const [h] = pending.values();
      pending.delete(h.id);
      h.fn();
      return h.ms;
    },
  };
}

/** A live-looking provider (mocked: false) whose answers the test controls. */
function fakeLiveLlm(answers = []) {
  const calls = [];
  return {
    calls,
    provider: {
      kind: 'openrouter',
      async complete(req) {
        calls.push(req);
        const text = answers.length ? answers.shift() : `Plan step ${calls.length}: try a tighter message-modification pass.`;
        if (text instanceof Error) throw text;
        return { text, mocked: false, model: req.model, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.001 } };
      },
    },
  };
}

/** Fake desktop activity: records what would be typed / browsed / inspected / peer-reviewed. */
function fakeActivity({
  failType = 0, results = [{ id: '2026/1120', title: 'Pushing Collision Attacks on SHA-2 to 39 Steps' }],
  peerResults = [{ number: 302, login: 'rickmanelius', title: 'Validate submission 7e5d9c2a-...', claimedScore: '1.5', note: 'claimed score: 1.5', url: 'https://github.com/Layr-Labs/hash-smash/pull/302' }],
} = {}) {
  const typed = [];
  const browsed = [];
  const inspected = [];
  const peered = [];
  const reads = [];
  const state = { failType };
  return {
    typed,
    browsed,
    inspected,
    peered,
    reads,
    state,
    activity: {
      ensureNotepad: async (sbx, { windowId }) => windowId ?? `win-${sbx.sandboxId}`,
      typeIntoNotepad: async (sbx, { block }) => {
        if (state.failType > 0) { state.failType -= 1; throw new Error('xdotool: cannot open display'); }
        typed.push({ sbx: sbx.sandboxId, block });
        return { verified: true };
      },
      browseLiterature: async (sbx, { query }) => { browsed.push({ sbx: sbx.sandboxId, query }); return { windowId: 'chrome1', url: eprintSearchUrl(query), pageTitle: 'Search results', results }; },
      inspectRepoFile: async (sbx, { windowId, index }) => {
        const labels = ['commit history', 'candidate directory', 'claim.json', 'proof.md', 'TASK.md'];
        const entry = { sbx: sbx.sandboxId, index, label: labels[index % labels.length] };
        inspected.push(entry);
        return { windowId: windowId ?? `term-${sbx.sandboxId}`, label: entry.label, command: `cat ${entry.label}`, output: `real output for ${entry.label}` };
      },
      browsePeerSubmissions: async (sbx, { assignment, windowId }) => {
        peered.push({ sbx: sbx.sandboxId, track: assignment.track });
        return { windowId: windowId ?? `term-${sbx.sandboxId}`, url: peerSubmissionsUrl(), track: assignment.track, results: peerResults };
      },
      // Real parsing of the recorded real ePrint pages: 2026/1080 is a real paper, anything else is the archive's real 404 page.
      readPaper: async (sbx, { id, windowId }) => {
        reads.push({ sbx: sbx.sandboxId, id });
        const html = id === '2026/1080' ? EPRINT_1080_HTML : EPRINT_404_HTML;
        return { windowId: windowId ?? 'chrome1', url: eprintPaperUrl(id), paper: parseEprintPaperPage(html, id) };
      },
    },
  };
}

const HARD_STOP_MS = 60_000;

function rig({ live = true, answers, activeLoop = {}, activity = fakeActivity(), pipelineRunner = null, llm, researchTools = null } = {}) {
  const sdk = fakeSdk();
  const clock = { t: 1_000_000 };
  const mgr = createSandboxManager({ apiKey: FAKE_KEY, loadSdk: sdk.loadSdk, timeoutMs: HARD_STOP_MS, reconcileMs: 0, now: () => clock.t });
  const timers = fakeTimers();
  const model = llm ?? fakeLiveLlm(answers);
  const m = createSlotManager({
    llmProvider: model.provider, sandboxManager: mgr, pipelineRunner,
    sandboxTask: async () => ({ ok: true, repo: null, claim: null, check: null }),
    sandboxContext: { start: async () => {}, update: async () => {} },
    sandboxActivity: activity.activity,
    researchTools,
    activeLoop: { enabled: true, live, ...activeLoop },
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  /** Fires the loop's one pending timer and waits for that step to finish. */
  async function step(id = 'slot-0') {
    const ms = timers.fire();
    await m.waitForLoopStep(id);
    return ms;
  }
  async function boot(id = 'slot-0') {
    await m.startSandbox(id);
    await m.waitForSandboxTask(id);
  }
  return { sdk, mgr, m, timers, clock, llm: model, activity, step, boot };
}

const types = (snap) => snap.feed.map((f) => f.type);

// ---- pure helpers ----

test('parseThinking takes the model\'s last SEARCH line out of the note and sanitizes it', () => {
  assert.deepEqual(parseThinking('I will re-derive the 31-step characteristic.\nSEARCH: SHA-256 "31-step" collision; rm -rf /'), {
    note: 'I will re-derive the 31-step characteristic.', search: 'SHA-256 31-step collision rm -rf', peersReason: null, draftReason: null, experiment: null, verify: null, read: null,
  });
  assert.deepEqual(parseThinking('Just a plan.'), { note: 'Just a plan.', search: null, peersReason: null, draftReason: null, experiment: null, verify: null, read: null });
  assert.equal(parseThinking('x\n**SEARCH:** ab').search, null, 'too short after sanitizing');
  assert.equal(parseThinking(`x\nsearch: ${'a'.repeat(200)}`).search.length, 80);
});

test('parseThinking takes the model\'s DRAFT line out of the note too, independently of SEARCH', () => {
  assert.deepEqual(parseThinking('I will try X next.\nDRAFT: I found a specific disclosed heuristic.'), {
    note: 'I will try X next.', search: null, peersReason: null, draftReason: 'I found a specific disclosed heuristic.', experiment: null, verify: null, read: null,
  });
  // Both lines can appear in the same step and are extracted independently.
  assert.deepEqual(
    parseThinking('Plan.\nSEARCH: some query\nDRAFT: a real reason here'),
    { note: 'Plan.', search: 'some query', peersReason: null, draftReason: 'a real reason here', experiment: null, verify: null, read: null },
  );
  assert.equal(parseThinking('x\nDRAFT: hi').draftReason, null, 'too short after trimming');
  assert.equal(parseThinking('No draft line here.').draftReason, null);
});

test('parseThinking takes the model\'s PEERS line out of the note too, independently of SEARCH and DRAFT', () => {
  assert.deepEqual(parseThinking('I will check the field.\nPEERS: see what others on this track found.'), {
    note: 'I will check the field.', search: null, peersReason: 'see what others on this track found.', draftReason: null, experiment: null, verify: null, read: null,
  });
  // All three lines can appear in the same step and are extracted independently.
  assert.deepEqual(
    parseThinking('Plan.\nSEARCH: some query\nPEERS: a real reason\nDRAFT: a real reason here'),
    { note: 'Plan.', search: 'some query', peersReason: 'a real reason', draftReason: 'a real reason here', experiment: null, verify: null, read: null },
  );
  assert.equal(parseThinking('x\nPEERS: hi').peersReason, null, 'too short after trimming');
  assert.equal(parseThinking('No peers line here.').peersReason, null);
});

test('parseDraftAttempt: "ATTEMPT: no" (in any casing/order) is a clean decline, never a guess', () => {
  assert.deepEqual(parseDraftAttempt('ATTEMPT: no'), { attempt: false });
  assert.deepEqual(parseDraftAttempt('attempt: No, I do not have anything real.'), { attempt: false });
  assert.deepEqual(parseDraftAttempt(''), { attempt: false });
  assert.deepEqual(parseDraftAttempt('TIME_LOG2: 80'), { attempt: false }, 'no ATTEMPT line at all is a decline, not a guess');
});

test('parseDraftAttempt: a well-formed "ATTEMPT: yes" answer is parsed field by field', () => {
  const text = [
    'ATTEMPT: yes',
    'TIME_LOG2: 90.5',
    'MEMORY_LOG2_BYTES: 40',
    'SUCCESS_PROBABILITY: 0.6',
    'HEURISTIC_ID: loop-heuristic-1',
    'CITED_PAPER_ID: 2026/1234',
    'STATEMENT: A specific disclosed statement about the construction.',
    'SCOPE: Exactly the construction and parameters this applies to.',
    'EXTRAPOLATION: What was actually measured this session and how far this extends it.',
    'LIMITATIONS: No collision was found; this is an estimate under one premise.',
  ].join('\n');
  assert.deepEqual(parseDraftAttempt(text), {
    attempt: true,
    timeLog2: 90.5,
    memoryLog2Bytes: 40,
    successProbability: 0.6,
    heuristicId: 'loop-heuristic-1',
    citedPaperId: '2026/1234',
    experimentId: null,
    statement: 'A specific disclosed statement about the construction.',
    scope: 'Exactly the construction and parameters this applies to.',
    extrapolation: 'What was actually measured this session and how far this extends it.',
    limitations: 'No collision was found; this is an estimate under one premise.',
  });
});

test('parseDraftAttempt: a missing numeric field becomes null, never a silent 0', () => {
  const attempt = parseDraftAttempt('ATTEMPT: yes\nHEURISTIC_ID: x\nCITED_PAPER_ID: 2026/1\nSTATEMENT: s\nSCOPE: sc\nEXTRAPOLATION: e\nLIMITATIONS: l');
  assert.equal(attempt.timeLog2, null);
  assert.equal(attempt.memoryLog2Bytes, null);
  assert.equal(attempt.successProbability, null);
});

test('asciiText, noteBlock and the ePrint URL produce plain, bounded, typeable text', () => {
  assert.equal(asciiText('time \u2248 2^86 \u2014 \u201cok\u201d \u{1F600}'), 'time ~ 2^86 - "ok"');
  const block = noteBlock({ ts: '2026-10-05T21:15:02.000Z', statusBefore: 'idle', statusAfter: 'thinking', entries: [{ message: 'a'.repeat(5000) }] });
  assert.match(block, /^\n\[21:15:02 UTC\] idle -> thinking\n/);
  assert.ok(block.length < MAX_TYPED_CHARS + 60);
  assert.equal(eprintSearchUrl('SHA-256 31 step'), 'https://eprint.iacr.org/search?q=SHA-256+31+step');
  assert.equal(notesFile(ACTIVE_TRACKS[0]), '/tmp/ramnotes/ram-notes-sha256-r31.txt');
});

test('typeIntoNotepad types the block into the editor window, saves, and verifies the saved file', async () => {
  const cmds = [];
  let file = 'header\n';
  const sbx = { commands: { run: async (cmd) => {
    cmds.push(cmd);
    if (cmd.startsWith('true')) {
      for (const part of cmd.split(' && ')) {
        if (part === 'xdotool key Return') file += '\n';
        const m = /^xdotool type --delay \d+ -- '(.*)'$/.exec(part);
        if (m) file += m[1].replace(/'\\''/g, "'");
      }
    }
    if (cmd.startsWith('tail -c')) return { stdout: file };
    return { stdout: '' };
  } } };
  const block = noteBlock({ ts: '2026-10-05T21:15:02Z', statusBefore: 'idle', statusAfter: 'thinking', entries: [{ message: "It's next: re-check the boomerang." }] });
  const r = await typeIntoNotepad(sbx, { assignment: ACTIVE_TRACKS[0], windowId: '42', block });
  assert.equal(r.verified, true);
  assert.match(cmds[0], /^xdotool windowactivate --sync 42/);
  assert.ok(cmds.some((c) => c.includes('ctrl+s')));
  file = 'header\n'; // the save did not land
  const sbx2 = { commands: { run: async (cmd) => (cmd.startsWith('tail -c') ? { stdout: 'header\n' } : { stdout: '' }) } };
  assert.equal((await typeIntoNotepad(sbx2, { assignment: ACTIVE_TRACKS[0], windowId: '42', block })).verified, false);
});

test('ensureNotepad launches Mousepad on the notes file and refuses when no window appears', async () => {
  const cmds = [];
  const sbx = (win) => ({ commands: { run: async (cmd) => { cmds.push(cmd); if (cmd.includes('xdotool search')) return { stdout: win }; if (cmd.startsWith('xprop')) return { stdout: '0,94,1280,676' }; return { stdout: '' }; } } });
  assert.equal(await ensureNotepad(sbx('777\n'), { assignment: ACTIVE_TRACKS[0] }), '777');
  assert.ok(cmds.some((c) => c === 'mousepad --disable-server /tmp/ramnotes/ram-notes-sha256-r31.txt'));
  assert.ok(cmds.some((c) => c.startsWith('xdotool windowmove 777 0 94 windowsize 777 1280')));
  await assert.rejects(ensureNotepad(sbx(''), { assignment: ACTIVE_TRACKS[0] }), /did not appear/);
});

test('repoInspectSteps lists real, honest commands against the RAM\'s own cloned candidate files, cycled', () => {
  const steps = repoInspectSteps(ACTIVE_TRACKS[0]);
  assert.equal(steps.length, 5);
  assert.equal(steps[0].command, 'cd ~/hash-smash && git log --oneline -8');
  assert.equal(steps[2].command, "cat ~/hash-smash/lanes/exploratory/candidates/sha256-r31/claim.json 2>/dev/null || echo 'claim.json not in this clone yet'");
  assert.equal(researchTerminalTitle('sha256-r31-exploratory'), 'RAM research terminal - sha256-r31-exploratory');
});

test('ensureResearchTerminal opens xfce4-terminal and refuses when no window appears', async () => {
  const cmds = [];
  const sbx = (win) => ({ commands: { run: async (cmd) => { cmds.push(cmd); if (cmd.includes('xdotool search')) return { stdout: win }; if (cmd.startsWith('xprop')) return { stdout: '0,94,1280,676' }; return { stdout: '' }; } } });
  const id = await ensureResearchTerminal(sbx('555\n'), { assignment: ACTIVE_TRACKS[0] });
  assert.equal(id, '555');
  assert.ok(cmds.some((c) => c.startsWith('xfce4-terminal --disable-server --maximize --hide-menubar -T')));
  assert.ok(cmds.some((c) => c.startsWith('xdotool windowmove 555 0 94 windowsize 555 1280')));
  await assert.rejects(ensureResearchTerminal(sbx(''), { assignment: ACTIVE_TRACKS[0] }), /did not appear/);
});

test('inspectRepoFile types the cycled command live and reads back its real output', async () => {
  const cmds = [];
  const sbx = { commands: { run: async (cmd) => {
    cmds.push(cmd);
    if (cmd.includes('xdotool search')) return { stdout: '42\n' };
    if (cmd.startsWith('xprop')) return { stdout: '0,0,1280,720' };
    if (cmd === 'cd ~/hash-smash && git log --oneline -8') return { stdout: 'abc123 fix something\n' };
    return { stdout: '' };
  } } };
  const r = await inspectRepoFile(sbx, { assignment: ACTIVE_TRACKS[0], index: 0 });
  assert.equal(r.windowId, '42');
  assert.equal(r.label, "the cloned repo's recent commit history");
  assert.equal(r.output, 'abc123 fix something');
  assert.ok(cmds.some((c) => c.startsWith('xdotool windowactivate --sync 42')));
  assert.ok(cmds.some((c) => c.includes("xdotool type --delay 20 -- 'cd ~/hash-smash && git log --oneline -8'")));
  // A different index cycles to a different, still real command, never the same thing twice in a row.
  const r2 = await inspectRepoFile(sbx, { assignment: ACTIVE_TRACKS[0], windowId: '42', index: 1 });
  assert.notEqual(r2.label, r.label);
});

// ---------------------------------------------------------------------------
// PEERS: a real, read-only, unauthenticated GitHub API lookup of OTHER
// COMPETITORS' own open pull requests on the real HashSmash repository,
// filtered to this RAM's own track. Same shape and the same "typed, then
// independently verified" discipline as browseLiterature/inspectRepoFile.
// No real network call anywhere in these tests: PARSE_PEERS_PY is still a
// real python3 subprocess (same as hashsmash.test.js's real-python
// philosophy), but its input is a fake, locally-built GitHub API response —
// never fetched over the wire.
// ---------------------------------------------------------------------------

function pythonOk() {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const PY_SKIP = pythonOk() ? false : 'python3 not available';

/** A realistic GitHub `pulls?state=open` response shape, built locally (never fetched). */
const FAKE_PR_LIST = [
  {
    number: 302, title: 'Validate submission 7e5d9c2a-...', user: { login: 'rickmanelius' },
    body: 'Track: blake3-r1-exploratory\nclaimed score: 1.5\nCurrent best score: 149\nModel: Claude Opus 5.5, Harness: Claude Code.',
    html_url: 'https://github.com/Layr-Labs/hash-smash/pull/302',
  },
  {
    number: 288, title: 'Validate submission 1a2b3c4d-...', user: { login: 'someone-else' },
    body: 'Track: blake3-r1-exploratory\nA second attempt, no score line stated this time.',
    html_url: 'https://github.com/Layr-Labs/hash-smash/pull/288',
  },
  // Not this track: must be filtered out.
  { number: 275, title: 'Validate submission aaaa-...', user: { login: 'nope' }, body: 'Track: sha3-256-r5-exploratory\nclaimed score: 9', html_url: 'https://x/275' },
  // Malformed/missing user: must not throw, and still usable with login null.
  { number: 260, title: 'blake3-r1-exploratory attempt, no user object', body: 'claimed score: 0.7', html_url: 'https://x/260' },
];

function runPeersPython(prList, track) {
  const out = execFileSync('python3', ['-c', PARSE_PEERS_PY, track], { input: JSON.stringify(prList), encoding: 'utf8' });
  return parsePeerSubmissions(out);
}

test('peerSubmissionsUrl points at the real, public, official HashSmash repo\'s open PRs, unauthenticated', () => {
  const url = peerSubmissionsUrl();
  assert.match(url, new RegExp(`^https://api\\.github\\.com/repos/${HASHSMASH_GITHUB_REPO.replace('/', '\\/')}/pulls\\?`));
  assert.match(url, /state=open/);
});

test('PARSE_PEERS_PY (real python3): filters to the real track, surfaces real fields, caps at MAX_PEER_RESULTS, never throws on odd shapes', { skip: PY_SKIP }, () => {
  const results = runPeersPython(FAKE_PR_LIST, 'blake3-r1-exploratory');
  assert.equal(results.length, 3, 'only the 3 PRs that actually mention this track');
  assert.deepEqual(results[0], {
    number: 302, login: 'rickmanelius', title: 'Validate submission 7e5d9c2a-...', claimedScore: '1.5',
    note: results[0].note, url: 'https://github.com/Layr-Labs/hash-smash/pull/302',
  });
  assert.match(results[0].note, /claimed score: 1\.5/);
  assert.equal(results[1].claimedScore, null, 'no score line stated: null, never guessed');
  assert.equal(results[2].login, null, 'a PR with no user object: login is null, never thrown on');
  assert.equal(results[2].claimedScore, '0.7');
  // Off-track PR (sha3-256-r5-exploratory) is never included.
  assert.ok(!results.some((r) => r.number === 275));
});

test('PARSE_PEERS_PY (real python3): an honest empty list when nothing currently open matches this track', { skip: PY_SKIP }, () => {
  assert.deepEqual(runPeersPython(FAKE_PR_LIST, 'sha256-r32-exploratory'), []);
  assert.deepEqual(runPeersPython([], 'blake3-r1-exploratory'), []);
});

test('PARSE_PEERS_PY (real python3): garbage/non-JSON input is an honest empty list, never a crash or a fabricated row', { skip: PY_SKIP }, () => {
  const out = execFileSync('python3', ['-c', PARSE_PEERS_PY, 'blake3-r1-exploratory'], { input: 'not json at all', encoding: 'utf8' });
  assert.deepEqual(parsePeerSubmissions(out), []);
});

test('parsePeerSubmissions: malformed/garbled stdout is an honest [], never a throw', () => {
  assert.deepEqual(parsePeerSubmissions(''), []);
  assert.deepEqual(parsePeerSubmissions('not json'), []);
  assert.deepEqual(parsePeerSubmissions('{"not":"an array"}'), []);
  assert.deepEqual(parsePeerSubmissions('[{"number":"not-an-int","title":"x"}]'), [], 'a non-integer number is dropped, not coerced');
  assert.deepEqual(parsePeerSubmissions('[{"number":1}]'), [], 'missing title is dropped');
});

test('peerSubmissionsCommand types the real curl+python one-liner, with the track safely quoted', () => {
  const cmd = peerSubmissionsCommand('blake3-r1-exploratory');
  assert.match(cmd, /^curl -sS -m 20 /);
  assert.match(cmd, /api\.github\.com\/repos\/Layr-Labs\/hash-smash\/pulls/);
  assert.match(cmd, /\| python3 -c /);
  assert.ok(cmd.includes("'blake3-r1-exploratory'"), 'the track is passed as a single quoted argv, never interpolated unsafely');
});

test('browsePeerSubmissions types the real command into the (shared) research terminal, then independently re-runs it for the real output', async () => {
  const cmds = [];
  const canned = JSON.stringify(FAKE_PR_LIST);
  const sbx = { commands: { run: async (cmd) => {
    cmds.push(cmd);
    if (cmd.includes('xdotool search')) return { stdout: '99\n' };
    if (cmd.startsWith('xprop')) return { stdout: '0,0,1280,720' };
    if (cmd === peerSubmissionsCommand('blake3-r1-exploratory')) {
      return { stdout: execFileSync('python3', ['-c', PARSE_PEERS_PY, 'blake3-r1-exploratory'], { input: canned, encoding: 'utf8' }) };
    }
    return { stdout: '' };
  } } };
  const assignment = ACTIVE_TRACKS.find((t) => t.track === 'blake3-r1-exploratory');
  const r = await browsePeerSubmissions(sbx, { assignment });
  assert.equal(r.windowId, '99');
  assert.equal(r.track, 'blake3-r1-exploratory');
  assert.equal(r.url, peerSubmissionsUrl());
  assert.equal(r.results.length, 3);
  assert.equal(r.results[0].number, 302);
  assert.ok(cmds.some((c) => c.startsWith('xdotool windowactivate --sync 99')));
  assert.ok(cmds.some((c) => c.includes('xdotool type --delay 20')));
  // What was typed and what was independently re-run are the exact same real command.
  assert.ok(cmds.filter((c) => c === peerSubmissionsCommand('blake3-r1-exploratory')).length >= 1);
});

test('browsePeerSubmissions is honest when nothing currently open matches the track: an empty results list, not a guess', async () => {
  const sbx = { commands: { run: async (cmd) => {
    if (cmd.includes('xdotool search')) return { stdout: '7\n' };
    if (cmd.startsWith('xprop')) return { stdout: '0,0,1280,720' };
    if (cmd === peerSubmissionsCommand('sha256-r31-exploratory')) return { stdout: '[]' };
    return { stdout: '' };
  } } };
  const r = await browsePeerSubmissions(sbx, { assignment: ACTIVE_TRACKS[0] });
  assert.deepEqual(r.results, []);
});

// ---- policy / wiring ----

test('the loop is off by default and needs RAMHERD_SANDBOX=e2b plus exactly RAMHERD_SANDBOX_ACTIVE_LOOP=true; the pause is clamped', () => {
  assert.equal(sandboxPolicy({}).activeLoop, false);
  assert.equal(sandboxPolicy({ RAMHERD_SANDBOX: 'e2b', RAMHERD_SANDBOX_ACTIVE_LOOP: '1' }).activeLoop, false);
  assert.equal(sandboxPolicy({ RAMHERD_SANDBOX_ACTIVE_LOOP: 'true' }).activeLoop, false);
  const on = sandboxPolicy({ RAMHERD_SANDBOX: 'e2b', RAMHERD_SANDBOX_ACTIVE_LOOP: 'true' });
  assert.equal(on.activeLoop, true);
  assert.equal(on.activeLoopStepPauseMs, 5_000);
  assert.equal(on.activeLoopMaxThinking, 60);
  assert.equal(sandboxPolicy({ RAMHERD_SANDBOX: 'e2b', RAMHERD_SANDBOX_ACTIVE_LOOP_PAUSE_SEC: '1' }).activeLoopStepPauseMs, 5_000, 'below the floor falls back');
  assert.equal(sandboxPolicy({ RAMHERD_SANDBOX: 'e2b', RAMHERD_SANDBOX_ACTIVE_LOOP_PAUSE_SEC: '90' }).activeLoopStepPauseMs, 5_000, 'over the ceiling falls back');
  assert.equal(sandboxPolicy({ RAMHERD_SANDBOX: 'e2b', RAMHERD_SANDBOX_ACTIVE_LOOP_PAUSE_SEC: '12' }).activeLoopStepPauseMs, 12_000);
});

test('store: no loop without the flag; with the flag but mock LLM it is configured but not live', () => {
  const budgetConfig = loadConfig({}, {}).budget;
  const off = createStore({ budgetConfig, env: { RAMHERD_SANDBOX: 'e2b', E2B_API_KEY: FAKE_KEY }, loadSandboxSdk: fakeSdk().loadSdk });
  assert.equal(off.slotManager.activeLoopStatus().configured, false);
  const mock = createStore({ budgetConfig, env: { RAMHERD_SANDBOX: 'e2b', E2B_API_KEY: FAKE_KEY, RAMHERD_SANDBOX_ACTIVE_LOOP: 'true' }, loadSandboxSdk: fakeSdk().loadSdk });
  assert.deepEqual([mock.slotManager.activeLoopStatus().configured, mock.slotManager.activeLoopStatus().live], [true, false]);
  const live = createStore({ budgetConfig, env: { RAMHERD_SANDBOX: 'e2b', E2B_API_KEY: FAKE_KEY, RAMHERD_SANDBOX_ACTIVE_LOOP: 'true', RAMHERD_LIVE: 'true', OPENROUTER_API_KEY: 'sk-or-fake' }, loadSandboxSdk: fakeSdk().loadSdk });
  assert.equal(live.slotManager.activeLoopStatus().live, true);
  // The real research tools ride with the loop: wired whenever it is, never otherwise.
  assert.equal(live.slotManager.activeLoopStatus().researchToolsConfigured, true);
  assert.equal(off.slotManager.activeLoopStatus().researchToolsConfigured, false);
});

// ---- the loop drives the REAL status, and the desktop types the same feed lines ----

test('after the workbench, the loop advances the real status back to back, forever, typing each step\'s own feed line', async () => {
  const r = rig();
  r.m.setSlotCount(1);
  await r.boot();
  assert.equal(r.m.getSlot('slot-0').feed.at(-1).type, 'sandbox-loop-started');
  const statuses = [];
  const delays = [];
  for (let i = 0; i < 9; i++) {
    delays.push(await r.step());
    statuses.push(r.m.getSlot('slot-0').status);
  }
  assert.deepEqual(statuses, ['thinking', 'running-experiment', 'failed', 'idle', 'thinking', 'running-experiment', 'failed', 'idle', 'thinking']);
  assert.equal(delays[0], 0, 'first step right after the workbench');
  assert.ok(delays.slice(1).every((d) => d === 5_000 && d < MAX_IDLE_MS));
  assert.equal(r.timers.pending.size, 1, 'and the next step is already scheduled');
  // What is typed is exactly the feed line each advance pushed.
  const feed = r.m.getSlot('slot-0').feed;
  assert.equal(r.activity.typed.length, 9);
  const thinking = feed.filter((f) => f.type === 'thinking');
  assert.ok(r.activity.typed[0].block.includes('idle -> thinking'));
  assert.ok(r.activity.typed[0].block.includes(thinking[0].message));
  assert.ok(r.activity.typed[1].block.includes('thinking -> running-experiment'));
  // Honest on a track with no runner: no "drafted", says nothing ran.
  const fail = feed.find((f) => f.type === 'failed');
  assert.match(fail.message, /No experiment ran .* no real runner/);
  assert.equal(feed.some((f) => /drafted for/.test(f.message)), false);
  // Thinking calls are grounded: loop system prompt + real recent history + the running best-so-far.
  assert.equal(r.llm.calls.length, 3);
  assert.equal(r.llm.calls[1].system, LOOP_THINKING_SYSTEM);
  assert.match(r.llm.calls[1].prompt, /Target: SHA-256 reduced to 31 rounds/);
  assert.match(r.llm.calls[1].prompt, /recent activity, newest last: .*\[thinking\] Plan step 1/);
  assert.match(r.llm.calls[1].prompt, /no real measured result yet this session/);
  assert.equal(r.llm.calls[1].maxTokens, LOOP_THINKING_MAX_TOKENS);
  assert.deepEqual(r.llm.calls[1].reasoning, LOOP_REASONING);
  assert.equal(r.llm.calls[1].model, 'anthropic/claude-opus-5.5');
  assert.equal(r.m.activeLoopStatus().loops[0].thinking, 3);
  // A second, distinct honest activity: a terminal looks at this RAM's own
  // real cloned candidate files on every running-experiment step (there are
  // two in these 9 steps), never the same thing on repeat as the notepad.
  assert.equal(r.activity.inspected.length, 2);
  assert.deepEqual(r.activity.inspected.map((i) => i.index), [0, 1]);
  const inspect = feed.filter((f) => f.type === 'sandbox-inspect');
  assert.equal(inspect.length, 2);
  assert.match(inspect[0].message, /Opened a terminal on desktop .* looked at commit history: real output for commit history/);
  assert.equal(r.m.activeLoopStatus().loops[0].inspects, 2);
});

test('concurrent advance() calls on one slot are serialized: one model call, two distinct steps', async () => {
  const llm = fakeLiveLlm();
  const m = createSlotManager({ llmProvider: llm.provider });
  m.setSlotCount(1);
  const [a, b] = await Promise.all([m.advance('slot-0'), m.advance('slot-0')]);
  assert.equal(a.status, 'thinking');
  assert.equal(b.status, 'running-experiment');
  assert.equal(llm.calls.length, 1);
});

// ---- mock mode never fakes it ----

test('mock mode: the loop never starts, no timer, nothing typed, and the feed says why', async () => {
  const r = rig({ live: false });
  r.m.setSlotCount(1);
  await r.boot();
  assert.equal(r.m.getSlot('slot-0').feed.at(-1).type, 'sandbox-loop-skipped');
  assert.match(r.m.getSlot('slot-0').feed.at(-1).message, /mock \(dry-run\) mode/);
  assert.equal(r.timers.pending.size, 0);
  assert.equal(r.llm.calls.length, 0);
  assert.equal(r.activity.typed.length, 0);
});

test('a thinking call that comes back mocked stops the loop before anything is typed', async () => {
  const r = rig({ llm: { provider: createMockLlmProvider() } });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step();
  const snap = r.m.getSlot('slot-0');
  assert.equal(snap.feed.at(-1).type, 'sandbox-loop-stopped');
  assert.match(snap.feed.at(-2).message, /^\[mock\]/, 'the mock line itself is visibly mock');
  assert.equal(r.activity.typed.length, 0);
  assert.equal(r.timers.pending.size, 0);
});

test('the loop refuses to start while the paid judge gate is open; owned slots are never driven', async () => {
  const r = rig({ pipelineRunner: { judgeAllowed: true, supportsTrack: () => false } });
  r.m.setSlotCount(1);
  await r.boot();
  assert.match(r.m.getSlot('slot-0').feed.at(-1).message, /judge gate is open/);
  assert.equal(r.timers.pending.size, 0);
  const r2 = rig();
  const owned = r2.m.createOwnedSlot({ ramId: 'ram-1', owner: 'W1', track: 'sha256-r31-exploratory', approach: 'x', model: 'm', brief: 'b' });
  await r2.boot(owned.id);
  assert.equal(types(r2.m.getSlot(owned.id)).some((t) => t.startsWith('sandbox-loop')), false);
  assert.equal(r2.timers.pending.size, 0);
});

// ---- literature search ----

test('a SEARCH line opens a real-looking ePrint lookup (rate limited), logged honestly and fed into the next thinking step', async () => {
  const r = rig({ answers: ['Re-read the 31-step trail.\nSEARCH: SHA-256 31 step collision', 'Next idea.\nSEARCH: SHA-256 semi-free-start', 'Third.\nSEARCH: SHA-2 local collision'], activeLoop: { browseEvery: 2 } });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step(); // thinking #1 -> browse
  let snap = r.m.getSlot('slot-0');
  const thinking = snap.feed.filter((f) => f.type === 'thinking').at(-1);
  assert.equal(thinking.message, 'Re-read the 31-step trail.', 'the SEARCH line is not in the feed text');
  assert.deepEqual(r.activity.browsed.map((b) => b.query), ['SHA-256 31 step collision']);
  assert.equal(snap.feed.at(-1).type, 'sandbox-browse');
  assert.match(snap.feed.at(-1).message, /2026\/1120 "Pushing Collision Attacks on SHA-2 to 39 Steps".*Titles only: no paper has been read/);
  for (let i = 0; i < 4; i++) await r.step(); // -> thinking #2: asks again, but within browseEvery
  assert.equal(r.activity.browsed.length, 1);
  assert.match(r.llm.calls[1].prompt, /last literature search, "SHA-256 31 step collision".*2026\/1120/);
  for (let i = 0; i < 4; i++) await r.step(); // -> thinking #3: allowed again
  assert.equal(r.activity.browsed.length, 2);
});

// ---- real competitors' submissions (PEERS) ----

test('a PEERS line opens a real-looking lookup of other competitors\' open PRs (rate limited), logged honestly and fed into the next thinking step', async () => {
  const r = rig({
    answers: ['Re-read the trail.\nPEERS: see what other competitors have submitted', 'Next idea.\nPEERS: check again', 'Third.\nPEERS: check once more'],
    activeLoop: { peersEvery: 2 },
  });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step(); // thinking #1 -> peer lookup
  let snap = r.m.getSlot('slot-0');
  const thinking = snap.feed.filter((f) => f.type === 'thinking').at(-1);
  assert.equal(thinking.message, 'Re-read the trail.', 'the PEERS line is not in the feed text');
  assert.deepEqual(r.activity.peered.map((p) => p.track), ['sha256-r31-exploratory']);
  assert.equal(snap.feed.at(-1).type, 'sandbox-peer-review');
  assert.match(snap.feed.at(-1).message, /PR #302 by @rickmanelius \(claimed score 1\.5\).*never treated as proven or copied/);
  for (let i = 0; i < 4; i++) await r.step(); // -> thinking #2: asks again, but within peersEvery
  assert.equal(r.activity.peered.length, 1);
  assert.match(r.llm.calls[1].prompt, /Other real competitors' open pull requests on sha256-r31-exploratory.*PR #302 by @rickmanelius.*never treat one as proven/);
  for (let i = 0; i < 4; i++) await r.step(); // -> thinking #3: allowed again
  assert.equal(r.activity.peered.length, 2);
});

test('PEERS is honest when the real GitHub lookup finds nothing currently open for this track', async () => {
  const r = rig({ answers: ['Checking.\nPEERS: any competitors ahead on this track?'], activity: fakeActivity({ peerResults: [] }) });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step();
  const snap = r.m.getSlot('slot-0');
  assert.equal(snap.feed.at(-1).type, 'sandbox-peer-review');
  assert.match(snap.feed.at(-1).message, /No open pull requests currently mention sha256-r31-exploratory/);
});

// ---- guardrails ----

test('admin stop ends the loop at once: pending step cleared, nothing more runs', async () => {
  const r = rig();
  r.m.setSlotCount(1);
  await r.boot();
  await r.step();
  const [h] = r.timers.pending.values();
  await r.m.stopSandbox('slot-0');
  assert.equal(h.cleared, true);
  assert.equal(r.timers.pending.size, 0);
  h.fn(); // even if it fired anyway
  await r.m.waitForLoopStep('slot-0');
  assert.equal(r.llm.calls.length, 1);
  assert.equal(r.activity.typed.length, 1);
  assert.equal(r.m.activeLoopStatus().loops.length, 0);
});

test('E2B ending the sandbox stops the loop; a replacement session gets its own fresh loop', async () => {
  const r = rig();
  r.m.setSlotCount(1);
  await r.boot();
  await r.step();
  const [h] = r.timers.pending.values();
  r.sdk.vanish('sbx1');
  r.clock.t += HARD_STOP_MS + 10_000;
  await r.m.reconcileSandboxes();
  assert.equal(h.cleared, true);
  assert.equal(r.timers.pending.size, 0);
  await r.boot(); // what auto-restart does: startSandboxNow on the same slot
  assert.equal(r.m.activeLoopStatus().loops[0].sessionId, 'sbx2');
  await r.step();
  assert.equal(r.activity.typed.at(-1).sbx, 'sbx2');
});

test('a step that was mid-flight when the sandbox stopped does not type or reschedule', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const llm = fakeLiveLlm();
  const slow = { provider: { ...llm.provider, complete: async (req) => { await gate; return llm.provider.complete(req); } } };
  const r = rig({ llm: slow });
  r.m.setSlotCount(1);
  await r.boot();
  r.timers.fire();
  await r.m.stopSandbox('slot-0'); // while the model call is in flight
  release();
  await r.m.waitForLoopStep('slot-0');
  assert.equal(r.activity.typed.length, 0);
  assert.equal(r.timers.pending.size, 0);
});

test('retiring the slot and stopActiveLoops (shutdown) both stop it for good', async () => {
  const r = rig();
  r.m.setSlotCount(2);
  await r.boot('slot-1');
  r.m.setSlotCount(1);
  assert.equal(r.m.activeLoopStatus().loops.length, 0);
  const r2 = rig();
  r2.m.setSlotCount(1);
  await r2.boot();
  r2.m.stopActiveLoops();
  assert.equal(r2.timers.pending.size, 0);
  assert.equal(r2.m.activeLoopStatus().active, false);
});

test('per-session cap on model calls stops the loop with a feed line', async () => {
  const r = rig({ activeLoop: { maxThinkingPerSession: 1 } });
  r.m.setSlotCount(1);
  await r.boot();
  for (let i = 0; i < 4; i++) await r.step(); // thinking, experiment, failed, idle
  await r.step(); // would be thinking #2
  assert.equal(r.llm.calls.length, 1);
  assert.equal(r.m.getSlot('slot-0').feed.at(-1).type, 'sandbox-loop-stopped');
  assert.match(r.m.getSlot('slot-0').feed.at(-1).message, /cap of 1 model calls/);
  assert.equal(r.timers.pending.size, 0);
});

test('failed steps back off (always under the idle ceiling) and stop the loop after maxFailures', async () => {
  const r = rig({ activity: fakeActivity({ failType: 99 }), activeLoop: { maxFailures: 4 } });
  r.m.setSlotCount(1);
  await r.boot();
  const delays = [];
  for (let i = 0; i < 4; i++) delays.push(await r.step());
  assert.deepEqual(delays, [0, 10_000, 20_000, 40_000]);
  assert.ok(delays.every((d) => d < MAX_IDLE_MS));
  assert.equal(r.timers.pending.size, 0);
  const feed = r.m.getSlot('slot-0').feed;
  assert.equal(feed.at(-1).type, 'sandbox-loop-stopped');
  assert.equal(feed.filter((f) => f.type === 'sandbox-loop-error').length, 3);
});

// ---------------------------------------------------------------------------
// Loop-authored drafting: the wiring in slots.js that decides WHETHER a
// dedicated drafting call happens at all, and what it does with the answer.
// The real validateLoopAttempt/writeLoopDraftCandidate/real-pipeline proof
// lives in tests/hashsmash.test.js (real python, real repo); this file
// keeps a FAKE pipelineRunner (same pattern as tests/slots.test.js's
// fakeRunner) so these stay fast and deterministic, and asserts exactly
// when runLoopDraftAttempt fires and what it does with each real outcome.
// ---------------------------------------------------------------------------

const DRAFT_TRACK = 'sha256-r31-exploratory'; // slot-0's real assignment (first in ACTIVE_TRACKS)

function stubPipelineRunner({ track = DRAFT_TRACK, kind = 'harness-draft' } = {}) {
  const calls = [];
  return {
    calls,
    supportsTrack: (t) => t === track,
    candidateKindFor: (t) => (t === track ? kind : 'research'),
    async runCycle(args) {
      calls.push(args);
      return {
        head: 'abc123', workspace: '/ws', workspaceRelative: 'ws', precheck: { ok: true, errors: [] },
        stages: [
          { stage: 'check', outcome: 'ok', exitCode: 0, status: 'mechanically_valid', detail: '' },
          { stage: 'intake', outcome: 'draft-not-submitted', exitCode: 2, status: 'draft_not_submitted', detail: '' },
        ],
        candidate: {
          kind: args.loopDraft ? 'loop-draft' : 'harness-draft', submissionState: 'draft',
          timeLog2: args.loopDraft?.attempt.timeLog2 ?? null, successProbability: args.loopDraft?.attempt.successProbability ?? null,
          heuristics: args.loopDraft ? [args.loopDraft.attempt.heuristicId] : [],
          summary: args.loopDraft ? 'loop-authored draft (stub)' : 'labeled harness draft (stub)',
        },
      };
    },
  };
}

const VALID_DRAFT_ANSWER = [
  'ATTEMPT: yes',
  'TIME_LOG2: 131',
  'MEMORY_LOG2_BYTES: 40',
  'SUCCESS_PROBABILITY: 0.42',
  'HEURISTIC_ID: loop-step-extension-1',
  'CITED_PAPER_ID: 2026/1120', // matches fakeActivity()'s default browse result
  'STATEMENT: Extending the cited paper\'s filtering idea to this candidate\'s fixed table may raise its acceptance rate.',
  'SCOPE: Applies only to the fixed first-block filter this harness draft template uses.',
  'EXTRAPOLATION: This session read the cited result\'s title only and reasoned qualitatively; no new computation ran.',
  'LIMITATIONS: No collision was found or measured this session; this is an unverified estimate from a paper title alone.',
].join('\n');

test('no real search this session: a DRAFT line alone never attempts a draft, and the pipeline runs exactly as before', async () => {
  const runner = stubPipelineRunner();
  const r = rig({ pipelineRunner: runner, answers: ['Trying a tighter filter.\nDRAFT: I might have something.'] });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step(); // idle -> thinking (no SEARCH line: no browse, slot.lastSearch stays null)
  await r.step(); // thinking -> running-experiment
  await r.step(); // running-experiment -> the real pipeline (never the drafting call: no real search yet)
  assert.equal(r.llm.calls.length, 1, 'only the one thinking call; no dedicated drafting call');
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].loopDraft, null);
  assert.equal(r.m.getSlot('slot-0').status, 'validated');
  assert.equal(r.m.getSlot('slot-0').pipeline.candidate, 'harness-draft');
});

test('a dedicated drafting call only ever happens after a real search, and asks LOOP_DRAFT_SYSTEM', async () => {
  const runner = stubPipelineRunner();
  const r = rig({
    pipelineRunner: runner,
    answers: ['Trying a tighter filter.\nSEARCH: sha256 reduced round collision\nDRAFT: I might have something.', VALID_DRAFT_ANSWER],
    activeLoop: { browseEvery: 1 },
  });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step(); // idle -> thinking: asks for a search, and a draft
  await r.step(); // thinking -> running-experiment (a real browse already happened inside step 1)
  assert.ok(r.m.getSlot('slot-0').feed.some((f) => f.type === 'sandbox-browse'), 'the real browse must have actually happened');
  await r.step(); // running-experiment -> the dedicated drafting call fires now, then the verification call
  assert.equal(r.llm.calls.length, 3);
  assert.equal(r.llm.calls[1].system, LOOP_DRAFT_SYSTEM);
  assert.match(r.llm.calls[1].prompt, /you said/i);
  assert.equal(r.llm.calls[2].system, LOOP_VERIFY_SYSTEM);
});

test('peer-review-only grounding (no literature search) is enough to make a drafting attempt eligible, and a real competitor PR can be honestly cited', async () => {
  const runner = stubPipelineRunner();
  const r = rig({
    pipelineRunner: runner,
    answers: [
      'Checking the field.\nPEERS: see how competitors on this track are doing\nDRAFT: I might have something.',
      VALID_DRAFT_ANSWER.replace('CITED_PAPER_ID: 2026/1120', 'CITED_PAPER_ID: PR#302'),
    ],
    activeLoop: { peersEvery: 1 },
  });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step(); // idle -> thinking: asks for a peer lookup, and a draft
  await r.step(); // thinking -> running-experiment (the real peer lookup already happened inside step 1)
  const slotMid = r.m.getSlot('slot-0');
  assert.ok(slotMid.feed.some((f) => f.type === 'sandbox-peer-review'), 'the real peer lookup must have actually happened');
  assert.equal(slotMid.feed.some((f) => f.type === 'sandbox-browse'), false, 'no literature search happened this cycle');
  await r.step(); // running-experiment -> the dedicated drafting call fires (peer review alone is enough grounding), then verification
  assert.equal(r.llm.calls.length, 3);
  assert.equal(r.llm.calls[1].system, LOOP_DRAFT_SYSTEM);
  assert.equal(r.llm.calls[2].system, LOOP_VERIFY_SYSTEM);
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].loopDraft.citedPaper.kind, 'peer-pr');
  assert.equal(runner.calls[0].loopDraft.citedPaper.number, 302);
  const slot = r.m.getSlot('slot-0');
  assert.equal(slot.status, 'validated');
  assert.ok(slot.feed.some((f) => f.type === 'pipeline-loop-draft-attempt' && /competitor PR #302/.test(f.message)));
});

test('a drafted claim citing a competitor PR this session never actually looked at is honestly rejected the same way as a fake ePrint id', async () => {
  const runner = stubPipelineRunner();
  const badAnswer = VALID_DRAFT_ANSWER.replace('CITED_PAPER_ID: 2026/1120', 'CITED_PAPER_ID: PR#999');
  const r = rig({
    pipelineRunner: runner,
    answers: ['Checking the field.\nPEERS: see how things are going\nDRAFT: I might have something.', badAnswer],
    activeLoop: { peersEvery: 1 },
  });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step(); // idle -> thinking + real peer lookup
  await r.step(); // thinking -> running-experiment
  await r.step(); // running-experiment -> drafting call -> rejected
  const slot = r.m.getSlot('slot-0');
  assert.equal(slot.status, 'failed');
  assert.equal(slot.feed.at(-1).type, 'pipeline-loop-draft-rejected');
  assert.match(slot.feed.at(-1).message, /does not match any real result/);
  assert.equal(runner.calls.length, 0, 'the real pipeline must never run on a rejected attempt');
});

test('a drafted claim citing a paper this session never actually looked up is honestly rejected before the real pipeline ever runs', async () => {
  const runner = stubPipelineRunner();
  const badAnswer = VALID_DRAFT_ANSWER.replace('CITED_PAPER_ID: 2026/1120', 'CITED_PAPER_ID: 2099/9999');
  const r = rig({
    pipelineRunner: runner,
    answers: ['Trying a tighter filter.\nSEARCH: sha256 reduced round collision\nDRAFT: I might have something.', badAnswer],
    activeLoop: { browseEvery: 1 },
  });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step(); // idle -> thinking + real browse
  await r.step(); // thinking -> running-experiment
  await r.step(); // running-experiment -> drafting call -> rejected
  const slot = r.m.getSlot('slot-0');
  assert.equal(slot.status, 'failed');
  assert.equal(slot.feed.at(-1).type, 'pipeline-loop-draft-rejected');
  assert.match(slot.feed.at(-1).message, /does not match any real result/);
  assert.equal(runner.calls.length, 0, 'the real pipeline must never run on a rejected attempt');
});

test('a genuinely valid drafted claim reaches the real pipeline, forced to stay a draft, and is reported honestly', async () => {
  const runner = stubPipelineRunner();
  const r = rig({
    pipelineRunner: runner,
    answers: ['Trying a tighter filter.\nSEARCH: sha256 reduced round collision\nDRAFT: I might have something.', VALID_DRAFT_ANSWER],
    activeLoop: { browseEvery: 1 },
  });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step(); // idle -> thinking + real browse
  await r.step(); // thinking -> running-experiment
  await r.step(); // running-experiment -> drafting call -> valid -> real pipeline
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].loopDraft.attempt.heuristicId, 'loop-step-extension-1');
  assert.equal(runner.calls[0].loopDraft.citedPaper.id, '2026/1120');
  const slot = r.m.getSlot('slot-0');
  assert.equal(slot.status, 'validated');
  assert.equal(slot.pipeline.candidate, 'loop-draft');
  assert.ok(slot.feed.some((f) => f.type === 'pipeline-loop-draft-attempt'));
  assert.match(slot.feed.at(-1).message, /stays a draft/);
});

test('a drafted claim that genuinely passes adversarial verification reaches submission_state "ready" -- the real, intended path to a live submission', async () => {
  const runner = stubPipelineRunner();
  const r = rig({
    pipelineRunner: runner,
    answers: [
      'Trying a tighter filter.\nSEARCH: sha256 reduced round collision\nDRAFT: I might have something.',
      VALID_DRAFT_ANSWER,
      'VERDICT: PASS\nREASON: The extrapolation genuinely follows from the cited paper and the scope matches this exact target.',
    ],
    activeLoop: { browseEvery: 1 },
  });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step(); // idle -> thinking + real browse
  await r.step(); // thinking -> running-experiment
  await r.step(); // running-experiment -> drafting call -> valid -> verification call -> PASS -> real pipeline
  assert.equal(r.llm.calls.length, 3, 'thinking, drafting, verification');
  assert.equal(r.llm.calls[2].system, LOOP_VERIFY_SYSTEM);
  assert.match(r.llm.calls[2].prompt, /STATEMENT:/);
  assert.match(r.llm.calls[2].prompt, /IACR ePrint 2026\/1120/);
  const draft = runner.calls[0].loopDraft;
  assert.equal(draft.verification.pass, true);
  assert.match(draft.verification.reason, /extrapolation genuinely follows/);
  const slot = r.m.getSlot('slot-0');
  assert.ok(slot.feed.some((f) => f.type === 'pipeline-loop-verify-passed' && /could not find a real issue/.test(f.message)));
});

test('a drafted claim that fails adversarial verification stays a draft, same as before this mechanism existed', async () => {
  const runner = stubPipelineRunner();
  const r = rig({
    pipelineRunner: runner,
    answers: [
      'Trying a tighter filter.\nSEARCH: sha256 reduced round collision\nDRAFT: I might have something.',
      VALID_DRAFT_ANSWER,
      'VERDICT: FAIL\nREASON: The extrapolation claims more than the cited title alone could support.',
    ],
    activeLoop: { browseEvery: 1 },
  });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step();
  await r.step();
  await r.step();
  const draft = runner.calls[0].loopDraft;
  assert.equal(draft.verification.pass, false);
  assert.match(draft.verification.reason, /claims more than the cited title/);
  const slot = r.m.getSlot('slot-0');
  assert.ok(slot.feed.some((f) => f.type === 'pipeline-loop-verify-failed' && /found a real problem/.test(f.message)));
});

test('a mocked (dry-run) verification response is treated as a fail, never a real pass', async () => {
  const runner = stubPipelineRunner();
  const calls = [];
  const provider = {
    kind: 'openrouter',
    async complete(req) {
      calls.push(req);
      if (req.system === LOOP_VERIFY_SYSTEM) return { text: 'VERDICT: PASS\nREASON: looks fine', mocked: true, model: req.model, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: null } };
      if (req.system === LOOP_DRAFT_SYSTEM) return { text: VALID_DRAFT_ANSWER, mocked: false, model: req.model, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.001 } };
      return { text: 'Trying a tighter filter.\nSEARCH: sha256 reduced round collision\nDRAFT: I might have something.', mocked: false, model: req.model, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.001 } };
    },
  };
  const r = rig({ pipelineRunner: runner, llm: { calls, provider }, activeLoop: { browseEvery: 1 } });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step();
  await r.step();
  await r.step();
  const draft = runner.calls[0].loopDraft;
  assert.equal(draft.verification.pass, false, 'a mocked PASS is still never a real pass');
  assert.match(draft.verification.reason, /mock \(dry-run\) answer/);
});

test('mocked answers are never treated as a real drafting decision; the loop keeps running on the normal pipeline instead', async () => {
  const runner = stubPipelineRunner();
  // fakeLiveLlm reports mocked:false for every answer by default; simulate a
  // provider that, just for the drafting call, comes back mocked (dry-run).
  const calls = [];
  const provider = {
    kind: 'openrouter',
    async complete(req) {
      calls.push(req);
      if (req.system === LOOP_DRAFT_SYSTEM) return { text: VALID_DRAFT_ANSWER, mocked: true, model: req.model, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: null } };
      return { text: 'Trying a tighter filter.\nSEARCH: sha256 reduced round collision\nDRAFT: I might have something.', mocked: false, model: req.model, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.001 } };
    },
  };
  const r = rig({ pipelineRunner: runner, llm: { calls, provider }, activeLoop: { browseEvery: 1 } });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step();
  await r.step();
  await r.step();
  assert.equal(r.m.getSlot('slot-0').feed.some((f) => f.type === 'pipeline-loop-draft-skipped'), true);
  assert.equal(runner.calls.length, 1, 'the real pipeline still ran, on the normal harness draft');
  assert.equal(runner.calls[0].loopDraft, null);
  assert.equal(r.m.getSlot('slot-0').status, 'validated');
});

test('drafting attempts are bounded: after maxDraftAttemptsPerSession, further DRAFT requests fall back to the normal pipeline', async () => {
  const runner = stubPipelineRunner();
  const answers = [
    'Try A.\nSEARCH: sha256 reduced round collision\nDRAFT: first real reason.', VALID_DRAFT_ANSWER, // cycle 1: draft attempt #1 (allowed)
    'Try B.\nDRAFT: second real reason.', // cycle 2: no SEARCH needed, lastSearch already real from cycle 1
  ];
  const r = rig({ pipelineRunner: runner, answers, activeLoop: { browseEvery: 1, maxDraftAttemptsPerSession: 1, maxThinkingPerSession: 10 } });
  r.m.setSlotCount(1);
  await r.boot();
  // Cycle 1: idle -> thinking -> running-experiment (drafting call #1, valid) -> validated -> idle.
  for (let i = 0; i < 5; i++) await r.step();
  assert.equal(runner.calls.length, 1);
  assert.ok(runner.calls[0].loopDraft, 'cycle 1 drafted for real');
  // Cycle 2: idle -> thinking (asks again) -> running-experiment: the cap (1) is already spent, so no second drafting call.
  await r.step(); // idle -> thinking
  await r.step(); // thinking -> running-experiment
  await r.step(); // running-experiment -> straight to the normal pipeline, no drafting call
  assert.equal(r.llm.calls.length, 4, 'thinking, drafting #1, verification #1 (the draft passed), thinking #2 — no drafting #2');
  assert.equal(runner.calls.length, 2);
  assert.equal(runner.calls[1].loopDraft, null, 'the cap held: cycle 2 got the ordinary harness draft');
});

// ---------------------------------------------------------------------------
// The real research tools (2026-10-07): READ (full ePrint paper page),
// EXPERIMENT and VERIFY (research-tools.js, real computation). The loop tests
// below use the REAL experiment engine (realResearchTools), not a fake: every
// number asserted in a feed line is recomputed independently here.
// ---------------------------------------------------------------------------

test('parseThinking extracts EXPERIMENT, VERIFY and READ lines independently; READ only ever yields a bare ePrint id', () => {
  const t = parseThinking('Plan.\nSEARCH: sha256 trail\nEXPERIMENT: differential at=0 xor=80 samples=1024\n**VERIFY:** EXP#2\nREAD: https://eprint.iacr.org/2026/1080');
  assert.equal(t.note, 'Plan.');
  assert.equal(t.search, 'sha256 trail');
  assert.equal(t.experiment, 'differential at=0 xor=80 samples=1024');
  assert.equal(t.verify, 'EXP#2');
  assert.equal(t.read, '2026/1080');
  for (const ok of ['2026/1080', 'ePrint 2026/1080', 'https://eprint.iacr.org/2026/1080', 'https://eprint.iacr.org/2026/1080.pdf', '2026/0042']) {
    assert.match(eprintIdFrom(ok), /^2026\/(1080|42)$/, ok);
  }
  for (const bad of ['https://evil.example/2026/1080', 'https://eprint.iacr.org/2026/1080?x=1', 'file:///etc/passwd', '2026/1080; rm -rf /', '../2026/1080', '1066/1', 'arxiv 2401.12345']) {
    assert.equal(eprintIdFrom(bad), null, bad);
    assert.equal(parseThinking(`x\nREAD: ${bad}`).read, null, bad);
  }
  assert.throws(() => eprintPaperUrl('https://evil.example/x'), /not an IACR ePrint paper id/);
  assert.equal(eprintPaperUrl('2026/1080'), 'https://eprint.iacr.org/2026/1080');
  assert.equal(paperPageCommand('2026/1080'), "curl -sS -m 20 -A 'ramherd-research-loop' 'https://eprint.iacr.org/2026/1080' | head -c 262144");
});

test('parseEprintPaperPage on a REAL recorded ePrint page returns far more than the title-only search did: authors, full abstract, keywords, metadata', () => {
  const paper = parseEprintPaperPage(EPRINT_1080_HTML, '2026/1080');
  assert.equal(paper.found, true);
  assert.equal(paper.title, 'Pushing the Limit of Memory-efficient Collision Attack Framework for SHA-2');
  assert.deepEqual(paper.authors, ['Yingxin Li', 'Fukang Liu', 'Gaoli Wang', 'Jiali Shi']);
  assert.match(paper.abstract, /^The SHA-2 family hash is standardized by NIST/);
  assert.match(paper.abstract, /the first practical collision attacks on 35-step SHA-256 and SHA-512 can be achieved/);
  assert.ok(paper.abstract.length > 10 * paper.title.length, 'abstract-level text, not just a title');
  assert.deepEqual(paper.keywords, ['Hash functions', 'SHA-2', 'Collision attack', 'Message difference']);
  assert.equal(paper.category, 'Attacks and cryptanalysis');
  assert.equal(paper.publicationInfo, 'A minor revision of an IACR publication in CRYPTO 2026');
  assert.equal(paper.pdfUrl, 'https://eprint.iacr.org/2026/1080.pdf');
  assert.equal(paper.bodyRead, false, 'the PDF body is never claimed as read');
  // The archive's real 404 page (no such paper) is "not found", never a guessed paper.
  assert.deepEqual(parseEprintPaperPage(EPRINT_404_HTML, '2026/99999'), { found: false, id: '2026/99999', url: 'https://eprint.iacr.org/2026/99999' });
  assert.deepEqual(parseEprintPaperPage('', '2026/1'), { found: false, id: '2026/1', url: 'https://eprint.iacr.org/2026/1' });
});

test('readPaper types the fixed-domain paper URL into Chrome, fetches the same page with curl, and parses the real page', async () => {
  const cmds = [];
  const sbx = {
    commands: {
      run: async (cmd) => {
        cmds.push(cmd);
        if (cmd.startsWith('xdotool getwindowname')) return { stdout: 'Chrome\n' };
        if (cmd.startsWith('curl')) return { stdout: EPRINT_1080_HTML };
        return { stdout: '' };
      },
    },
  };
  const r = await readPaper(sbx, { id: 'ePrint 2026/1080', windowId: '77' });
  assert.equal(r.url, 'https://eprint.iacr.org/2026/1080');
  assert.equal(r.windowId, '77');
  assert.equal(r.paper.authors.length, 4);
  assert.ok(cmds.some((c) => c.includes("xdotool type --delay 25 -- 'https://eprint.iacr.org/2026/1080'")), 'the URL is typed live where a viewer sees it');
  assert.ok(cmds.some((c) => c.startsWith("curl -sS -m 20 -A 'ramherd-research-loop' 'https://eprint.iacr.org/2026/1080'")));
  await assert.rejects(readPaper(sbx, { id: 'https://evil.example/2026/1080' }), /not an IACR ePrint paper id/);
  assert.equal(typeof desktopActivity.readPaper, 'function', 'wired into the real desktop activity');
});

test('a READ line reads the real paper page, logs title/authors/abstract honestly, and the next thinking step is grounded in the abstract', async () => {
  const r = rig({ answers: ['Look at the 35-step result.\nREAD: 2026/1080', 'Next.'], activeLoop: { readEvery: 1 } });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step(); // idle -> thinking -> READ
  const snap = r.m.getSlot('slot-0');
  assert.deepEqual(r.activity.reads.map((x) => x.id), ['2026/1080']);
  const line = snap.feed.at(-1);
  assert.equal(line.type, 'sandbox-read');
  assert.match(line.message, /Read ePrint 2026\/1080 "Pushing the Limit of Memory-efficient Collision Attack Framework for SHA-2" by Yingxin Li, Fukang Liu, Gaoli Wang, Jiali Shi/);
  assert.match(line.message, /Abstract \(as fetched from the paper's own page\): "The SHA-2 family hash/);
  assert.match(line.message, /the PDF body was not read/);
  for (let i = 0; i < 4; i++) await r.step(); // -> next thinking step
  assert.match(r.llm.calls[1].prompt, /Papers you actually read this session.*2026\/1080.*abstract: The SHA-2 family hash/);
});

test('a READ of a paper id the archive does not have is reported as not found, and nothing is recorded as read', async () => {
  const r = rig({ answers: ['Check this.\nREAD: 2026/99999'] });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step();
  const line = r.m.getSlot('slot-0').feed.at(-1);
  assert.equal(line.type, 'sandbox-read');
  assert.match(line.message, /has no paper there, so nothing was read/);
});

test('an EXPERIMENT line runs a REAL bounded experiment whose reported numbers equal an independent recomputation', async () => {
  const r = rig({ researchTools: realResearchTools, answers: ['Test output bias.\nEXPERIMENT: differential at=60 xor=80 samples=512 seed=loop', 'Next.'] });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step(); // idle -> thinking -> experiment (real worker)
  const snap = r.m.getSlot('slot-0');
  const line = snap.feed.at(-1);
  assert.equal(line.type, 'research-experiment');
  const independent = runExperiment(parseExperimentRequest('differential at=60 xor=80 samples=512 seed=loop', 'sha256-r31-exploratory').request);
  assert.match(line.message, /^Ran a real bounded experiment EXP#1 on sha256-r31-exploratory/);
  assert.ok(line.message.includes(`mean output-difference weight ${independent.meanOutputDiffWeight.toFixed(2)} of 256`), line.message);
  assert.ok(line.message.includes(`minimum ${independent.minOutputDiffWeight}`));
  assert.match(line.message, /\[512 of 512 requested samples actually run/);
  assert.match(line.message, /not a collision|out of scope for an ordinary-collision claim/);
  assert.match(line.message, /not recomputed by the organizer's checker \(the organizer's reference checker is not available on this host/, 'no pipeline runner here: said plainly, not pretended');
  for (let i = 0; i < 4; i++) await r.step(); // -> next thinking step
  assert.match(r.llm.calls[1].prompt, /Your own real experiments this session.*EXP#1: a real bounded differential experiment on sha256-r31-exploratory.*512 message pairs/);
});

test('a malformed or unsupported EXPERIMENT request is reported as not run; nothing is computed or invented', async () => {
  const calls = [];
  const tools = { runExperiment: async (q) => { calls.push(q); return realResearchTools.runExperiment(q); }, verifyPair: realResearchTools.verifyPair };
  const r = rig({ researchTools: tools, answers: ['Find a full collision.\nEXPERIMENT: birthday bits=256 samples=2^60'] });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step();
  const line = r.m.getSlot('slot-0').feed.at(-1);
  assert.equal(line.type, 'research-experiment-rejected');
  assert.match(line.message, /bits must be 8\.\.44.*Nothing was computed/);
  assert.equal(calls.length, 0);
});

test('VERIFY EXP#<n> recomputes the experiment\'s recorded pair for real: correctly NOT a collision, with the real equal-prefix length', async () => {
  const organizerCalls = [];
  const runner = {
    supportsTrack: () => false,
    candidateKindFor: () => 'harness-draft',
    // Stands in for hashsmash.js organizerDigests: recomputes with the real port (the real Python path is tested in hashsmash.test.js).
    organizerDigests: async ({ track, messagesHex }) => { organizerCalls.push(messagesHex); return { ok: true, checker: 'verifier/hash_functions.py:digest', digests: messagesHex.map((m) => Buffer.from(digestForTrack(track, Buffer.from(m, 'hex'))).toString('hex')) }; },
  };
  const r = rig({ pipelineRunner: runner, researchTools: realResearchTools, answers: ['Prefix test.\nEXPERIMENT: birthday bits=20 samples=4000 seed=v', 'Check it.\nVERIFY: EXP#1'] });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step(); // thinking #1 -> experiment EXP#1
  const exp = r.m.getSlot('slot-0').feed.at(-1);
  assert.equal(exp.type, 'research-experiment');
  assert.match(exp.message, /The organizer's own reference Python recomputed the closest pair and agreed/);
  for (let i = 0; i < 4; i++) await r.step(); // -> thinking #2 -> VERIFY EXP#1
  const v = r.m.getSlot('slot-0').feed.at(-1);
  assert.equal(v.type, 'research-verify');
  const independent = runExperiment(parseExperimentRequest('birthday bits=20 samples=4000 seed=v', 'sha256-r31-exploratory').request).bestPair;
  assert.match(v.message, new RegExp(`Verified a candidate pair as EXP#2 .*the closest pair from EXP#1.*NOT a collision: the digests differ \\(equal on the first ${independent.equalPrefixBits} bits, Hamming distance ${independent.hammingDistance} of 256\\)`));
  assert.deepEqual(organizerCalls.at(-1), [independent.messageAHex, independent.messageBHex], 'the exact recorded pair went to the organizer checker');
});

test('if the organizer\'s own checker disagrees with the port, the result is DISCARDED: no number reported, nothing citable', async () => {
  const runner = { supportsTrack: () => false, candidateKindFor: () => 'harness-draft', organizerDigests: async ({ messagesHex }) => ({ ok: true, digests: messagesHex.map(() => '00'.repeat(32)) }) };
  const r = rig({ pipelineRunner: runner, researchTools: realResearchTools, answers: ['x.\nEXPERIMENT: birthday bits=16 samples=2000'] });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step();
  const line = r.m.getSlot('slot-0').feed.at(-1);
  assert.equal(line.type, 'research-experiment-error');
  assert.match(line.message, /EXP#1 was DISCARDED.*Neither number is reported/);
});

test('experiments are capped per session and rate limited; a mocked thinking answer never triggers any tool', async () => {
  const calls = [];
  const tools = { runExperiment: async (q) => { calls.push(q); return realResearchTools.runExperiment(q); }, verifyPair: realResearchTools.verifyPair };
  const ask = 'Again.\nEXPERIMENT: differential at=1 xor=01 samples=64';
  const r = rig({ researchTools: tools, answers: [ask, ask, ask], activeLoop: { maxExperimentsPerSession: 2, maxThinkingPerSession: 10 } });
  r.m.setSlotCount(1);
  await r.boot();
  for (let i = 0; i < 9; i++) await r.step(); // three thinking steps
  assert.equal(calls.length, 2);
  assert.ok(r.m.getSlot('slot-0').feed.some((f) => f.type === 'research-experiment-skipped' && /cap of 2 experiments/.test(f.message)));
  assert.equal(r.m.activeLoopStatus().loops[0].experiments, 2);

  const mockedCalls = [];
  const mockTools = { runExperiment: async (q) => { mockedCalls.push(q); return { status: 'completed' }; }, verifyPair: () => { throw new Error('must not run'); } };
  const mocked = { calls: [], provider: { kind: 'openrouter', async complete(q) { mocked.calls.push(q); return { text: 'x\nEXPERIMENT: differential at=1 xor=01\nVERIFY: 00 01\nREAD: 2026/1080', mocked: true, model: q.model }; } } };
  const r2 = rig({ llm: mocked, researchTools: mockTools });
  r2.m.setSlotCount(1);
  await r2.boot();
  await r2.step();
  assert.equal(mockedCalls.length, 0);
  assert.equal(r2.activity.reads.length, 0);
});

test('end to end: a draft citing the RAM\'s own real experiment EXP#1 passes the unchanged honesty gate, and the verifier is shown the real recorded numbers', async () => {
  const runner = stubPipelineRunner();
  runner.organizerDigests = async ({ track, messagesHex }) => ({ ok: true, digests: messagesHex.map((m) => Buffer.from(digestForTrack(track, Buffer.from(m, 'hex'))).toString('hex')) });
  const answer = VALID_DRAFT_ANSWER.replace('CITED_PAPER_ID: 2026/1120', 'CITED_PAPER_ID: EXP#1');
  const r = rig({
    pipelineRunner: runner, researchTools: realResearchTools,
    answers: ['Measure first.\nEXPERIMENT: birthday bits=20 samples=3000 seed=e2e\nDRAFT: the measurement supports a disclosed estimate', answer, 'VERDICT: FAIL\nREASON: A 20-bit prefix count says nothing about a 256-bit collision cost.'],
  });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step(); // thinking + real experiment EXP#1 (the only grounding: no search, no peers)
  await r.step(); // -> running-experiment
  await r.step(); // -> drafting call, validation, verification call, pipeline
  assert.equal(r.llm.calls.length, 3);
  assert.equal(r.llm.calls[2].system, LOOP_VERIFY_SYSTEM);
  assert.match(r.llm.calls[2].prompt, /citing the agent's own experiment EXP#1/);
  assert.match(r.llm.calls[2].prompt, /CITED EXPERIMENT \(real recorded result\): EXP#1: a real bounded birthday experiment on sha256-r31-exploratory .* 3000 samples actually hashed/);
  const draft = runner.calls[0].loopDraft;
  assert.equal(draft.citedPaper.kind, 'experiment');
  assert.equal(draft.citedPaper.result.samplesRun, 3000);
  assert.equal(draft.verification.pass, false);
  assert.ok(r.m.getSlot('slot-0').feed.some((f) => f.type === 'pipeline-loop-draft-attempt' && /citing this session's own experiment EXP#1/.test(f.message)));
});

test('a draft citing an experiment this session never ran is rejected before the pipeline, exactly like a fake paper id', async () => {
  const runner = stubPipelineRunner();
  const r = rig({
    pipelineRunner: runner, researchTools: realResearchTools,
    answers: ['Measure.\nEXPERIMENT: birthday bits=20 samples=1000\nDRAFT: I have a measured estimate', VALID_DRAFT_ANSWER.replace('CITED_PAPER_ID: 2026/1120', 'CITED_PAPER_ID: EXP#7')],
  });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step(); await r.step(); await r.step();
  const slot = r.m.getSlot('slot-0');
  assert.equal(slot.status, 'failed');
  assert.equal(slot.feed.at(-1).type, 'pipeline-loop-draft-rejected');
  assert.match(slot.feed.at(-1).message, /CITED_PAPER_ID "EXP#7" does not match any real result/);
  assert.equal(runner.calls.length, 0);
});

// ---- 2026-10-07 live stall: reasoning models spending the whole output budget before answering ----
//
// A fake provider that behaves the way OpenRouter's reasoning models were
// measured to behave on the real live prompt: hidden reasoning counts against
// max_tokens, and a call that runs out while still reasoning comes back with
// finish_reason "length" and EMPTY content. Reasoning needs (tokens) are the
// real measured figures: deepseek-v4-pro ignores reasoning.effort (about 950
// on a first step, about 3000 once an experiment result is in the grounding);
// qwen3.8-max-prime honors it (2700 / 7200 at default effort, 400 / 950 at low).

const PROFILES = {
  'deepseek-like': (req) => (/Your own real experiments this session/.test(req.prompt) ? 2978 : 951),
  'qwen-like': (req) => {
    const post = /Your own real experiments this session/.test(req.prompt);
    return req.reasoning?.effort === 'low' ? (post ? 936 : 371) : (post ? 7220 : 2731);
  },
};

function fakeReasoningLlm(profile, answers = []) {
  const calls = [];
  const need = PROFILES[profile];
  return {
    calls,
    provider: {
      kind: 'openrouter',
      async complete(req) {
        calls.push(req);
        const maxTokens = req.maxTokens ?? 300;
        const reasoning = need(req);
        const usage = { promptTokens: 1280, completionTokens: Math.min(maxTokens, reasoning + 150), totalTokens: 0, costUsd: 0.001 };
        if (reasoning >= maxTokens) {
          return { text: '', mocked: false, model: req.model, usage, finishReason: 'length', reasoningTokens: maxTokens };
        }
        const text = answers.length ? answers.shift() : 'EXP#1 looked like a random function; I have no result to beat yet.\nEXPERIMENT: birthday bits=8 samples=256 seed=again';
        return { text, mocked: false, model: req.model, usage, finishReason: 'stop', reasoningTokens: reasoning };
      },
    },
  };
}

const FIRST_STEP = 'No measured result yet; test output bias on the exact target first.\nEXPERIMENT: differential at=60 xor=80 samples=512 seed=loop';

for (const profile of Object.keys(PROFILES)) {
  test(`regression (live stall, ${profile} model): the old 800-token thinking budget really did return empty once an experiment was in the grounding`, async () => {
    // Reproduce the exact live trigger: run the loop for one real experiment,
    // then replay its real post-experiment thinking request under the OLD config.
    const llm = fakeReasoningLlm(profile, [FIRST_STEP]);
    const r = rig({ llm, researchTools: realResearchTools });
    r.m.setSlotCount(1);
    await r.boot();
    for (let i = 0; i < 5; i++) await r.step(); // thinking + EXP#1, ..., the next thinking step
    const postExperiment = llm.calls.find((c) => /Your own real experiments this session/.test(c.prompt));
    assert.ok(postExperiment, 'the next thinking prompt carries the real experiment result');
    const old = await llm.provider.complete({ ...postExperiment, maxTokens: 800, reasoning: undefined });
    assert.equal(old.text, '', 'the stall reproduces under the old budget');
    assert.equal(old.finishReason, 'length');
  });

  test(`regression (live stall, ${profile} model): with the fixed budget the loop keeps thinking and keeps using its tools, cycle after cycle`, async () => {
    const llm = fakeReasoningLlm(profile, [FIRST_STEP]);
    const r = rig({ llm, researchTools: realResearchTools });
    r.m.setSlotCount(1);
    await r.boot();
    for (let i = 0; i < 16; i++) await r.step(); // four full research cycles
    const feed = r.m.getSlot('slot-0').feed;
    const thinking = feed.filter((f) => f.type === 'thinking');
    assert.equal(thinking.length, 4);
    assert.equal(thinking.filter((f) => /returned no text|output budget/.test(f.message)).length, 0, 'no empty thinking step at all');
    assert.equal(feed.filter((f) => f.type === 'research-experiment').length, 4, 'every step\'s EXPERIMENT line was actually run');
    for (const c of llm.calls) {
      assert.equal(c.maxTokens, LOOP_THINKING_MAX_TOKENS);
      assert.deepEqual(c.reasoning, LOOP_REASONING);
    }
    assert.equal(r.m.activeLoopStatus().loops[0].emptyThinking, 0);
  });
}

test('the loop budgets leave real headroom over the largest reasoning need measured live, for all three loop calls', () => {
  const worst = 2978; // deepseek-v4-pro, post-experiment prompt, effort ignored
  for (const budget of [LOOP_THINKING_MAX_TOKENS, LOOP_DRAFT_MAX_TOKENS, LOOP_VERIFY_MAX_TOKENS]) {
    assert.ok(budget >= worst * 1.5, `budget ${budget} must leave headroom over ${worst} reasoning tokens plus the answer`);
  }
  assert.deepEqual(LOOP_REASONING, { effort: 'low' });
});

test('a thinking reply that is still empty says plainly WHY (budget used reasoning), is counted, and runs nothing', async () => {
  const llm = { calls: [], provider: { kind: 'openrouter', async complete(req) { llm.calls.push(req); return { text: '', mocked: false, model: req.model, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0 }, finishReason: 'length', reasoningTokens: req.maxTokens }; } } };
  const r = rig({ llm, researchTools: realResearchTools });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step();
  const thinking = r.m.getSlot('slot-0').feed.filter((f) => f.type === 'thinking');
  assert.equal(thinking.length, 1);
  assert.equal(thinking[0].message, emptyReplyNote({ finishReason: 'length', reasoningTokens: LOOP_THINKING_MAX_TOKENS }, LOOP_THINKING_MAX_TOKENS));
  assert.match(thinking[0].message, /used its whole 6000-token output budget \(6000 of them on hidden reasoning\) before writing any answer/);
  assert.equal(r.m.activeLoopStatus().loops[0].emptyThinking, 1);
  assert.equal(r.m.getSlot('slot-0').feed.some((f) => f.type.startsWith('research-')), false);
  // Without a reported reason, the old neutral wording stays.
  assert.equal(emptyReplyNote({ finishReason: 'stop' }, 6000), '(the model returned no text for this step)');
});

test('parseThinking on a cut-off reply never acts on the incomplete last line, but keeps the prose that was written', () => {
  // A complete signal line before the cut still counts; the half-written one after it never does.
  const cut = parseThinking('I will check the paper and run a probe.\nSEARCH: keccak five round collision\nREAD: 2026/10', { truncated: true });
  assert.equal(cut.search, 'keccak five round collision');
  assert.equal(cut.read, null, 'a cut-off READ id (2026/10 of 2026/1080) must not fetch a different paper');
  assert.equal(cut.note, 'I will check the paper and run a probe.');
  assert.equal(parseThinking('Next I will test.\nEXPERIMENT: birthday bits=1', { truncated: true }).experiment, null);
  // Prose cut off mid-sentence stays in the note.
  assert.equal(parseThinking('EXP#1 looked random, so next I will', { truncated: true }).note, 'EXP#1 looked random, so next I will');
  // Not truncated: unchanged behaviour, the last line is a real signal.
  assert.equal(parseThinking('Read it.\nREAD: 2026/1080').read, '2026/1080');
});

test('a cut-off thinking reply is labeled as cut off in the feed and its cut-off tool line is not run', async () => {
  const llm = { calls: [], provider: { kind: 'openrouter', async complete(req) { llm.calls.push(req); return { text: 'Probing bias next.\nEXPERIMENT: differential at=60 xor=8', mocked: false, model: req.model, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0 }, finishReason: 'length' }; } } };
  const r = rig({ llm, researchTools: realResearchTools });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step();
  const feed = r.m.getSlot('slot-0').feed;
  const thinking = feed.find((f) => f.type === 'thinking');
  assert.match(thinking.message, /^Probing bias next\. \[this answer was cut off at the 6000-token limit; a tool line cut off with it was not run\]$/);
  assert.equal(feed.some((f) => f.type.startsWith('research-')), false);
});

test('a drafting call cut off at the token limit is reported as incomplete, never as an honest "no" and never as a draft', async () => {
  const runner = stubPipelineRunner();
  const answers = ['Trying a tighter filter.\nSEARCH: sha256 reduced round collision\nDRAFT: I might have something.'];
  const llm = { calls: [], provider: { kind: 'openrouter', async complete(req) {
    llm.calls.push(req);
    if (req.system === LOOP_DRAFT_SYSTEM) return { text: VALID_DRAFT_ANSWER.split('\n').slice(0, -1).join('\n') + '\nLIMITATIONS: No coll', mocked: false, model: req.model, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0 }, finishReason: 'length' };
    return { text: answers.shift() ?? 'Next.', mocked: false, model: req.model, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0 }, finishReason: 'stop' };
  } } };
  const r = rig({ pipelineRunner: runner, llm, activeLoop: { browseEvery: 1 } });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step(); await r.step(); await r.step();
  const draftCall = llm.calls.find((c) => c.system === LOOP_DRAFT_SYSTEM);
  assert.equal(draftCall.maxTokens, LOOP_DRAFT_MAX_TOKENS);
  assert.deepEqual(draftCall.reasoning, LOOP_REASONING);
  const feed = r.m.getSlot('slot-0').feed;
  assert.ok(feed.some((f) => f.type === 'pipeline-loop-draft-skipped' && /cut off at the 6000-token limit/.test(f.message)));
  assert.equal(feed.some((f) => f.type === 'pipeline-loop-draft-declined'), false);
  assert.equal(feed.some((f) => f.type === 'pipeline-loop-draft-attempt'), false);
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].loopDraft, null, 'the ordinary labeled harness draft ran, not a cut-off claim');
});

test('an adversarial verdict cut off at the token limit is never a pass, even if it starts "VERDICT: PASS"', async () => {
  const runner = stubPipelineRunner();
  const answers = ['Trying a tighter filter.\nSEARCH: sha256 reduced round collision\nDRAFT: I might have something.', VALID_DRAFT_ANSWER];
  const llm = { calls: [], provider: { kind: 'openrouter', async complete(req) {
    llm.calls.push(req);
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0 };
    if (req.system === LOOP_VERIFY_SYSTEM) return { text: 'VERDICT: PASS\nREASON: The extrapolation', mocked: false, model: req.model, usage, finishReason: 'length' };
    return { text: answers.shift() ?? 'Next.', mocked: false, model: req.model, usage, finishReason: 'stop' };
  } } };
  const r = rig({ pipelineRunner: runner, llm, activeLoop: { browseEvery: 1 } });
  r.m.setSlotCount(1);
  await r.boot();
  await r.step(); await r.step(); await r.step();
  const verifyCall = llm.calls.find((c) => c.system === LOOP_VERIFY_SYSTEM);
  assert.equal(verifyCall.maxTokens, LOOP_VERIFY_MAX_TOKENS);
  assert.deepEqual(verifyCall.reasoning, LOOP_REASONING);
  const draft = runner.calls[0].loopDraft;
  assert.equal(draft.verification.pass, false);
  assert.match(draft.verification.reason, /cut off at the 6000-token limit; an incomplete review is never treated as a pass/);
});
