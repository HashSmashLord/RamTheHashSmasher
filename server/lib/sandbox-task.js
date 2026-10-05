// What a RAM's desktop sandbox visibly does when it starts: its "workbench intro".
//
// sandbox.js gives a slot a live, view-only desktop; on its own that desktop is
// idle. This module opens a real terminal window on it and TYPES a short
// sequence of real commands into it, keystroke by keystroke, so a person
// watching the stream sees the RAM fetch the real HashSmash repo and open its
// own assignment:
//
//   1. git clone --depth 1 https://github.com/Layr-Labs/hash-smash
//   2. the clone's real HEAD commit
//   3. tracks/<track>/TASK.md   (the organizer's task definition for this track)
//   4. cd lanes/exploratory/candidates/<target> (the slot's editablePath); ls
//   5. cat claim.json           (the track's current claim)
//   6. python3 scripts/local_tracks.py check <track>  (the organizer's own
//      mechanical check of that candidate; no credentials, no AI, no network)
//
// How it is driven (all through the sandbox's authenticated command channel,
// sbx.commands.run, the same channel sandbox.js uses for x11vnc; DISPLAY=:0 is
// set on every command by the SDK itself). Checked against the real template
// on 2026-10-05: Ubuntu 22.04, user `user`, git 2.34, python3 3.10,
// xfce4-terminal, xdotool and scrot present (xterm is NOT installed).
//   - A small bash rc file sets a readable prompt, `pipefail`, and a
//     PROMPT_COMMAND that appends the previous command's exit status to
//     /tmp/ramtask/exits. That file is how the host learns that a typed
//     command finished and how it ended, without scraping the screen.
//   - xfce4-terminal is launched maximized with that rc file (in the
//     background, like noVNC), and found with `xdotool search --sync`.
//   - Each command is typed with `xdotool type --delay` into that window after
//     activating it (no --window: XSendEvent'd keys are ignored by many
//     terminals; real XTEST keys to the focused window are not), then Return. The host then waits (inside the sandbox) for one more line in the
//     exits file and pauses a moment so a viewer can read the output.
//   - After the sequence the host independently reads back real state over the
//     command channel (clone HEAD + origin, claim.json, the check's JSON),
//     rather than trusting what it typed.
// No host-side timers: every wait/pause is a `sleep` inside the sandbox, so a
// stopped sandbox simply makes the next command fail.
//
// Nothing secret goes in: no keys, tokens or env values are typed or passed.
// The track and path are validated against a strict pattern before they are
// ever placed into a shell command line.

export const HASHSMASH_REPO_URL = 'https://github.com/Layr-Labs/hash-smash';
export const REPO_DIR = '~/hash-smash';
export const TASK_DIR = '/tmp/ramtask';
export const EXITS_FILE = `${TASK_DIR}/exits`;
export const RC_FILE = `${TASK_DIR}/bashrc`;
export const CHECK_FILE = `${TASK_DIR}/check.json`;

const TRACK_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-exploratory$/;
const EDITABLE_RE = /^lanes\/exploratory\/candidates\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/** POSIX single-quote a string for sh. */
export function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Validates the parts of an assignment that end up in shell command lines.
 * @param {{ track: string, editablePath: string, hashFunction?: string, rounds?: number }} assignment
 */
export function checkAssignment(assignment) {
  const { track, editablePath } = assignment ?? {};
  if (typeof track !== 'string' || !TRACK_RE.test(track)) throw new RangeError(`refusing sandbox task: bad track ${JSON.stringify(track)}`);
  const m = typeof editablePath === 'string' ? EDITABLE_RE.exec(editablePath.replace(/\/+$/, '')) : null;
  if (!m) throw new RangeError(`refusing sandbox task: bad editablePath ${JSON.stringify(editablePath)}`);
  const target = m[1];
  if (track !== `${target}-exploratory`) throw new RangeError(`refusing sandbox task: editablePath ${editablePath} is not track ${track}'s`);
  return { track, editablePath: editablePath.replace(/\/+$/, ''), target };
}

/**
 * The commands typed into the terminal, in order. `required` steps stop the
 * sequence on a non-zero exit; the organizer check's exit is a verdict, not a
 * failure of the task.
 */
export function workbenchSteps(assignment) {
  const { track, editablePath } = checkAssignment(assignment);
  return [
    { id: 'clone', label: 'clone the HashSmash repo', required: true, timeoutSec: 120,
      command: `git clone --depth 1 ${HASHSMASH_REPO_URL} ${REPO_DIR}` },
    { id: 'head', label: 'show the cloned commit', required: true, timeoutSec: 20,
      command: `cd ${REPO_DIR} && git log -1 --format='%h %ci %s'` },
    { id: 'task', label: `show the ${track} task definition`, required: true, timeoutSec: 20,
      command: `cat tracks/${track}/TASK.md` },
    { id: 'cd', label: 'open this RAM\'s candidate directory', required: true, timeoutSec: 20,
      command: `cd ${editablePath} && ls -la . certificates` },
    { id: 'claim', label: 'show the current claim', required: true, timeoutSec: 20,
      command: 'cat claim.json' },
    { id: 'check', label: 'run the organizer\'s mechanical check', required: false, timeoutSec: 60,
      command: `python3 ${REPO_DIR}/scripts/local_tracks.py check ${track} | tee ${CHECK_FILE}` },
  ];
}

/** bash rc for the terminal: prompt, pipefail, and the exit-status log. */
export function bashRc() {
  return [
    '[ -f ~/.bashrc ] && . ~/.bashrc',
    'set -o pipefail',
    `PS1='\\[\\e[1;32m\\]ram@hashsmash\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]$ '`,
    `PROMPT_COMMAND='echo $? >> ${EXITS_FILE}'`,
    'clear',
    `echo 'RAM workbench: real HashSmash repo, real commands, typed live.'`,
    '',
  ].join('\n');
}

/** Window title, also used to find the window. Plain chars only (xdotool --name is a regex). */
export function terminalTitle(track) {
  return `RAM workbench - ${track}`;
}

/** Waits (inside the sandbox) until the exits file has `lines` lines, then pauses; prints the last status or TIMEOUT. */
export function waitForExitsCommand(lines, timeoutSec, pauseSec) {
  const tries = Math.max(1, Math.round(timeoutSec * 4));
  return `for i in $(seq 1 ${tries}); do n=$(wc -l < ${EXITS_FILE} 2>/dev/null || echo 0); `
    + `if [ "$n" -ge ${lines} ]; then sleep ${pauseSec}; tail -n 1 ${EXITS_FILE}; exit 0; fi; sleep 0.25; done; echo TIMEOUT`;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** The claim fields worth surfacing (all from the real claim.json). */
export function summarizeClaim(claim) {
  if (!claim || typeof claim !== 'object') return null;
  const c = claim.claim ?? {};
  return {
    targetProfile: claim.target_profile ?? null,
    attackClass: claim.attack_class ?? null,
    submissionState: claim.submission_state ?? null,
    timeLog2: c.time_log2 ?? null,
    memoryLog2Bytes: c.memory_log2_bytes ?? null,
    successProbability: c.success_probability ?? null,
  };
}

/**
 * Opens a terminal on the sandbox desktop and types the workbench sequence
 * into it. Resolves with what happened; throws only on a driver problem
 * (terminal never appeared, a typed command never finished, sandbox gone).
 *
 * @param {any} sbx - a started @e2b/desktop Sandbox (sandbox.js keeps it private and passes it in)
 * @param {{ track: string, editablePath: string, hashFunction?: string, rounds?: number, approach?: string }} assignment
 * @param {{
 *   onStep?: (step: { id: string, label: string, command: string, exitCode: number }) => void,
 *   isLive?: () => boolean,
 *   typeDelayMs?: number,
 *   pauseSec?: number,
 * }} [opts]
 */
export async function runWorkbenchTask(sbx, assignment, { onStep = () => {}, isLive = () => true, typeDelayMs = 35, pauseSec = 1.5 } = {}) {
  const steps = workbenchSteps(assignment);
  const { track, editablePath } = checkAssignment(assignment);
  const run = (cmd, opts) => sbx.commands.run(cmd, opts);
  const title = terminalTitle(track);
  const alive = () => {
    if (!isLive()) throw new Error('sandbox stopped before the workbench task finished');
  };

  // 1. rc file + terminal window
  await run(`mkdir -p ${TASK_DIR} && rm -f ${EXITS_FILE} ${CHECK_FILE} && cat > ${RC_FILE} <<'RAMTASK_RC'\n${bashRc()}RAMTASK_RC`);
  await run(
    `xfce4-terminal --disable-server --maximize --hide-menubar -T ${shQuote(title)} -x bash --rcfile ${RC_FILE} -i`,
    { background: true, timeoutMs: 0 },
  );
  const found = await run(`timeout 20 xdotool search --sync --onlyvisible --name ${shQuote(`^${title}$`)} 2>/dev/null | head -n 1 || true`, { timeoutMs: 30_000 });
  const windowId = String(found?.stdout ?? '').trim();
  if (!/^\d+$/.test(windowId)) throw new Error('terminal window did not appear on the sandbox desktop');
  // The shell's first prompt writes line 1 of the exits file: the shell is ready.
  const ready = await run(waitForExitsCommand(1, 20, 0.5), { timeoutMs: 40_000 });
  if (String(ready?.stdout ?? '').trim() === 'TIMEOUT') throw new Error('terminal shell did not start');

  // 2. type each command into the terminal
  const done = [];
  for (let i = 0; i < steps.length; i++) {
    alive();
    const step = steps[i];
    await run(`xdotool windowactivate --sync ${windowId} >/dev/null 2>&1 || true`);
    await run(`xdotool type --delay ${typeDelayMs} -- ${shQuote(step.command)} && xdotool key Return`, { timeoutMs: 60_000 });
    const res = await run(waitForExitsCommand(i + 2, step.timeoutSec, pauseSec), { timeoutMs: (step.timeoutSec + pauseSec + 15) * 1000 });
    const out = String(res?.stdout ?? '').trim();
    if (out === 'TIMEOUT' || !/^\d+$/.test(out)) throw new Error(`typed command did not finish in ${step.timeoutSec}s: ${step.command}`);
    const result = { id: step.id, label: step.label, command: step.command, exitCode: Number(out) };
    done.push(result);
    onStep(result);
    if (step.required && result.exitCode !== 0) {
      return { ok: false, windowId, title, steps: done, failedStep: step.id, repo: null, claim: null, check: null };
    }
  }

  // 3. read back real state independently of what was typed
  alive();
  const repoOut = await run(`cd ${REPO_DIR} && git rev-parse HEAD && git remote get-url origin || true`);
  const [head, origin] = String(repoOut?.stdout ?? '').trim().split('\n');
  const claimOut = await run(`cat ${REPO_DIR}/${editablePath}/claim.json 2>/dev/null || true`);
  const checkOut = await run(`cat ${CHECK_FILE} 2>/dev/null || true`);
  const checkJson = parseJson(String(checkOut?.stdout ?? ''));
  const checkRow = Array.isArray(checkJson) ? checkJson.find((r) => r?.track === track) ?? null : null;
  return {
    ok: true,
    windowId,
    title,
    steps: done,
    repo: /^[0-9a-f]{40}$/.test(head ?? '') ? { head, origin: origin ?? null } : null,
    claim: summarizeClaim(parseJson(String(claimOut?.stdout ?? ''))),
    check: checkRow ? { status: checkRow.status ?? null, qualified: checkRow.qualified ?? null } : null,
  };
}
