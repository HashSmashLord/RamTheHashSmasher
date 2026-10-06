// The REAL external HashSmash/Yukon submission CLI (`yukon`), wrapped as a
// gated action. This is the ONLY real external submission mechanism this
// project has found evidence of (see docs/research or ask HQ for the source):
// it is a separate CLI, not a GitHub PR against Layr-Labs/hash-smash. Its
// documented workflow, for both humans and AI agents:
//
//   curl -fsSL https://api.yukon.org/yukon/install.sh | sh
//   yukon login YOUR_API_KEY
//   yukon clone <track-benchmark-id>      # creates a repo, prints a cd instruction
//   # cd into it, read its TASK.md
//   yukon setup --track <track>
//   yukon run --track <track>
//   # ...do the research, edit only the track's allowed candidate files...
//   yukon submit --track <track> --model "YOUR_MODEL" --harness "YOUR_HARNESS" --note-file submission-note.md
//
// `--model` and `--harness` on `yukon submit` are the real attribution
// mechanism: the RAM's real OpenRouter model id and an honest name for this
// harness, not a PR title or commit author. Yukon itself then runs an
// automated AI screen; a submission that passes enters manual human review,
// and only joins published results if a reviewer promotes it. Nothing here
// changes that: this module only ever builds and (when explicitly allowed)
// runs the `submit` call.
//
// What this module is NOT: it does not replace server/lib/hashsmash.js's own
// real local pipeline (clone of the vendored repo, `check`, `intake`), which
// stays exactly as it was. This is additive, a separate, still-local-by-
// default path toward the one real external step this repo has never taken.
//
// Hard gate, same two-step pattern as `RAMHERD_SANDBOX_ACTIVE_LOOP`:
//   - `RAMHERD_YUKON_SUBMIT=true` (exactly that string) turns the gate on.
//   - A real `YUKON_API_KEY` must ALSO be present, or `submit()` refuses.
//   - Both together are still not the operator's go-ahead to actually run
//     it against a real candidate; that call is this module's caller's to
//     make, same as every other live/paid/public action in this codebase.
// Neither this module nor anything that imports it ever sets either of
// those two things, logs a real key, or calls `submit()` on its own; nothing
// in this repo's tests or default config ever makes a real network call
// here (`run` is injectable — see tests/yukon-submit.test.js, which fakes
// the CLI the same way tests/sandbox.test.js fakes the E2B SDK).
//
// Per-track benchmark id: the one example seen (blake3-r1-exploratory ->
// 86d5040e-d37d-4f41-bab6-1f2cd57e7398) is NOT assumed to cover the other
// five tracks. `clone()`/`setup()`/`run_()` below take `benchmarkId` as a
// required argument from the caller; this module does not guess or catalog
// ids for tracks it has not been told.

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const TRACK_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-(?:exploratory|rigorous)$/;

function assertTrack(track) {
  if (typeof track !== 'string' || !TRACK_RE.test(track)) throw new RangeError(`invalid track id: ${JSON.stringify(track)}`);
}

function assertNonEmpty(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

/**
 * Reads the env once. `enabled` is the operator's own opt-in; `hasKey` is
 * whether a real key is even present. `allowed` (both together) is still
 * only a gate, never the go-ahead to call `submit()` — that is the caller's
 * own decision each time, the same as the paid-judge gate in hashsmash.js.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function yukonSubmitPolicy(env = process.env) {
  const enabled = env.RAMHERD_YUKON_SUBMIT === 'true';
  const hasKey = typeof env.YUKON_API_KEY === 'string' && env.YUKON_API_KEY.trim().length > 0;
  return Object.freeze({ enabled, hasKey, allowed: enabled && hasKey });
}

/** The exact argv for each documented step. Pure and testable; never run on their own. */
export const yukonArgs = Object.freeze({
  login: (apiKey) => ['login', assertNonEmpty(apiKey, 'apiKey')],
  clone: (benchmarkId) => ['clone', assertNonEmpty(benchmarkId, 'benchmarkId')],
  setup: (track) => { assertTrack(track); return ['setup', '--track', track]; },
  run: (track) => { assertTrack(track); return ['run', '--track', track]; },
  submit: ({ track, model, harness, noteFile }) => {
    assertTrack(track);
    return ['submit', '--track', track, '--model', assertNonEmpty(model, 'model'), '--harness', assertNonEmpty(harness, 'harness'), '--note-file', assertNonEmpty(noteFile, 'noteFile')];
  },
});

/** A shell-ready preview string for logs/operators. Never executed from this. */
export function formatYukonCommand(args) {
  return ['yukon', ...args].map((a) => (/[^A-Za-z0-9._\-/]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(' ');
}

/**
 * Honest submission-note content, built only from what a real candidate
 * cycle and its attribution record (hashsmash.js's `writeAttribution`)
 * actually say. Never invents a result, a score, or a verdict nobody gave it.
 *
 * @param {{ track: string, candidate: { kind?: string, submissionState?: string, timeLog2?: number|null, successProbability?: number|null, summary?: string }|null, attribution: { slotId?: string, model?: string, approach?: string }|null }} p
 */
export function buildSubmissionNote({ track, candidate, attribution }) {
  assertTrack(track);
  const slot = attribution?.slotId ?? 'unknown';
  const model = attribution?.model ?? 'unknown';
  const approach = attribution?.approach ?? 'unknown';
  const lines = [
    `# HashRammers submission note — ${track}`,
    '',
    `Produced by RAM slot \`${slot}\` (model \`${model}\`, approach \`${approach}\`). HashRammers is an AI-agent research harness; this note and the candidate it describes were produced by that RAM, not hand-written.`,
    '',
  ];
  if (candidate?.kind === 'research') {
    lines.push('This is a research package extending an existing committed candidate, not a from-scratch claim.');
    if (candidate.summary) lines.push('', candidate.summary);
  } else if (candidate?.kind === 'loop-draft') {
    lines.push('This is a RAM\'s own loop-authored claim: three numbers and one disclosed heuristic written by its own model from its own research this session, on top of the organizer\'s `draft_claim()` template. It is an unreviewed estimate, not a proof.');
  } else {
    lines.push('This is a harness integration draft: the organizer\'s own unmodified `draft_claim()` template. No attack is claimed.');
  }
  lines.push(
    '',
    `Claimed bound as submitted: time 2^${candidate?.timeLog2 ?? '?'}, success probability ${candidate?.successProbability ?? 'n/a'}, submission_state ${candidate?.submissionState ?? 'unknown'}.`,
    'This claim has not been judged or scored by anyone outside this harness. Passing this harness\'s own local intake is a mechanical check, not a verdict.',
    '',
  );
  return `${lines.join('\n')}\n`;
}

function defaultRun(cmd, args, { cwd, env, timeoutMs = 120_000 } = {}) {
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

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   run?: (cmd: string, args: string[], opts: { cwd?: string, env?: object, timeoutMs?: number }) => Promise<{ exitCode: number|null, stdout: string, stderr: string, timedOut: boolean }>,
 *   cwd?: string,
 * }} [opts]
 */
export function createYukonSubmitter({ env = process.env, run = defaultRun, cwd = process.cwd() } = {}) {
  const policy = yukonSubmitPolicy(env);

  // Only PATH/HOME/locale reach the subprocess by default; the real key is
  // added only for the one call that needs it (login), same discipline as
  // hashsmash.js's judgeEnv().
  function baseEnv() {
    return { PATH: env.PATH || '/usr/bin:/bin', HOME: env.HOME || '', LANG: env.LANG || 'en_US.UTF-8' };
  }

  function refuseUnlessAllowed(step) {
    if (!policy.enabled) {
      throw new Error(`yukon ${step} refused: RAMHERD_YUKON_SUBMIT is not "true". This is a real, public, hard-to-reverse action; it stays off until the operator explicitly turns the gate on.`);
    }
    if (!policy.hasKey) {
      throw new Error(`yukon ${step} refused: RAMHERD_YUKON_SUBMIT=true but no real YUKON_API_KEY is set. Refusing rather than running destructively without one.`);
    }
  }

  /** `yukon login YOUR_API_KEY` — the key is read from env, never logged or echoed. */
  async function login() {
    refuseUnlessAllowed('login');
    return run('yukon', yukonArgs.login(env.YUKON_API_KEY), { cwd, env: baseEnv() });
  }

  /** `yukon clone <benchmarkId>` — caller-supplied id; this module does not guess one. */
  async function clone(benchmarkId) {
    refuseUnlessAllowed('clone');
    return run('yukon', yukonArgs.clone(benchmarkId), { cwd, env: baseEnv() });
  }

  /** `yukon setup --track <track>`, run inside the clone's own directory. */
  async function setup(track, { workspaceDir = cwd } = {}) {
    refuseUnlessAllowed('setup');
    return run('yukon', yukonArgs.setup(track), { cwd: workspaceDir, env: baseEnv() });
  }

  /** `yukon run --track <track>`, run inside the clone's own directory. */
  async function run_(track, { workspaceDir = cwd } = {}) {
    refuseUnlessAllowed('run');
    return run('yukon', yukonArgs.run(track), { cwd: workspaceDir, env: baseEnv() });
  }

  /**
   * Writes the honest note file to disk — a real, local, safe action (no
   * network) that is useful even while `submit` itself stays off. Returns
   * the content it wrote.
   */
  function writeSubmissionNote({ track, candidate, attribution, path }) {
    const content = buildSubmissionNote({ track, candidate, attribution });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return content;
  }

  /**
   * `yukon submit --track <track> --model <model> --harness <harness>
   * --note-file <noteFile>`, run inside the clone's own directory. Refuses
   * unless BOTH `RAMHERD_YUKON_SUBMIT=true` and a real `YUKON_API_KEY` are
   * present; callers must treat even that as only a gate, not a decision.
   *
   * @param {{ track: string, model: string, harness: string, noteFile: string, workspaceDir?: string }} p
   */
  async function submit({ track, model, harness, noteFile, workspaceDir = cwd }) {
    refuseUnlessAllowed('submit');
    return run('yukon', yukonArgs.submit({ track, model, harness, noteFile }), { cwd: workspaceDir, env: baseEnv() });
  }

  return Object.freeze({
    policy,
    login,
    clone,
    setup,
    run: run_,
    writeSubmissionNote,
    submit,
    commandFor: (step, args) => formatYukonCommand(yukonArgs[step](args)),
  });
}
