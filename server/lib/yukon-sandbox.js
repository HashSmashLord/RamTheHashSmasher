// Runs the real Yukon CLI workflow (server/lib/yukon-submit.js's documented
// steps) INSIDE a RAM's E2B desktop sandbox, scoped to exactly one roster
// slot: blake3-r1-exploratory. That track's benchmark id
// (86d5040e-d37d-4f41-bab6-1f2cd57e7398) is the only one this codebase has
// confirmed real (see yukon-submit.js's header); this module does not guess
// one for any other track, and nothing here is ever called for a slot whose
// track is not blake3-r1-exploratory (see `isYukonSandboxTrack`, and
// slots.js's own guard before it ever calls into this file).
//
// Gate: identical to yukon-submit.js — `yukonSubmitPolicy(env)` must say
// `allowed` (both RAMHERD_YUKON_SUBMIT==='true' AND a real YUKON_API_KEY).
// `runYukonSandboxCycle` checks this itself, first, before anything else, and
// returns `{ skipped: true, reason }` without touching the sandbox at all if
// it is not. Nothing in this module, nothing that imports it, and nothing in
// its tests ever sets either half of that gate — see
// tests/yukon-sandbox.test.js, whose single most important test asserts the
// sandbox's real command channel is never called while the gate is off.
//
// Key handling: the real YUKON_API_KEY reaches the sandbox only as a process
// environment variable on the ONE command that needs it (`yukon login`),
// via E2B's own `envs` option on `commands.run` — never interpolated into
// the command string itself (the command text only ever says
// `"$YUKON_API_KEY"`, a shell variable reference, never the literal value).
// Nothing here calls xdotool or opens a visible terminal window, so nothing
// a viewer's stream shows ever includes it either (unlike sandbox-task.js's
// workbench intro, which is deliberately typed on screen because it has
// nothing to hide; this module's login step deliberately is not, because it
// does). Any error message that could carry the real key is scrubbed first,
// the same discipline sandbox.js's own `scrub()` applies to the E2B API key.
//
// What "once per sandbox session" means here: `runYukonSandboxCycle` is
// called exactly once, right after the one-time workbench task finishes (ok
// or not) on a freshly started sandbox — see slots.js's `runSandboxTask`. It
// is not part of the always-on research loop; a fresh sandbox (a restart)
// runs it again from scratch, same as the workbench task. That restart --
// E2B's own hard timeout, or RAMHERD_SANDBOX_AUTORESTART -- is also what
// gives a RAM's real "keep improving, resubmit when it's actually better"
// behavior its cadence: each fresh session re-evaluates this slot's current
// `bestResult` against its own real `lastSubmittedResult` (recorded by
// slots.js only after a real, successful previous `yukon submit`; see
// `decideYukonSubmission`), so a second submission only ever fires on a
// genuine improvement over what was actually sent last time, never a
// resubmit of the same or a worse number, and never on a tight synchronous
// loop against Yukon's own CLI mid-session.
//
// Honesty: `decideYukonSubmission` is the only thing that may ever lead to a
// real `yukon submit` call, and it requires an actual numeric measurement
// (`bestResult`, slots.js's own real-measurement tracker, `updateBestResult`)
// with a genuinely positive success probability — never a guess, a draft, or
// "a pipeline ran". Today there is no real experiment runner for
// blake3-r1-exploratory (it is not in hashsmash.js's PIPELINE_TRACKS), so
// `bestResult` is always null for this slot and this will always, correctly,
// decide not to submit — the exact same honesty pattern slots.js already
// uses for "no real runner for this track in this harness yet".

import { shQuote } from './sandbox-task.js';
import { yukonSubmitPolicy, yukonArgs, buildSubmissionNote } from './yukon-submit.js';

export const YUKON_TRACK = 'blake3-r1-exploratory';
export const YUKON_BENCHMARK_ID = '86d5040e-d37d-4f41-bab6-1f2cd57e7398';
export const YUKON_INSTALL_COMMAND = 'curl -fsSL https://api.yukon.org/yukon/install.sh | sh';
export const YUKON_NOTE_FILE = 'submission-note.md';
export const YUKON_HARNESS = 'HashRammers';

/** True only for the one slot this integration is scoped to. */
export function isYukonSandboxTrack(track) {
  return track === YUKON_TRACK;
}

/** Strips a real key value out of any text before it reaches a feed line or thrown error — same discipline as sandbox.js's scrub(). */
function scrub(text, apiKey) {
  let out = String(text ?? '');
  if (apiKey) out = out.split(apiKey).join('[redacted]');
  return out;
}

/**
 * `yukon clone`'s documented behaviour is "creates a repo, prints a cd
 * instruction, cd into it" — the exact wording is not documented further, so
 * this looks for a plain `cd <path>` line in its real stdout rather than
 * guessing a directory name. Returns null (never a guess) if no such line is
 * found; callers must then stop and say so honestly, not invent a path.
 */
export function parseCloneWorkspace(stdout) {
  const m = /(?:^|\n)\s*cd\s+(\S+)\s*(?:\n|$)/.exec(String(stdout ?? ''));
  return m ? m[1] : null;
}

/** Best-effort PATH covering common install.sh destinations, plus whatever the sandbox env already has. Nothing secret. */
export function baseSandboxEnv(env = process.env) {
  const existing = env.PATH || '/usr/bin:/bin';
  return {
    PATH: `${env.HOME || '/home/user'}/.local/bin:/usr/local/bin:${existing}`,
    HOME: env.HOME || '/home/user',
    LANG: env.LANG || 'en_US.UTF-8',
  };
}

/** Builds the one shell string `sbx.commands.run` needs, same quoting rule as yukon-submit.js's formatYukonCommand. */
function shellJoin(cmd, args) {
  return [cmd, ...args].map((a) => (/[^A-Za-z0-9._\-/]/.test(a) ? shQuote(a) : a)).join(' ');
}

/**
 * Adapts yukon-submit.js's `run(cmd, args, opts)` shape onto a live sandbox's
 * authenticated command channel: `opts.env` becomes E2B's own `envs` on
 * `commands.run` (so a key handed through `opts.env` never has to be in the
 * command text), and the sandbox's real stdout/stderr/exit code are mapped
 * back 1:1. Never touches a window, never types anything, never retried.
 *
 * @param {any} sbx
 * @param {{ apiKey?: string|null }} [opts] - only used to scrub a thrown error message
 */
export function createSandboxRun(sbx, { apiKey = null } = {}) {
  return async function run(cmd, args, opts = {}) {
    const command = shellJoin(cmd, args);
    try {
      const res = await sbx.commands.run(command, {
        envs: opts.env,
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs ?? 120_000,
      });
      return { exitCode: res?.exitCode ?? 0, stdout: scrub(res?.stdout ?? '', apiKey), stderr: scrub(res?.stderr ?? '', apiKey), timedOut: false };
    } catch (err) {
      const message = scrub(err?.message ?? String(err), apiKey);
      return { exitCode: null, stdout: '', stderr: message, timedOut: /timeout/i.test(message), spawnError: err?.name ?? 'error' };
    }
  };
}

/**
 * `yukon login` inside the sandbox. The real key reaches the sandboxed
 * process only via its environment (`YUKON_API_KEY`); the command text
 * itself only ever contains the shell variable reference, never the value.
 */
async function sandboxLogin(run, apiKey, baseEnv) {
  return run('bash', ['-lc', 'yukon login "$YUKON_API_KEY"'], { env: { ...baseEnv, YUKON_API_KEY: apiKey } });
}

/**
 * Honest, conservative decision on whether there is ever something genuine
 * to submit. Requires a real numeric measurement with a genuinely positive
 * success probability — never a guess, a draft, or "a pipeline ran". See the
 * header for why this is always `false` today for this track.
 *
 * `lastSubmitted`, when given, is this same slot's own real previous
 * submission (whatever `runYukonSandboxSubmit` actually sent, last time it
 * actually sent something — never invented, never "what it probably would
 * have been"). With it set, a second submission only ever fires when the new
 * `bestResult` is a GENUINE improvement: strictly lower time_log2 (HashSmash's
 * own score — lower cost to break it is the better, harder result), same
 * honesty bar as the first submission (positive success probability). An
 * equal or worse number is not resubmitted — there is nothing new to tell a
 * real judge, and resubmitting a non-improvement would just be noise in
 * their real review queue.
 *
 * @param {{
 *   bestResult?: { timeLog2: number|null, successProbability: number|null }|null,
 *   lastSubmitted?: { timeLog2: number, successProbability: number }|null,
 * }} p
 */
export function decideYukonSubmission({ bestResult = null, lastSubmitted = null } = {}) {
  if (!bestResult || typeof bestResult.timeLog2 !== 'number' || typeof bestResult.successProbability !== 'number') {
    return { shouldSubmit: false, reason: 'no real measured result exists yet for this target this session (no experiment has produced numeric time/success figures) — nothing genuine to submit' };
  }
  if (!(bestResult.successProbability > 0)) {
    return { shouldSubmit: false, reason: `the best real measurement so far has success probability ${bestResult.successProbability} — not a genuine positive result, nothing worth submitting` };
  }
  if (lastSubmitted && typeof lastSubmitted.timeLog2 === 'number' && !(bestResult.timeLog2 < lastSubmitted.timeLog2)) {
    return {
      shouldSubmit: false,
      reason: `already submitted time 2^${lastSubmitted.timeLog2} for this target; the current best (2^${bestResult.timeLog2}) is not a genuine improvement over that, so there is nothing new to submit`,
    };
  }
  return {
    shouldSubmit: true,
    reason: lastSubmitted
      ? `a real improvement over the last submission exists (time 2^${bestResult.timeLog2}, beating the submitted 2^${lastSubmitted.timeLog2}; success probability ${bestResult.successProbability}) — honest to report again`
      : `a real measured result exists (time 2^${bestResult.timeLog2}, success probability ${bestResult.successProbability}) — honest to report`,
  };
}

/** One readable line per real step, capped so one step can never flood the feed. */
export function yukonStepMessage(step) {
  const body = (step.stdout || step.stderr || '').trim().replace(/\s+/g, ' ').slice(0, 300);
  return `yukon ${step.id}: exit ${step.exitCode ?? 'n/a'}${body ? ` — ${body}` : ''}`;
}

/**
 * The full one-time sequence: install, login, clone, setup, run, then an
 * honest submit decision (and, only if that decision is yes, a real
 * `yukon submit`). Never throws — every failure comes back as `{ ok: false,
 * failedStep, reason }` so the caller can report it plainly. Returns
 * `{ skipped: true, reason }` at once, touching nothing, if the track is
 * wrong or the gate is off.
 *
 * @param {any} sbx
 * @param {{
 *   assignment: { track: string, model: string },
 *   bestResult?: { timeLog2: number|null, successProbability: number|null }|null,
 *   lastSubmitted?: { timeLog2: number, successProbability: number }|null,
 *   attribution?: { slotId?: string, model?: string, approach?: string, candidateKind?: string }|null,
 *   env?: NodeJS.ProcessEnv,
 * }} p
 */
export async function runYukonSandboxCycle(sbx, { assignment, bestResult = null, lastSubmitted = null, attribution = null, env = process.env } = {}) {
  if (!isYukonSandboxTrack(assignment?.track)) {
    return { skipped: true, reason: `yukon integration is scoped to ${YUKON_TRACK} only`, steps: [] };
  }
  const policy = yukonSubmitPolicy(env);
  if (!policy.allowed) {
    return {
      skipped: true,
      reason: !policy.enabled
        ? 'RAMHERD_YUKON_SUBMIT is not "true"'
        : 'RAMHERD_YUKON_SUBMIT=true but no real YUKON_API_KEY is set',
      steps: [],
    };
  }

  const run = createSandboxRun(sbx, { apiKey: env.YUKON_API_KEY });
  const baseEnv = baseSandboxEnv(env);
  const steps = [];
  const record = (id, res) => { const s = { id, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr }; steps.push(s); return s; };

  const install = record('install', await run('bash', ['-lc', YUKON_INSTALL_COMMAND], { env: baseEnv, timeoutMs: 180_000 }));
  if (install.exitCode !== 0) return { skipped: false, ok: false, failedStep: 'install', reason: 'the install script exited non-zero', steps, workspaceDir: null };

  const login = record('login', await sandboxLogin(run, env.YUKON_API_KEY, baseEnv));
  if (login.exitCode !== 0) return { skipped: false, ok: false, failedStep: 'login', reason: 'yukon login exited non-zero', steps, workspaceDir: null };

  const clone = record('clone', await run('yukon', yukonArgs.clone(YUKON_BENCHMARK_ID), { env: baseEnv, timeoutMs: 120_000 }));
  if (clone.exitCode !== 0) return { skipped: false, ok: false, failedStep: 'clone', reason: 'yukon clone exited non-zero', steps, workspaceDir: null };
  const workspaceDir = parseCloneWorkspace(clone.stdout);
  if (!workspaceDir) {
    return { skipped: false, ok: false, failedStep: 'clone', reason: 'could not find a "cd <dir>" instruction in yukon clone\'s real output', steps, workspaceDir: null };
  }

  const setup = record('setup', await run('yukon', yukonArgs.setup(YUKON_TRACK), { env: baseEnv, cwd: workspaceDir, timeoutMs: 180_000 }));
  if (setup.exitCode !== 0) return { skipped: false, ok: false, failedStep: 'setup', reason: 'yukon setup exited non-zero', steps, workspaceDir };

  const runStep = record('run', await run('yukon', yukonArgs.run(YUKON_TRACK), { env: baseEnv, cwd: workspaceDir, timeoutMs: 300_000 }));
  if (runStep.exitCode !== 0) return { skipped: false, ok: false, failedStep: 'run', reason: 'yukon run exited non-zero', steps, workspaceDir };

  const decision = decideYukonSubmission({ bestResult, lastSubmitted });
  if (!decision.shouldSubmit) {
    return { skipped: false, ok: true, steps, workspaceDir, submitted: false, decision };
  }

  const submitResult = await runYukonSandboxSubmit(sbx, { assignment, workspaceDir, bestResult, attribution, env });
  // bestResult travels back up only on a real, successful `yukon submit` exit, so the caller
  // (slots.js) can record it as this slot's new lastSubmittedResult -- never recorded on a
  // failed submit, so a resubmit attempt after a real failure is not mistaken for "no change".
  return { skipped: false, ok: true, steps, workspaceDir, submitted: true, decision, submitResult, submittedResult: submitResult.ok ? bestResult : null };
}

/**
 * The real `yukon submit`, run only by `runYukonSandboxCycle` after
 * `decideYukonSubmission` said yes. Writes the honest note file (built from
 * real data only, `buildSubmissionNote`) inside the sandbox first.
 * `--model`/`--harness` come from this RAM's own real assignment unless a
 * real attribution record says otherwise.
 */
export async function runYukonSandboxSubmit(sbx, { assignment, workspaceDir, bestResult, attribution = null, env = process.env }) {
  const run = createSandboxRun(sbx, { apiKey: env.YUKON_API_KEY });
  const baseEnv = baseSandboxEnv(env);
  const model = attribution?.model || assignment.model;
  const harness = attribution?.slotId ? `${YUKON_HARNESS} RAM ${attribution.slotId}` : YUKON_HARNESS;
  const noteContent = buildSubmissionNote({
    track: YUKON_TRACK,
    candidate: {
      kind: attribution?.candidateKind ?? 'research',
      timeLog2: bestResult.timeLog2,
      successProbability: bestResult.successProbability,
      submissionState: 'ready',
    },
    attribution,
  });
  await sbx.files.write(`${workspaceDir}/${YUKON_NOTE_FILE}`, noteContent);
  const res = await run('yukon', yukonArgs.submit({ track: YUKON_TRACK, model, harness, noteFile: YUKON_NOTE_FILE }), { env: baseEnv, cwd: workspaceDir, timeoutMs: 120_000 });
  return { ok: res.exitCode === 0, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, model, harness, noteContent };
}
